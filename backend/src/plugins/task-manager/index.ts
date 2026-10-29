import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { hostname, homedir, userInfo } from 'node:os'
import { join, posix, resolve as resolvePath } from 'node:path'
import ssh2, { type Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { parseTaskManagerActionResult, parseTaskManagerDetails, parseTaskManagerHello, parseTaskManagerSnapshot, parseTaskManagerTarget, type TaskManagerActionPlan, type TaskManagerActionResult, type TaskManagerHello, type TaskManagerSnapshot, type TaskManagerState, type TaskManagerTarget } from '@webnav/shared'
import { parseTaskManagerRecordingConfig, parseTaskManagerRecordingStatus, parseTaskManagerHistoryQuery, parseTaskManagerHistoryPage, parseTaskManagerHistoryPoint, type TaskManagerRecordingConfig, type TaskManagerRecordingStatus, type TaskManagerHistoryQuery, type TaskManagerHistoryPage, type TaskManagerHistoryPoint } from '@webnav/shared'
import { AppError, integer, record, string } from '../../core/errors.ts'
import { parseTaskManagerCommandLine } from '@webnav/shared'
import { RemoteFs } from '../ssh-files/remote-fs.ts'
import { collectorPackage, defaultPackageDirectory, packageName, type CollectorPackage } from './packages.ts'
import { CollectorPeer } from './protocol.ts'
import { detectPlatform, execChannel, installedRemote, installDirectory, launchCommand, remoteHome, uploadCollector } from './remote.ts'
import { installedLocal, installLocal, localDirectory } from './local.ts'
import type { TaskManagerConfig, TaskManagerHost } from './contract.ts'

type Plan = { value: TaskManagerActionPlan; bootId: string; result?: Promise<TaskManagerActionResult> }
type RecordingOperation = { hash: string; result: Promise<TaskManagerRecordingStatus>; settled: boolean; expires: number }
const recordingErrors: Record<string, string> = {
  RECORDING_INTERRUPTED: '目标记录程序已经停止；历史仍保留，可重新开启记录。',
  RECORDING_CAPTURE_FAILED: '目标暂时无法完成采样，历史中可能出现间断。',
  RECORDING_STORAGE_FAILED: '目标无法保存历史，请检查目录权限和磁盘空间。',
  RECORDING_START_FAILED: '目标记录程序未能启动，请核对后重新开启记录。',
  HISTORY_CORRUPT: '部分历史记录无法通过校验，相关时间段可能缺失；其他记录仍可继续读取。',
}
function recordingStatusResult(value: unknown) {
  const status = parseTaskManagerRecordingStatus(value)
  if (status.lastError) status.lastError = recordingErrors[status.lastError] ?? '目标持续记录发生错误，请核对目标运行状态。'
  return status
}
type Monitor = {
  owner: string; state: TaskManagerState; controller: AbortController; updated: number
  task?: Promise<void>; release?: Promise<void>; package?: CollectorPackage; peer?: CollectorPeer; hello?: TaskManagerHello
  client?: Client; channel?: ClientChannel; fs?: RemoteFs; child?: ChildProcessWithoutNullStreams; keyDecision?: (accepted: boolean) => void | Promise<void>
  heartbeat?: ReturnType<typeof setInterval>; snapshot?: TaskManagerSnapshot; snapshotAt?: number; snapshotTask?: Promise<TaskManagerSnapshot>; plans: Map<string, Plan>; reservationReleased?: boolean
  recordingOperations: Map<string, RecordingOperation>
}
export class TaskManagerEngine {
  private monitors = new Map<string, Monitor>()
  private installs = new Set<string>()
  private options: TaskManagerConfig
  private stopping = false
  private host: TaskManagerHost
  private unwatch: () => void
  private timer: ReturnType<typeof setInterval>
  constructor(host: TaskManagerHost, config: TaskManagerConfig) {
    this.host = host; this.options = config
    this.unwatch = host.onLock(() => { for (const monitor of this.monitors.values()) void this.stopMonitor(monitor) })
    const timer = setInterval(() => {
      for (const [id, monitor] of this.monitors) {
        void host.authorize(monitor.owner).catch(() => this.stopMonitor(monitor))
        if (this.fullyReleased(monitor) && Date.now() - monitor.updated > 600_000) this.monitors.delete(id)
      }
    }, 15_000)
    timer.unref(); this.timer = timer
  }
  async dispose() {
    this.stopping = true; this.unwatch(); clearInterval(this.timer)
    const closed = await Promise.allSettled([...this.monitors.values()].map(monitor => this.stopMonitor(monitor)))
    const tasks = await Promise.allSettled([...this.monitors.values()].map(monitor => monitor.task))
    if ([...closed, ...tasks].some(result => result.status === 'rejected') || [...this.monitors.values()].some(monitor => !this.fullyReleased(monitor))) throw new AppError('PLUGIN_CLEANUP', '采集器或 SSH 尚未完整释放，不能确认收尾成功。')
    this.monitors.clear()
  }
  get size() { return [...this.monitors.values()].filter(monitor => !monitor.controller.signal.aborted).length }
  get sizeRemote() { return [...this.monitors.values()].filter(monitor => monitor.state.target.kind === 'ssh' && (!monitor.controller.signal.aborted || !!monitor.client)).length }
  hasResources() { return [...this.monitors.values()].some(monitor => !monitor.controller.signal.aborted || !!monitor.child || !!monitor.client || !!monitor.task) }
  private fullyReleased(monitor: Monitor) { return monitor.controller.signal.aborted && !monitor.child && !monitor.client && !monitor.channel && !monitor.fs && !monitor.peer && !monitor.task }
  private async owned(owner: string, id: string, ready = false) {
    await this.host.authorize(owner)
    const monitor = this.monitors.get(string(id, 100))
    if (!monitor || monitor.owner !== owner) throw new AppError('NOT_FOUND', '监控目标不存在。')
    if (ready && (monitor.state.phase !== 'ready' || monitor.controller.signal.aborted || !monitor.peer?.active)) throw new AppError('NOT_READY', '采集器尚未连接。')
    monitor.updated = Date.now(); return monitor
  }
  private async live(monitor: Monitor) { monitor.controller.signal.throwIfAborted(); await this.host.authorize(monitor.owner); monitor.controller.signal.throwIfAborted() }
  private publish(monitor: Monitor, phase: TaskManagerState['phase'], message: string, progress?: string) {
    if (monitor.controller.signal.aborted) return
    Object.assign(monitor.state, { phase, message, progress }); monitor.updated = Date.now()
  }
  private work(monitor: Monitor, run: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('TIMEOUT', '采集器准备超时；请核对目标后重新连接。')), 180_000) })
    const running = Promise.resolve().then(run)
    const task = Promise.race([running, deadline]).catch(error => this.failed(monitor, error)).finally(() => clearTimeout(timer)).then(async () => { await running.catch(() => {}) }).finally(async () => { if (monitor.task === task) monitor.task = undefined; await this.releaseReservation(monitor) })
    monitor.task = task
  }
  private async failed(monitor: Monitor, error: unknown) {
    if (!monitor.controller.signal.aborted) { this.publish(monitor, 'error', error instanceof AppError ? error.message : '采集器准备失败，请检查目标目录、系统支持和访问权限。'); monitor.controller.abort(); await this.release(monitor); await this.releaseReservation(monitor) }
  }
  async start(owner: string, input: TaskManagerTarget): Promise<TaskManagerState> {
    await this.host.authorize(owner)
    await this.host.available()
    if (this.stopping) throw new AppError('BUSY', '任务管理器正在停止。')
    const target = parseTaskManagerTarget(input)
    if (this.size >= 8) throw new AppError('BUSY', '同时监控最多 8 个目标。')
    if (this.monitors.size >= 128) { for (const [id, monitor] of this.monitors) if (this.fullyReleased(monitor)) this.monitors.delete(id); if (this.monitors.size >= 128) throw new AppError('BUSY', '监控任务较多，请稍后重试。') }
    const { id, label } = await this.host.reserve(owner, target)
    if (this.stopping) { await this.host.release(id); throw new AppError('BUSY', '任务管理器正在停止。') }
    const monitor: Monitor = { owner, state: { id, target, label, phase: 'connecting', message: '正在检查监控目标…' }, controller: new AbortController(), updated: Date.now(), plans: new Map(), recordingOperations: new Map() }
    this.monitors.set(monitor.state.id, monitor)
    this.work(monitor, () => this.prepare(monitor)); return structuredClone(monitor.state)
  }
  async status(owner: string, id: string) { return structuredClone((await this.owned(owner, id)).state) }
  async install(owner: string, id: string): Promise<TaskManagerState> {
    const monitor = await this.owned(owner, id)
    await this.host.available()
    if (monitor.state.phase !== 'not-installed' || !monitor.package || monitor.controller.signal.aborted) throw new AppError('CONFLICT', '此目标当前不需要安装，请刷新状态。')
    const key = JSON.stringify([monitor.state.target.kind, monitor.state.platform?.hostname, monitor.state.platform?.username, monitor.state.installPath])
    if (this.installs.has(key)) throw new AppError('BUSY', '此目标正在安装采集器。')
    this.installs.add(key); this.publish(monitor, 'installing', '正在安装到当前用户目录…', '准备安装包…')
    this.work(monitor, async () => {
      try {
        const pkg = await collectorPackage(this.options.packageDirectory ?? defaultPackageDirectory, monitor.package!.platform, monitor.package!.arch); await this.live(monitor)
        if (monitor.state.target.kind === 'local') {
          const directory = await localDirectory(monitor.state.platform!.home, pkg, true); await this.live(monitor)
          await installLocal(directory!, pkg, monitor.controller.signal)
        } else {
          const directory = await installDirectory(monitor.fs!, monitor.state.platform!.home, pkg, true); await this.live(monitor)
          await uploadCollector(monitor.fs!, directory!, pkg, monitor.controller.signal, progress => this.publish(monitor, 'installing', '正在安装到 SSH 用户目录…', progress))
        }
        await this.live(monitor); await this.launch(monitor)
      } finally { this.installs.delete(key) }
    })
    return structuredClone(monitor.state)
  }
  async hostKeyDecision(owner: string, id: string, accept: boolean) {
    const monitor = await this.owned(owner, id)
    if (typeof accept !== 'boolean' || monitor.state.phase !== 'host-key' || !monitor.keyDecision || monitor.controller.signal.aborted) throw new AppError('CONFLICT', '主机指纹确认已过期。')
    const decide = monitor.keyDecision; monitor.keyDecision = undefined; delete monitor.state.hostKey
    if (accept) this.publish(monitor, 'connecting', '指纹已确认，正在连接…')
    await decide(accept)
    if (!accept) void this.stopMonitor(monitor)
    return structuredClone(monitor.state)
  }
  private async prepare(monitor: Monitor) {
    if (monitor.state.target.kind === 'local') {
      if (!['win32', 'linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new AppError('PLATFORM_UNSUPPORTED', '当前本机平台不在采集器支持范围内。')
      monitor.state.platform = { os: process.platform as 'win32' | 'linux' | 'darwin', arch: process.arch as 'x64' | 'arm64', home: this.options.homeDirectory ?? homedir(), hostname: hostname(), username: userInfo().username }
    } else {
      await this.connect(monitor); await this.live(monitor)
      const platform = await detectPlatform(monitor.client!, monitor.controller.signal); await this.live(monitor)
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        let expired = false
        const timer = setTimeout(() => { expired = true; reject(new AppError('TIMEOUT', 'SFTP 连接超时。')) }, 10_000)
        monitor.client!.sftp((error, channel) => { clearTimeout(timer); if (expired || monitor.controller.signal.aborted) { channel?.end(); reject(new AppError('CANCELLED', '监控已关闭。')); return }; if (error) reject(new AppError('SFTP_FAILED', '目标未提供可用的 SFTP 文件传输。')); else resolve(channel) })
      })
      sftp.on('error', () => {}); monitor.fs = new RemoteFs(sftp)
      platform.home = remoteHome(await monitor.fs.realpath(platform.home), platform.os === 'win32'); await this.live(monitor); monitor.state.platform = platform
    }
    const platform = monitor.state.platform!, pkg = await collectorPackage(this.options.packageDirectory ?? defaultPackageDirectory, platform.os, platform.arch); await this.live(monitor)
    monitor.package = pkg; monitor.state.collectorVersion = pkg.version
    monitor.state.installPath = monitor.state.target.kind === 'local' ? join(platform.home, '.webnav', 'tools', 'task-manager', pkg.version, `${pkg.platform}-${pkg.arch}`) : posix.join(platform.home, '.webnav', 'tools', 'task-manager', pkg.version, `${pkg.platform}-${pkg.arch}`)
    const directory = monitor.state.target.kind === 'local' ? await localDirectory(platform.home, pkg, false) : await installDirectory(monitor.fs!, platform.home, pkg, false)
    const installed = !!directory && (monitor.state.target.kind === 'local' ? await installedLocal(directory, pkg) : await installedRemote(monitor.fs!, directory, pkg, monitor.controller.signal))
    await this.live(monitor)
    if (installed) await this.launch(monitor)
    else this.publish(monitor, 'not-installed', '尚未安装兼容采集器。点击“安装并连接”自动准备、校验并启动。')
  }
  private async connect(monitor: Monitor) {
    const target = monitor.state.target
    if (target.kind !== 'ssh') return
    const resolved = await this.host.connection(monitor.owner, monitor.state.id)
    const credentials = { password: resolved.password, passphrase: resolved.passphrase, privateKey: resolved.privateKey ? Buffer.from(resolved.privateKey, 'base64') : undefined }
    resolved.privateKey = undefined
    let client: Client
    const { host, port, username } = resolved
    try {
      await this.live(monitor); client = new ssh2.Client(); monitor.client = client
      await new Promise<void>((resolve, reject) => {
        let done = false
        const finish = (error?: Error) => { if (done) return; done = true; monitor.controller.signal.removeEventListener('abort', abort); error ? reject(error) : resolve() }
        const abort = () => { monitor.keyDecision?.(false); monitor.keyDecision = undefined; client.destroy(); finish(new AppError('CANCELLED', '监控已关闭。')) }
        monitor.controller.signal.addEventListener('abort', abort, { once: true })
        client.once('ready', () => finish())
        client.on('error', () => { const error = new AppError('SSH_CONNECT_FAILED', 'SSH 连接失败，请检查目标地址、认证与主机指纹。'); finish(error); if (done && monitor.state.phase === 'ready') void this.failed(monitor, error) })
        client.once('close', () => { if (monitor.client === client) monitor.client = undefined; finish(new AppError('SSH_CLOSED', 'SSH 连接已关闭。')); if (!monitor.controller.signal.aborted) void this.failed(monitor, new AppError('SSH_CLOSED', 'SSH 连接已关闭。')); else void this.releaseReservation(monitor) })
        client.connect({ host, port, username, ...credentials, readyTimeout: 120_000, keepaliveInterval: 15_000, keepaliveCountMax: 3, hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
          void this.verifyHost(monitor, key, host, port, verify).catch(() => verify(false))
        } })
      })
    } finally { if (Buffer.isBuffer(credentials.privateKey)) credentials.privateKey.fill(0) }
  }
  private async verifyHost(monitor: Monitor, key: Buffer, host: string, port: number, verify: (accepted: boolean) => void) {
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    const saved = await this.host.fingerprint(monitor.owner, monitor.state.id)
    await this.live(monitor)
    if (saved === fingerprint) { verify(true); return }
    monitor.state.hostKey = { fingerprint, previous: saved, changed: !!saved, host, port }
    this.publish(monitor, 'host-key', saved ? 'SSH 主机指纹已变化，请核验后确认。' : '请确认首次连接的 SSH 主机指纹。')
    let decided = false
    monitor.keyDecision = async accepted => {
      if (decided) return
      decided = true
      if (!accepted || monitor.controller.signal.aborted) { verify(false); return }
      try { await this.host.fingerprint(monitor.owner, monitor.state.id, { fingerprint, previous: saved }); await this.live(monitor); verify(true) }
      catch (error) { verify(false); throw error }
    }
  }
  private async launch(monitor: Monitor) {
    await this.live(monitor); this.publish(monitor, 'starting', '正在启动已校验的采集器…')
    const binary = monitor.state.target.kind === 'local' ? join(monitor.state.installPath!, packageName(monitor.package!.platform)) : posix.join(monitor.state.installPath!, packageName(monitor.package!.platform))
    if (monitor.state.target.kind === 'local') {
      // An explicit home override is also the collector's home. Keeping only
      // the installation isolated would let recorder tests write real history.
      const env = this.options.homeDirectory === undefined ? process.env : { ...process.env, HOME: this.options.homeDirectory, USERPROFILE: this.options.homeDirectory }
      const child = spawn(binary, [], { windowsHide: true, stdio: 'pipe', env }); monitor.child = child
      child.once('close', () => { if (monitor.child === child) monitor.child = undefined; void this.releaseReservation(monitor) })
      child.on('error', () => { void this.failed(monitor, new AppError('COLLECTOR_START_FAILED', '采集器无法启动，请检查目标系统支持和执行权限。')) })
      monitor.peer = new CollectorPeer({ input: child.stdin, output: child.stdout, stderr: child.stderr, close: () => child.stdin.end() }, error => { void this.failed(monitor, error) })
    } else {
      const channel = await execChannel(monitor.client!, launchCommand(monitor.state.platform!, binary), monitor.controller.signal)
      if (monitor.controller.signal.aborted) { channel.close(); monitor.controller.signal.throwIfAborted() }
      monitor.channel = channel; await this.live(monitor)
      monitor.peer = new CollectorPeer({ input: channel, output: channel, stderr: channel.stderr, close: () => { channel.end(); channel.close() } }, error => { void this.failed(monitor, error) })
    }
    const hello = parseTaskManagerHello(await monitor.peer.request('hello', {}, 15_000)); await this.live(monitor)
    if (hello.version !== monitor.package!.version || hello.platform !== monitor.state.platform!.os || hello.arch !== monitor.state.platform!.arch) throw new AppError('COLLECTOR_MISMATCH', '采集器版本或目标身份不匹配。')
    if (monitor.state.target.kind === 'local' && this.options.homeDirectory !== undefined && resolvePath(hello.home) !== resolvePath(this.options.homeDirectory)) throw new AppError('COLLECTOR_MISMATCH', '采集器用户目录与本次配置不一致，未允许持续记录。')
    monitor.hello = hello
    const initial = parseTaskManagerSnapshot(await monitor.peer.request('snapshot')); await this.live(monitor)
    if (initial.bootId !== hello.bootId || initial.platform !== hello.platform || initial.arch !== hello.arch) throw new AppError('COLLECTOR_MISMATCH', '首次采集的目标身份不匹配。')
    monitor.snapshot = initial; monitor.snapshotAt = Date.now()
    let pinging = false
    monitor.heartbeat = setInterval(() => { if (pinging || monitor.controller.signal.aborted) return; pinging = true; void monitor.peer!.request('ping', {}, 8000).catch(error => this.failed(monitor, error)).finally(() => { pinging = false }) }, 10_000)
    monitor.heartbeat.unref(); this.publish(monitor, 'ready', '已连接，正在读取实际进程。')
  }
  async snapshot(owner: string, id: string): Promise<TaskManagerSnapshot> {
    const monitor = await this.owned(owner, id, true)
    if (monitor.snapshotTask) return monitor.snapshotTask
    if (monitor.snapshot && Date.now() - (monitor.snapshotAt ?? 0) < 750) return structuredClone(monitor.snapshot)
    monitor.snapshotTask = (async () => {
      const raw = await monitor.peer!.request('snapshot'); await this.live(monitor)
      let result: TaskManagerSnapshot
      try { result = parseTaskManagerSnapshot(raw) }
      catch { const error = new AppError('COLLECTOR_PROTOCOL', '采集器返回的性能或进程数据无效，监控已停止。'); await this.failed(monitor, error); throw error }
      if (result.bootId !== monitor.hello!.bootId || result.platform !== monitor.hello!.platform || result.arch !== monitor.hello!.arch || result.sequence <= (monitor.snapshot?.sequence ?? -1)) { await this.failed(monitor, new AppError('TARGET_CHANGED', '采集目标身份或序列已变化，请重新连接。')); throw new AppError('TARGET_CHANGED', '采集目标身份已变化。') }
      monitor.snapshot = result; monitor.snapshotAt = Date.now(); return structuredClone(result)
    })().finally(() => { monitor.snapshotTask = undefined })
    return monitor.snapshotTask
  }
  private processIdentity(input: unknown) { const p = record(input); return { pid: integer(p.pid, 1, 0xffffffff), startedAt: integer(p.startedAt, 1, Number.MAX_SAFE_INTEGER) } }
  async commandLine(owner: string, id: string, input: unknown) {
    const monitor = await this.owned(owner, id, true), identity = this.processIdentity(input)
    if (!monitor.hello?.capabilities.includes('command-line')) throw new AppError('UNSUPPORTED', '当前采集器不支持启动参数，请断开后重新连接以更新。')
    const result = parseTaskManagerCommandLine(await monitor.peer!.request('commandLine', identity, 10_000)); await this.live(monitor)
    if (result.pid !== identity.pid || result.startedAt !== identity.startedAt) throw new AppError('PROCESS_CHANGED', '进程已变化，请重新选择。')
    return result
  }
  async details(owner: string, id: string, input: unknown) {
    const monitor = await this.owned(owner, id, true), identity = this.processIdentity(input), result = parseTaskManagerDetails(await monitor.peer!.request('details', identity, 20_000)); await this.live(monitor)
    if (result.process.pid !== identity.pid || result.process.startedAt !== identity.startedAt) throw new AppError('PROCESS_CHANGED', '进程已变化，请刷新后选择。')
    return result
  }
  async prepareAction(owner: string, id: string, input: unknown): Promise<TaskManagerActionPlan> {
    const monitor = await this.owned(owner, id, true), p = record(input), identity = this.processIdentity(p)
    await this.host.available()
    if (p.force !== undefined && typeof p.force !== 'boolean') throw new AppError('INVALID_ARGUMENT', '结束方式无效。')
    const force = p.force === true, process = monitor.snapshot?.processes.find(process => process.pid === identity.pid && process.startedAt === identity.startedAt)
    if (!process || Date.now() - (monitor.snapshotAt ?? 0) > 10_000) throw new AppError('PROCESS_CHANGED', '进程资料已经过期，请刷新后重新选择。')
    if (monitor.state.target.kind === 'local' && (identity.pid === globalThis.process.pid || identity.pid === globalThis.process.ppid)) throw new AppError('PROTECTED_PROCESS', '不能结束 WebNav 或承载它的进程。')
    if (!monitor.hello!.capabilities.includes(force ? 'terminate-force' : 'terminate-graceful')) throw new AppError('UNSUPPORTED', force ? '此目标不支持强制结束进程。' : '此目标不支持常规退出；如需强制结束，请明确选择该操作。')
    for (const [key, plan] of monitor.plans) if (plan.value.expiresAt < Date.now() && !plan.result) monitor.plans.delete(key)
    if (monitor.plans.size >= 32) throw new AppError('BUSY', '本次监控的操作记录已满，请重新连接后再操作。')
    const value: TaskManagerActionPlan = { id: randomUUID(), monitorId: id, target: structuredClone(monitor.state.target), label: monitor.state.label, process: { ...identity, name: process.name }, force, expiresAt: Date.now() + 30_000 }
    monitor.plans.set(value.id, { value, bootId: monitor.hello!.bootId }); return structuredClone(value)
  }
  async applyAction(owner: string, id: string, planId: string): Promise<TaskManagerActionResult> {
    const monitor = await this.owned(owner, id, true), plan = monitor.plans.get(string(planId, 100))
    if (!plan) throw new AppError('NOT_FOUND', '进程操作计划不存在。')
    if (plan.result) return plan.result
    await this.host.available()
    if (plan.result) return plan.result
    if (plan.value.expiresAt < Date.now() || plan.bootId !== monitor.hello!.bootId) throw new AppError('PLAN_EXPIRED', '进程操作确认已过期，请重新选择进程。')
    plan.result = (async () => {
      let value: unknown
      try { value = await monitor.peer!.request('terminate', { pid: plan.value.process.pid, startedAt: plan.value.process.startedAt, force: plan.value.force }, 15_000) }
      catch (error) { if (!(error instanceof AppError) || ['COLLECTOR_TIMEOUT', 'COLLECTOR_CLOSED', 'CANCELLED', 'COLLECTOR_PROTOCOL', 'COLLECTOR_OUTPUT_LIMIT', 'COLLECTION_TIMEOUT', 'COLLECTION_FAILED', 'RESPONSE_TOO_LARGE'].includes(error.code)) throw new AppError('ACTION_UNKNOWN', '进程操作结果未知，未自动重试；请重新连接并核对进程状态。'); throw error }
      await this.live(monitor)
      let result: TaskManagerActionResult
      try { result = parseTaskManagerActionResult(value) } catch { throw new AppError('ACTION_UNKNOWN', '进程操作返回的结果无法核验，请重新连接并核对目标状态。') }
      if (result.pid !== plan.value.process.pid || result.startedAt !== plan.value.process.startedAt) throw new AppError('ACTION_UNKNOWN', '进程操作返回的身份不匹配，请核对目标状态。')
      monitor.snapshotAt = 0; return result
    })()
    return plan.result
  }
  private async recordingMonitor(owner: string, id: string, capability: 'recording' | 'history') {
    const monitor = await this.owned(owner, id, true)
    if (!monitor.hello?.capabilities.includes(capability)) throw new AppError('UNSUPPORTED', '此采集器尚不支持持续记录和历史查询，请关闭后重新连接以更新采集器。')
    return monitor
  }
  private async parsedCollectorResult<T>(monitor: Monitor, value: unknown, parse: (value: unknown) => T): Promise<T> {
    await this.live(monitor)
    try { return parse(value) }
    catch { const error = new AppError('COLLECTOR_PROTOCOL', '目标返回的记录或历史数据无效，连接已停止。'); await this.failed(monitor, error); throw error }
  }
  async recordingStatus(owner: string, id: string): Promise<TaskManagerRecordingStatus> {
    const monitor = await this.recordingMonitor(owner, id, 'recording')
    return this.parsedCollectorResult(monitor, await monitor.peer!.request('recording.status'), recordingStatusResult)
  }
  async configureRecording(owner: string, id: string, input: { config: unknown; expectedRevision: number; operationId: string }): Promise<TaskManagerRecordingStatus> {
    const monitor = await this.recordingMonitor(owner, id, 'recording')
    const data = record(input), expectedRevision = integer(data.expectedRevision, 0, Number.MAX_SAFE_INTEGER), operationId = string(data.operationId, 100)
    if (/[\x00-\x1f]/.test(operationId)) throw new AppError('INVALID_ARGUMENT', '记录操作标识无效。')
    let config: TaskManagerRecordingConfig
    try { config = parseTaskManagerRecordingConfig(data.config) } catch { throw new AppError('INVALID_ARGUMENT', '持续记录设置无效，请选择支持的采样间隔、保留天数和容量。') }
    const hash = createHash('sha256').update(JSON.stringify([expectedRevision, config])).digest('hex'), old = monitor.recordingOperations.get(operationId)
    if (old) { if (old.hash !== hash) throw new AppError('OPERATION_CONFLICT', '此记录操作标识已经用于其他设置。'); const result = await old.result; await this.live(monitor); return structuredClone(result) }
    await this.host.available()
    const concurrent = monitor.recordingOperations.get(operationId)
    if (concurrent) {
      if (concurrent.hash !== hash) throw new AppError('OPERATION_CONFLICT', '此记录操作标识已经用于其他设置。')
      const result = await concurrent.result; await this.live(monitor); return structuredClone(result)
    }
    for (const [key, operation] of monitor.recordingOperations) if (operation.settled && operation.expires < Date.now()) monitor.recordingOperations.delete(key)
    if (monitor.recordingOperations.size >= 32) throw new AppError('BUSY', '持续记录的操作记录已满，请重新连接后核对状态。')
    const operation: RecordingOperation = { hash, settled: false, expires: Date.now() + 600_000, result: Promise.resolve().then(async () => {
      await this.live(monitor)
      let value: unknown
      try { value = await monitor.peer!.request('recording.configure', { ...config, expectedRevision, operationId }) }
      catch (error) {
        if (!(error instanceof AppError) || ['COLLECTOR_TIMEOUT', 'COLLECTOR_CLOSED', 'CANCELLED', 'COLLECTOR_PROTOCOL', 'COLLECTOR_OUTPUT_LIMIT', 'COLLECTION_TIMEOUT', 'COLLECTION_FAILED', 'RESPONSE_TOO_LARGE'].includes(error.code)) throw new AppError('RECORDING_UNKNOWN', '持续记录设置的结果未知，未自动重试；请重新连接并核对目标上的实际记录状态。')
        throw error
      }
      await this.live(monitor)
      let result: TaskManagerRecordingStatus
      try { result = await this.parsedCollectorResult(monitor, value, recordingStatusResult) }
      catch (error) { if (error instanceof AppError && error.code === 'COLLECTOR_PROTOCOL') throw new AppError('RECORDING_UNKNOWN', '持续记录设置的返回结果无法核验，请重新连接并核对目标状态。'); throw error }
      if (result.revision < expectedRevision || result.enabled !== config.enabled || result.intervalSeconds !== config.intervalSeconds || result.retentionDays !== config.retentionDays || result.maxMiB !== config.maxMiB) throw new AppError('RECORDING_UNKNOWN', '目标返回的持续记录设置与本次操作不一致，请重新读取实际状态。')
      return result
    }).finally(() => { operation.settled = true; operation.expires = Date.now() + 600_000 }) }
    monitor.recordingOperations.set(operationId, operation)
    const result = await operation.result; await this.live(monitor); return structuredClone(result)
  }
  async queryHistory(owner: string, id: string, input: unknown): Promise<TaskManagerHistoryPage> {
    const monitor = await this.recordingMonitor(owner, id, 'history')
    let query: TaskManagerHistoryQuery
    try { query = parseTaskManagerHistoryQuery(input) } catch { throw new AppError('INVALID_ARGUMENT', '历史查询范围无效，请缩小时间范围或采样点数。') }
    const page = await this.parsedCollectorResult(monitor, await monitor.peer!.request('history.query', { ...query }), parseTaskManagerHistoryPage)
    if (page.from !== query.from || page.to !== query.to || page.points.length > (query.maxPoints ?? 300) || page.points.some(point => point.sampledAt < query.from || point.sampledAt > query.to)) {
      const error = new AppError('COLLECTOR_PROTOCOL', '历史查询返回了范围外的数据，连接已停止。'); await this.failed(monitor, error); throw error
    }
    return page
  }
  async historyPoint(owner: string, id: string, input: string): Promise<TaskManagerHistoryPoint> {
    const monitor = await this.recordingMonitor(owner, id, 'history'), sampleId = string(input, 160)
    if (/[\x00-\x1f]/.test(sampleId)) throw new AppError('INVALID_ARGUMENT', '历史采样标识无效。')
    const point = await this.parsedCollectorResult(monitor, await monitor.peer!.request('history.point', { id: sampleId }), parseTaskManagerHistoryPoint)
    if (point.id !== sampleId) { const error = new AppError('COLLECTOR_PROTOCOL', '历史采样身份不一致，连接已停止。'); await this.failed(monitor, error); throw error }
    // Historical processes deliberately never populate monitor.snapshot or plans.
    return point
  }
  async close(owner: string, id: string) { const monitor = this.monitors.get(string(id, 100)); if (monitor && monitor.owner === owner) await this.stopMonitor(monitor); else if (monitor) throw new AppError('NOT_FOUND', '监控目标不存在。'); return {} }
  async closeOwner(owner: string) { await Promise.allSettled([...this.monitors.values()].filter(monitor => monitor.owner === owner).map(monitor => this.stopMonitor(monitor))) }
  private async stopMonitor(monitor: Monitor) {
    if (!monitor.controller.signal.aborted) { monitor.state.phase = 'closed'; monitor.state.message = '监控已关闭'; monitor.state.progress = undefined; delete monitor.state.hostKey; monitor.updated = Date.now(); monitor.controller.abort() }
    await this.release(monitor); await this.releaseReservation(monitor)
  }
  private async releaseReservation(monitor: Monitor) {
    if (this.fullyReleased(monitor) && !monitor.reservationReleased) { monitor.reservationReleased = true; await this.host.release(monitor.state.id) }
  }
  private release(monitor: Monitor): Promise<void> {
    if (monitor.release) return monitor.release
    monitor.release = (async () => {
      clearInterval(monitor.heartbeat); monitor.keyDecision?.(false); monitor.keyDecision = undefined; monitor.peer?.close(); monitor.peer = undefined
      // The explicitly enabled target recorder belongs to the target user.
      // Closing this page/SSH bridge never changes its desired configuration.
      monitor.plans.clear(); monitor.recordingOperations.clear(); monitor.snapshot = undefined; monitor.fs?.sftp.end(); monitor.fs = undefined; monitor.channel?.close(); monitor.channel = undefined
      const child = monitor.child
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 1500), deadline = setTimeout(() => { clearTimeout(kill); monitor.state.message = '采集器未能按时退出，插件仍保留资源；请核对后重启 WebNav。'; resolve() }, 4000)
        child.once('close', () => { clearTimeout(kill); clearTimeout(deadline); resolve() }); child.stdin.end()
      })
      else if (monitor.child === child) monitor.child = undefined
      const client = monitor.client
      if (client) await new Promise<void>(resolve => {
        const destroy = setTimeout(() => client.destroy(), 500), deadline = setTimeout(() => { clearTimeout(destroy); monitor.state.message = 'SSH 采集连接尚未完成释放，插件仍保留资源。'; resolve() }, 2500)
        client.once('close', () => { clearTimeout(destroy); clearTimeout(deadline); if (monitor.client === client) monitor.client = undefined; resolve() }); client.end()
      })
    })()
    return monitor.release
  }
}
