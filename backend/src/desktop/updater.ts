import { createHash } from 'node:crypto'
import { mkdir, readFile, open, rename, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import type { UpdateActivity, UpdateRequest, UpdateState } from '@webnav/shared'
import { atomicJson, DATA_VERSION, extractRelease, fileHash, giteeReleaseRepository, LAUNCHER_VERSION, readInstallation, readRelease, releaseDirectory, releaseInfo, releasePageManifest, removeOwned, sourceConfig, spaceAvailable, updateRedirect, verifiedManifest, type ReleaseInfo, type UpdateManifest, type UpdateSource } from './update-files.ts'

interface Hooks {
  prepare(interrupt: boolean): Promise<UpdateActivity>
  resume(): Promise<void>
  stop(): Promise<void>
  boot(version: string): Promise<void>
}
type Operation = { id: string; hash: string }
const describe = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : '更新失败，请稍后重试。'

/** The singleton owner survives worker shutdown and owns all update files and decisions. */
export class HostUpdater {
  private source!: UpdateSource
  private info!: ReleaseInfo
  private candidate?: UpdateManifest
  private envelope?: Buffer
  private checking?: Promise<void>
  private downloading?: Promise<void>
  private abort?: AbortController
  private operations: Operation[] = []
  private highest = ''
  private timer?: ReturnType<typeof setTimeout>
  private waitTimer?: ReturnType<typeof setTimeout>
  private installing?: Promise<void>
  private probing?: Promise<void>
  private unavailable?: string
  private waiting?: { version: string; interrupt: boolean }
  private stopped = false
  private delay = 6 * 3600_000
  private serial = Promise.resolve()
  private journalSerial = Promise.resolve()
  private nextCheckAt = 0
  private minCheckAt = 0
  private retryUntil = 0
  private etag?: string
  private lastModified?: string
  private state: UpdateState = { mode: 'installed', phase: 'idle', currentVersion: '', message: '尚未检查更新。' }
  readonly root: string
  private hooks: Hooks
  constructor(root: string, hooks: Hooks) { this.root = root; this.hooks = hooks }
  get busy() { return !!(this.downloading || this.installing || this.waiting) }
  snapshot(): UpdateState { return structuredClone(this.state) }
  private set(phase: UpdateState['phase'], message: string, extra: Partial<UpdateState> = {}) { this.state = { mode: 'installed', phase, currentVersion: this.info.version, ...(this.candidate ? { targetVersion: this.candidate.version, notes: this.candidate.notes } : {}), checkedAt: this.state.checkedAt, operationId: this.state.operationId, message, ...extra } }
  private journal() {
    const result = this.journalSerial.catch(() => {}).then(() => atomicJson(join(this.root, 'updates/state.json'), { operations: this.operations, highest: this.highest, state: this.state, envelope: this.envelope?.toString('base64'), feed: this.source.feed, nextCheckAt: this.nextCheckAt, minCheckAt: this.minCheckAt, retryUntil: this.retryUntil, etag: this.etag, lastModified: this.lastModified }))
    this.journalSerial = result; return result
  }
  async initialize() {
    await mkdir(join(this.root, 'updates'), { recursive: true })
    let installation = await readInstallation(this.root)
    if (installation.pending) {
      const old = await readRelease(this.root, installation.pending.from), next = await readRelease(this.root, installation.pending.to)
      if (old.dataVersion !== next.dataVersion || old.dataVersion !== DATA_VERSION) throw new Error('中断的更新涉及不同数据格式，需要人工恢复。')
      installation = { schemaVersion: 1, current: old.version, previous: next.version, recovered: true }
      await atomicJson(join(this.root, 'installation.json'), installation)
    }
    this.info = await readRelease(this.root, installation.current)
    this.set(installation.recovered ? 'failed' : 'idle', installation.recovered ? '上次更新未完成，已恢复上一版。可重新检查更新。' : '尚未检查更新。', { recovered: installation.recovered })
    try { this.source = sourceConfig(JSON.parse(await readFile(join(this.root, 'update-source.json'), 'utf8'))) }
    catch { this.unavailable = '更新源配置无效，请修复安装目录的 update-source.json。'; this.set('unavailable', this.unavailable); return this.info.version }
    let saved: { operations?: Operation[]; highest?: string; envelope?: string; feed?: string; nextCheckAt?: number; minCheckAt?: number; retryUntil?: number; etag?: string; lastModified?: string } = {}
    try {
      saved = JSON.parse(await readFile(join(this.root, 'updates/state.json'), 'utf8'))
      if (!saved || !Array.isArray(saved.operations) || saved.operations.length > 100 || saved.operations.some(p => !p || typeof p.id !== 'string' || !p.id || p.id.length > 100 || !/^[a-f0-9]{64}$/.test(p.hash)) || new Set(saved.operations.map(p => p.id)).size !== saved.operations.length || (saved.highest && !semver.valid(saved.highest))) throw new Error('Invalid journal')
      this.operations = saved.operations
      this.highest = saved.highest ?? ''
      if (saved.feed === this.source.feed) {
        const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, Date.now() + 7 * 86400_000) : 0
        this.nextCheckAt = time(saved.nextCheckAt); this.minCheckAt = time(saved.minCheckAt); this.retryUntil = time(saved.retryUntil)
        const header = (value: unknown) => typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value) ? value : undefined
        this.etag = header(saved.etag); this.lastModified = header(saved.lastModified)
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        this.unavailable = '更新操作记录损坏，已暂停更新。请保留 updates/state.json 并按恢复说明处理。'
        this.set('unavailable', this.unavailable); return this.info.version
      }
    }
    try {
      if (!installation.recovered && saved.envelope) {
        const bytes = Buffer.from(saved.envelope, 'base64'), target = verifiedManifest(bytes, this.source)
        this.accept(target)
        this.envelope = bytes
        if (semver.gt(target.version, this.info.version)) {
          this.candidate = target; this.envelope = bytes
          this.set('available', '已有缓存的签名更新，可以下载。')
          const archive = this.archive(target)
          if ((await stat(archive).catch(() => undefined))?.size === target.size && await fileHash(archive) === target.sha256) this.set('ready', '更新包已保留，可以安装。')
        }
      }
    } catch { this.etag = undefined; this.lastModified = undefined /* Never replay an install. */ }
    await this.cleanReleases().catch(() => {})
    return this.info.version
  }
  start() { if (this.unavailable) return; this.timer = setTimeout(() => { void this.check(false) }, Math.max(1000, this.nextCheckAt - Date.now(), this.retryUntil - Date.now())); this.timer.unref() }
  private schedule(failed: boolean) {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.delay = failed ? Math.min(24 * 3600_000, this.delay * 2) : 6 * 3600_000
    const delay = Math.max(this.retryUntil - Date.now(), Math.min(24 * 3600_000, this.delay * (0.8 + Math.random() * 0.4)))
    this.nextCheckAt = Date.now() + delay
    this.timer = setTimeout(() => { void this.check(false) }, delay); this.timer.unref()
  }
  private accept(target: UpdateManifest) {
    if (target.platform !== process.platform || target.arch !== process.arch) throw new Error('此更新不适用于当前系统或架构。')
    if (target.minLauncherVersion > LAUNCHER_VERSION) throw new Error('此版本需要新版启动器，请下载完整安装包。')
    if (target.dataVersion !== this.info.dataVersion || target.dataVersion !== DATA_VERSION) throw new Error('此版本需要单独的数据迁移，请使用完整安装包和迁移说明。')
    if (this.source.channel === 'stable' && semver.prerelease(target.version)) throw new Error('稳定更新源不能提供预发布版本。')
    if (this.highest && semver.lt(target.version, this.highest)) throw new Error('更新源返回了较旧的发布记录，请稍后重试。')
  }
  private async receive(url: string, limit: number, signal: AbortSignal, consume: (chunk: Uint8Array) => Promise<void>, conditional = false) {
    const idle = new AbortController(), reset = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), 60_000) }
    let timer = setTimeout(() => idle.abort(), 60_000), total = 0
    let body: ReadableStream<Uint8Array> | null = null
    try {
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity', 'User-Agent': 'WebNav-Release-Check/1.0', Accept: conditional && giteeReleaseRepository(this.source.feed) ? 'text/html' : 'application/octet-stream' }
      if (conditional && this.envelope) { if (this.etag) headers['If-None-Match'] = this.etag; if (this.lastModified) headers['If-Modified-Since'] = this.lastModified }
      let response: Response, address = url
      for (let redirects = 0; ; redirects++) {
        response = await fetch(address, { signal: AbortSignal.any([signal, idle.signal]), redirect: 'manual', credentials: 'omit', headers })
        if (![301,302,303,307,308].includes(response.status)) break
        await response.body?.cancel()
        if (redirects >= 3 || !response.headers.get('location')) throw new Error('更新下载跳转次数过多。')
        address = updateRedirect(address, response.headers.get('location')!, this.source)
      }
      body = response.body
      if (response.status === 429 || response.status === 503 || response.status === 403) {
        const retry = response.headers.get('retry-after'), seconds = retry ? Number(retry) : NaN
        const at = retry && !Number.isFinite(seconds) ? Date.parse(retry) : Date.now() + (Number.isFinite(seconds) ? seconds * 1000 : 3600_000)
        this.retryUntil = Math.max(this.retryUntil, Date.now() + 300_000, Math.min(Number.isFinite(at) ? at : 0, Date.now() + 7 * 86400_000))
        this.minCheckAt = this.retryUntil
        await response.body?.cancel()
        throw new Error('发布站点暂时限制访问，已暂停请求并保留当前版本；到期后再检查。')
      }
      if (conditional && response.status === 304 && this.envelope) return { total: 0, unchanged: true }
      if (!response.ok || !response.body) throw new Error('更新源暂时不可用。')
      if (Number(response.headers.get('content-length')) > limit) throw new Error('更新下载超过大小限制。')
      for await (const chunk of response.body) { reset(); total += chunk.length; if (total > limit) throw new Error('更新下载超过大小限制。'); await consume(chunk) }
      return { total, unchanged: false, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined }
    } finally { clearTimeout(timer); await body?.cancel().catch(() => {}) }
  }
  private check(manual: boolean) {
    if (this.checking) return this.checking
    if (this.busy || ['ready','verifying'].includes(this.state.phase)) { this.schedule(false); return Promise.resolve() }
    if (Date.now() < Math.max(this.minCheckAt, this.retryUntil)) { if (manual) this.state.message = `已使用缓存结果，下次可检查时间：${new Date(Math.max(this.minCheckAt, this.retryUntil)).toLocaleString('zh-CN')}。`; this.schedule(false); return Promise.resolve() }
    this.set('checking', '正在检查更新…')
    this.checking = (async () => {
      let failed = false
      try {
        const chunks: Buffer[] = [], page = !!giteeReleaseRepository(this.source.feed)
        if (page) this.minCheckAt = Date.now() + 5 * 60_000
        const response = await this.receive(this.source.feed, page ? 2 * 1024 * 1024 : 64 * 1024, AbortSignal.timeout(20_000), async chunk => { chunks.push(Buffer.from(chunk)) }, true)
        const bytes = response.unchanged ? this.envelope! : page ? releasePageManifest(Buffer.concat(chunks), this.source) : Buffer.concat(chunks), target = verifiedManifest(bytes, this.source)
        this.accept(target); this.highest = target.version; this.state.checkedAt = Date.now()
        this.candidate = semver.gt(target.version, this.info.version) ? target : undefined
        this.envelope = bytes
        if (!response.unchanged) { this.etag = response.etag; this.lastModified = response.lastModified }
        this.set(this.candidate ? 'available' : 'idle', this.candidate ? '发现新版本，可以下载。' : '当前已是最新版本。')
        await this.journal()
      } catch (error) { failed = true; this.set('failed', manual ? describe(error) : '暂时无法检查更新，稍后会自动重试。') }
      finally { this.schedule(failed); await this.journal().catch(() => {}); this.checking = undefined }
    })()
    return this.checking
  }
  private archive(target: UpdateManifest) { return join(this.root, 'updates', target.version + '.zip') }
  private target(version?: string) {
    if (!this.candidate || version !== this.candidate.version) throw new Error('更新目标已变化，请重新检查。')
    this.accept(verifiedManifest(this.envelope!, this.source))
    return this.candidate
  }
  private download(target: UpdateManifest) {
    if (this.downloading) return
    this.abort = new AbortController(); const signal = this.abort.signal
    const part = this.archive(target) + '.part'
    this.set('downloading', '正在下载更新…', { progress: 0 })
    this.downloading = (async () => {
      try {
        await spaceAvailable(this.root, target.size * 3 + 128 * 1024 * 1024)
        const file = await open(part, 'w', 0o600); let length = 0
        try {
          await this.receive(target.url, target.size, signal, async chunk => { await file.writeFile(chunk); length += chunk.length; this.state.progress = Math.floor(length / target.size * 100) })
          await file.sync()
        } finally { await file.close() }
        signal.throwIfAborted()
        this.set('verifying', '正在校验下载内容…')
        if (length !== target.size || await fileHash(part) !== target.sha256) throw new Error('更新包完整性校验失败，请重新下载。')
        await rename(part, this.archive(target)); this.set('ready', '更新已下载，安装时会重启工作台。'); await this.journal()
      } catch (error) { this.set(signal.aborted ? 'available' : 'failed', signal.aborted ? '下载已取消。' : describe(error)); await removeOwned(this.root, part).catch(() => {}); await this.journal().catch(() => {}) }
      finally { this.downloading = undefined; this.abort = undefined }
    })()
  }
  /** Serialize commands and durably record their id before performing a side effect. */
  command(request: UpdateRequest): Promise<UpdateState> {
    const result = this.serial.then(async () => {
      if (request.action === 'status') return this.snapshot()
      if (this.unavailable) throw new Error(this.unavailable)
      if (this.stopped) throw new Error('工作台正在退出。')
      if (request.action === 'check') { void this.check(true); return this.snapshot() }
      if (!request.operationId || request.operationId.length > 100) throw new Error('缺少更新操作编号。')
      const hash = createHash('sha256').update(JSON.stringify([request.action, request.targetVersion, request.interrupt === true])).digest('hex')
      const old = this.operations.find(p => p.id === request.operationId)
      if (old) { if (old.hash !== hash) throw new Error('操作编号与内容不一致。'); return this.snapshot() }
      if (this.installing) throw new Error('正在切换版本，请等待工作台重新连接。')
      const target = request.action === 'cancel' ? undefined : this.target(request.targetVersion)
      if (request.action === 'download' && Date.now() < this.retryUntil) throw new Error('发布站点仍在限流等待期，请稍后再下载。')
      if (request.action === 'install' && !['ready','waiting'].includes(this.state.phase)) throw new Error('请先完成下载和校验。')
      if (request.action === 'download' && (this.waiting || this.state.phase === 'ready')) return this.snapshot()
      this.operations = [...this.operations.slice(-99), { id: request.operationId, hash }]; this.state.operationId = request.operationId
      await this.journal()
      if (request.action === 'download') this.download(target!)
      else if (request.action === 'cancel') {
        this.abort?.abort(); await this.downloading
        this.waiting = undefined; clearTimeout(this.waitTimer); await this.probing; await this.hooks.resume()
        if (this.state.phase === 'waiting') this.set('ready', '已取消安装，更新包保留。')
      } else if (request.action === 'install') {
        this.waiting = { version: target!.version, interrupt: request.interrupt === true }
        this.set('waiting', '等待当前任务结束后安装…'); this.poll()
      } else throw new Error('未知更新操作。')
      return this.snapshot()
    })
    this.serial = result.then(() => {}, () => {}); return result
  }
  private poll() {
    clearTimeout(this.waitTimer)
    this.waitTimer = setTimeout(() => { if (this.probing) { this.poll(); return }; this.probing = this.advance().finally(() => { this.probing = undefined }) }, 300); this.waitTimer.unref()
  }
  private async advance() {
    if (!this.waiting || this.stopped || this.installing) return
    const decision = this.waiting
    try {
      const activity = await this.hooks.prepare(decision.interrupt)
      if (decision !== this.waiting || this.stopped) return
      const blockers = [...(activity.requests ? ['正在完成已接收的请求'] : []), ...activity.blocking, ...(!decision.interrupt ? activity.connections : [])]
      if (blockers.length) { this.set('waiting', '已有任务仍在使用工作台，结束后自动安装。', { blockers }); this.poll(); return }
      const target = this.target(decision.version)
      this.waiting = undefined
      this.installing = this.apply(target).finally(() => { this.installing = undefined })
      await this.installing
    } catch (error) { this.waiting = undefined; await this.hooks.resume().catch(() => {}); this.set('ready', describe(error)) }
  }
  private async apply(target: UpdateManifest) {
    const old = this.info.version, temporary = join(this.root, 'updates', target.version + '.extract')
    let stopped = false, switched = false
    this.set('installing', '正在准备并切换版本…')
    try {
      if (await fileHash(this.archive(target)) !== target.sha256) throw new Error('更新包已变化，请重新下载。')
      await removeOwned(this.root, temporary)
      await extractRelease(this.archive(target), temporary)
      const info = releaseInfo(JSON.parse(await readFile(join(temporary, 'release.json'), 'utf8')))
      if (JSON.stringify(info) !== JSON.stringify(releaseInfo(target))) throw new Error('更新包与签名清单的版本不一致。')
      const destination = releaseDirectory(this.root, target.version)
      // A previously failed target may be retried; never overwrite the current or previous known-good release.
      const record = await readInstallation(this.root)
      if (target.version === record.current || target.version === record.previous) throw new Error('此版本目录正在被安装记录使用，请重新检查更新。')
      await removeOwned(this.root, destination); await rename(temporary, destination)
      await this.hooks.stop(); stopped = true
      await atomicJson(join(this.root, 'installation.json'), { schemaVersion: 1, current: target.version, previous: old, pending: { from: old, to: target.version } })
      switched = true
      await this.hooks.boot(target.version)
      this.info = info
      await atomicJson(join(this.root, 'installation.json'), { schemaVersion: 1, current: target.version, previous: old })
      this.set('succeeded', '更新完成，工作台已重新启动。'); this.schedule(false); await this.journal()
      await this.cleanReleases().catch(() => { this.state.message += ' 部分旧版本文件暂未清理，下次启动会重试。' })
    } catch (error) {
      let recovered = false
      try {
        if (switched) await this.hooks.stop()
        if (switched) await atomicJson(join(this.root, 'installation.json'), { schemaVersion: 1, current: old, recovered: true })
        if (stopped || switched) { await this.hooks.boot(old); recovered = true }
        else await this.hooks.resume()
      } catch { this.set('failed', '更新未完成，旧版本恢复失败。请退出后重新启动工作台。'); await this.journal().catch(() => {}); return }
      this.info = await readRelease(this.root, old)
      this.set('failed', `${describe(error)}${recovered ? ' 已恢复上一版。' : ''}`, { recovered }); await this.journal().catch(() => {})
    } finally { await removeOwned(this.root, temporary).catch(() => {}) }
  }
  private async cleanReleases() {
    const record = await readInstallation(this.root)
    if (record.pending) return
    const keep = new Set([record.current, record.previous])
    for (const entry of await readdir(join(this.root, 'releases'), { withFileTypes: true })) {
      if (!entry.isDirectory() || keep.has(entry.name) || !semver.valid(entry.name)) continue
      // Delete only a version directory carrying matching release metadata, never unrelated files.
      try { await readRelease(this.root, entry.name) } catch { continue }
      await removeOwned(this.root, releaseDirectory(this.root, entry.name))
    }
    for (const entry of await readdir(join(this.root, 'updates'), { withFileTypes: true })) {
      const abandoned = entry.name.endsWith('.zip.part') ? entry.name.slice(0, -9) : entry.name.endsWith('.extract') ? entry.name.slice(0, -8) : undefined
      if (abandoned && semver.valid(abandoned)) { await removeOwned(this.root, join(this.root, 'updates', entry.name)); continue }
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
      const version = entry.name.slice(0, -4)
      if (semver.valid(version) && version !== this.candidate?.version) await removeOwned(this.root, join(this.root, 'updates', entry.name))
    }
  }
  async close() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.waitTimer); this.waiting = undefined; this.abort?.abort(); await Promise.allSettled([this.downloading, this.checking, this.installing, this.probing]) }
}
