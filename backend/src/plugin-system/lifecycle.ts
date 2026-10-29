import { Context, type EventOptions, type ForkScope } from 'cordis'

type Cleanup = () => unknown
type Binding = { method: string; args: unknown[]; remove?: Cleanup }
export async function bounded<T>(task: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** A stable Cordis service identity. Consumers and their subscriptions survive implementation swaps. */
export class ServiceBridge {
  current?: object
  pending = 0
  private bindings = new Set<Binding>()
  readonly proxy: object
  constructor() {
    this.proxy = new Proxy({}, { get: (_target, key) => {
      if (!this.current) return undefined
      const value: unknown = Reflect.get(this.current, key)
      if (typeof key !== 'string' || typeof value !== 'function') return value
      if (key === 'subscribe' || key === 'register') return (...args: unknown[]) => {
        const binding: Binding = { method: key, args }; this.attach(binding); this.bindings.add(binding)
        return () => { if (this.bindings.delete(binding)) binding.remove?.() }
      }
      return (...args: unknown[]) => {
        const target = this.current!, method: unknown = Reflect.get(target, key)
        if (typeof method !== 'function') throw new Error(`服务未实现 ${key}。`)
        const result: unknown = Reflect.apply(method, target, args)
        if (result instanceof Promise) { this.pending++; return result.finally(() => { this.pending-- }) }
        return result
      }
    } })
  }
  private attach(binding: Binding) {
    const method: unknown = Reflect.get(this.current!, binding.method)
    if (typeof method !== 'function') throw new Error(`服务未实现 ${binding.method}。`)
    const remove: unknown = Reflect.apply(method, this.current, binding.args)
    if (typeof remove !== 'function') throw new Error('服务订阅和注册必须返回清理函数。')
    binding.remove = remove as Cleanup
  }
  swap(target: object) {
    for (const binding of this.bindings) binding.remove?.()
    this.current = target
    for (const binding of this.bindings) this.attach(binding)
  }
  notify() {
    for (const binding of this.bindings) if (binding.method === 'subscribe' && typeof binding.args[0] === 'function') {
      try { binding.args[0]() } catch { /* A subscriber must not prevent runtime publication. */ }
    }
  }
}

/** Stage registrations until validation finishes; retain the old registrations for rollback. */
export class PluginScope {
  readonly fork: ForkScope<Context>
  readonly ctx: Context
  readonly bindings: { attach: () => Cleanup; remove?: Cleanup; cancelled?: boolean }[] = []
  private cleanups: (() => void | Promise<void>)[] = []
  private contextCleanups: Promise<PromiseSettledResult<unknown>>[] = []
  private disposed = false
  resources = 0
  draining = false
  beforeUnload?: () => string | undefined | Promise<string | undefined>
  constructor(parent: Context) {
    let child!: Context
    this.fork = parent.plugin({ inject: ['connectors', 'storage', 'credentials', 'auth'], apply: ctx => { child = ctx } })
    this.ctx = child
    // Cordis starts dispose listeners without awaiting them. Track this scope's listeners,
    // including descendants created by service factories, so hot unload can await cleanup.
    const contextCleanups = this.contextCleanups
    Object.defineProperty(child, 'on', { value: function (this: Context, name: string, listener: (...args: unknown[]) => unknown, options?: boolean | EventOptions) {
      if (name !== 'dispose') return this.lifecycle.on(name, listener, options)
      return this.lifecycle.on(name, (...args: unknown[]) => {
        let task: Promise<unknown>
        try { task = Promise.resolve(listener(...args)) } catch (error) { task = Promise.reject(error) }
        contextCleanups.push(task.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })))
        return task
      }, options)
    } })
    for (const name of ['connectors', 'sessions', 'desktops', 'deviceSessions']) {
      const service: unknown = parent.get(name)
      if (!service || typeof service !== 'object') continue
      this.ctx = this.ctx.isolate(name)
      this.ctx.set(name, new Proxy(service, { get: (target, key) => {
        const value: unknown = Reflect.get(target, key)
        if (key === 'register' && typeof value === 'function') return (...args: unknown[]) => {
          const binding = { attach: () => Reflect.apply(value, target, args) as Cleanup, remove: undefined as Cleanup | undefined, cancelled: false }
          this.bindings.push(binding)
          return () => { binding.cancelled = true; binding.remove?.(); binding.remove = undefined }
        }
        return typeof value === 'function' ? value.bind(target) : value
      } }))
    }
  }
  requireActive() { if (this.disposed) throw new Error('插件作用域已经关闭。') }
  onDispose(cleanup: () => void | Promise<void>) { this.requireActive(); this.cleanups.push(cleanup) }
  acquire(accepting = false) {
    if (accepting) this.ctx.get('maintenance')?.requireAvailable()
    if (this.disposed || (accepting && this.draining)) throw new Error('插件正在等待更新或卸载，暂不接受新任务。')
    this.resources++
    let released = false
    return () => { if (!released) { released = true; this.resources-- } }
  }
  track<T>(callback: () => T): T {
    const release = this.acquire()
    try {
      const result = callback()
      if (result instanceof Promise) return result.finally(release) as T
      release(); return result
    } catch (error) { release(); throw error }
  }
  connect() { for (const binding of this.bindings) if (!binding.cancelled && !binding.remove) binding.remove = binding.attach() }
  disconnect() { for (const binding of this.bindings) { binding.remove?.(); binding.remove = undefined } }
  async dispose() {
    if (this.disposed) return
    this.disposed = true; this.disconnect()
    let results: PromiseSettledResult<void>[] = []
    try { results = await bounded(Promise.allSettled(this.cleanups.reverse().map(async cleanup => cleanup())), 5000, '插件清理超时，请重启完成资源回收。') }
    finally { this.fork.dispose() }
    const contextResults = await bounded(Promise.all(this.contextCleanups), 5000, '插件服务清理超时，请重启完成资源回收。')
    await bounded(this.ctx.lifecycle.flush(), 5000, '插件清理超时，请重启完成资源回收。')
    const failure = [...results, ...contextResults].find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw new Error('插件清理失败，请重启完成资源回收。')
  }
}
