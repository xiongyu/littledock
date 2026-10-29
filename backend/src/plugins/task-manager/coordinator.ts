import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { parseTaskManagerTarget, type TaskManagerTarget } from '@webnav/shared'
import { AppError, record, string } from '../../core/errors.ts'
import { requireConnectionCapacity } from '../../core/connection-budget.ts'
import { startService } from '../../plugin-system/service-host.ts'
import { taskManagerMethods, type TaskManagerConfig, type TaskManagerMethods } from './contract.ts'

type Reservation = { owner: string; target: TaskManagerTarget; binding?: string }
declare module 'cordis' { interface Context { taskManager: TaskManagerService } }
export interface TaskManagerService extends Omit<TaskManagerMethods, 'start'> {}

/** Auth, atomic reservations and the typed message boundary; no collector/business module imports. */
export class TaskManagerService extends Service {
  static inject = ['storage', 'credentials', 'auth']
  private reservations = new Map<string, Reservation>()
  private actor: ReturnType<typeof startService>
  private failure?: Error
  readonly ready: Promise<void>
  readonly runtime: { backend: 'shared' | 'dedicated'; threadId: number }
  constructor(ctx: Context, config: TaskManagerConfig & { execution: 'shared' | 'dedicated' }) {
    super(ctx, 'taskManager', true)
    const source = import.meta.url.endsWith('.ts')
    const { execution, ...options } = config
    this.actor = startService(new URL(source ? './worker.ts' : './worker.js', import.meta.url), options, execution,
      (method, args) => this.hostCall(method, args), error => {
        this.failure = error
        const manager = ctx.get('plugins')?.manager
        if (manager?.runtimes.get('builtin.taskManager')?.threadId === this.actor.threadId) {
          manager.runtimes.delete('builtin.taskManager'); manager.errors.set('builtin.taskManager', error.message)
          manager.pending.set('builtin.taskManager', { id: 'builtin.taskManager', kind: 'error', reason: error.message })
          manager.runtimeRevision++; ctx.plugins.notifyRuntime()
        }
      })
    for (const method of taskManagerMethods) if (method !== 'start') Object.defineProperty(this, method, { configurable: true, value: (...args: unknown[]) => this.actor.call(method, args) })
    const unwatch = ctx.credentials.subscribe(status => { if (!status.unlocked) this.actor.event('lock') })
    this.runtime = { backend: execution, threadId: this.actor.threadId }
    this.ready = this.actor.ready.then(() => {})
    void this.ready.catch(() => {})
    ctx.on('ready', () => this.ready)
    ctx.on('dispose', async () => {
      unwatch()
      try { await this.actor.stop() } finally {
        this.reservations.clear()
        const runtimes = ctx.get('plugins')?.manager.runtimes
        if (runtimes?.get('builtin.taskManager')?.threadId === this.actor.threadId) runtimes.delete('builtin.taskManager')
      }
    })
  }
  get size() { return this.reservations.size }
  get sizeRemote() { return [...this.reservations.values()].filter(r => r.target.kind === 'ssh').length }
  hasResources() { return this.reservations.size > 0 }
  start(): void
  start(owner: string, target: TaskManagerTarget): ReturnType<TaskManagerMethods['start']>
  start(owner?: string, target?: TaskManagerTarget) { if (owner !== undefined) return this.actor.call<Awaited<ReturnType<TaskManagerMethods['start']>>>('start', [owner, target]) }
  private authorize(owner: string) {
    if (!this.ctx.auth.authorized(owner)) throw new AppError('UNAUTHORIZED', '页面会话已经过期。')
    this.ctx.credentials.requireUnlocked()
  }
  private owned(owner: string, id: string) {
    this.authorize(owner)
    const reservation = this.reservations.get(id)
    if (!reservation || reservation.owner !== owner) throw new AppError('NOT_FOUND', '监控连接已经释放。')
    return reservation
  }
  private binding(target: TaskManagerTarget) {
    if (target.kind !== 'ssh') throw new AppError('INVALID_ARGUMENT', '请选择 SSH 入口。')
    const { server, connection } = this.ctx.storage.connection(target.serverId, target.connectionId)
    if (connection.type !== 'ssh') throw new AppError('INVALID_ARGUMENT', '请选择已保存的 SSH 入口。')
    return { host: server.host.replace(/^\[|\]$/g, ''), port: connection.port, username: connection.username, label: `${server.name} · ${connection.username}@${server.host}` }
  }
  private async hostCall(method: string, args: unknown[]) {
    if (method === 'release') { this.reservations.delete(string(args[0], 100)); return }
    if (this.failure) throw this.failure
    if (method === 'available') { this.ctx.get('maintenance')?.requireAvailable(); this.ctx.get('plugins')?.requireAvailable('taskManager'); return }
    const owner = string(args[0], 100)
    this.authorize(owner)
    if (method === 'authorize') return
    if (method === 'reserve') {
      this.ctx.get('maintenance')?.requireAvailable(); this.ctx.get('plugins')?.requireAvailable('taskManager')
      if (this.size >= 8) throw new AppError('BUSY', '同时监控最多 8 个目标。')
      const target = parseTaskManagerTarget(args[1]), id = randomUUID()
      const binding = target.kind === 'ssh' ? this.binding(target) : undefined
      // Runs atomically on the shared coordinator before any Worker/SSH await.
      if (binding) requireConnectionCapacity(this.ctx)
      this.reservations.set(id, { owner, target, ...(binding ? { binding: JSON.stringify(binding) } : {}) })
      return { id, label: binding?.label ?? '本机 · ' + hostname() }
    }
    const id = string(args[1], 100), reservation = this.owned(owner, id), target = reservation.target
    if (target.kind !== 'ssh') throw new AppError('INVALID_ARGUMENT', '此监控不是 SSH 连接。')
    const binding = this.binding(target)
    if (JSON.stringify(binding) !== reservation.binding) throw new AppError('TARGET_CHANGED', 'SSH 入口已经变化，请重新选择目标。')
    if (method === 'connection') {
      const credentials = await this.ctx.credentials.resolve(target.serverId, target.connectionId)
      try {
        this.owned(owner, id)
        if (JSON.stringify(this.binding(target)) !== reservation.binding) throw new AppError('TARGET_CHANGED', 'SSH 入口已经变化。')
        return { ...binding, ...credentials, ...(credentials.privateKey ? { privateKey: credentials.privateKey.toString('base64') } : {}) }
      } finally { credentials.privateKey?.fill(0) }
    }
    if (method === 'fingerprint') {
      const endpoint = JSON.stringify([binding.host, binding.port])
      const row = this.ctx.storage.db.prepare('SELECT fingerprint FROM hostkeys WHERE endpoint=?').get(endpoint) as { fingerprint: string } | undefined
      const saved = row?.fingerprint ?? ''
      if (args[2] !== undefined && args[2] !== null) {
        const next = record(args[2]), fingerprint = string(next.fingerprint, 128), previous = string(next.previous, 128, true)
        if (!/^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint)) throw new AppError('INVALID_ARGUMENT', '主机指纹无效。')
        if (saved !== previous && saved !== fingerprint) throw new AppError('HOST_KEY_CHANGED', '主机指纹已经变化，请重新连接核验。')
        this.ctx.storage.db.prepare('INSERT OR REPLACE INTO hostkeys(endpoint,fingerprint) VALUES (?,?)').run(endpoint, fingerprint)
        return fingerprint
      }
      return saved
    }
    throw new AppError('PLUGIN_CONTRACT', '服务宿主接口不存在。')
  }
}
