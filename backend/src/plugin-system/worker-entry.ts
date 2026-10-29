import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import * as shared from '@webnav/shared'
import { WorkerRpc } from './worker-rpc.ts'
import type { PluginBackendApi } from './runtime.ts'

if (!parentPort) throw new Error('插件入口只能在 Worker 中运行。')
const peer = new WorkerRpc(parentPort)
const callbacks = new Map<number, (...args: unknown[]) => unknown>(), cleanups: (() => void | Promise<void>)[] = []
const controllers = new Map<string, AbortController>()
let nextCallback = 0, closed = false, registering = true
const pending = new Set<Promise<unknown>>()
let pendingFailure: unknown
const register = (fn: (...args: never[]) => unknown) => { if (typeof fn !== 'function' || callbacks.size >= 1024) throw Error('插件回调无效或数量超限。'); const id = ++nextCallback; callbacks.set(id, fn as (...args: unknown[]) => unknown); return id }
const queue = (method: string, args: unknown[]) => { const task = peer.call(method, args); pending.add(task); void task.then(() => pending.delete(task), error => { pending.delete(task); pendingFailure ??= error }); return task }
const flush = async () => { while (pending.size) await Promise.all([...pending]); if (pendingFailure) { const error = pendingFailure; pendingFailure = undefined; throw error } }
const requireRegistration = () => { if (!registering || closed) throw new Error('插件注册阶段已经结束。') }
const api: PluginBackendApi = {
  apiVersion: 1, manifest: workerData.manifest, config: workerData.config, dataDirectory: workerData.dataDirectory, shared,
  registerService: (name, implementation) => {
    requireRegistration()
    const methods: Record<string, number> = {}, values: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(implementation)) {
      if (typeof value === 'function') methods[key] = register(value.bind(implementation))
      else values[key] = value
    }
    void queue('service.register', [name, methods, values])
  },
  host: {
    vaultStatus: () => peer.call('vault.status'),
    acquireResource: async () => { if (closed) throw Error('插件已停止。'); const id = await peer.call<number>('lease.acquire'); let released = false; return () => { if (released) return; released = true; void queue('lease.release', [id]) } },
  },
  registerRpc: (name, definition) => { requireRegistration(); void queue('rpc.register', [name, definition.mutate, definition.maintenance, register(definition.handler)]) },
  registerConnector: (name, handler) => { requireRegistration(); void queue('connector.register', [name, register(handler)]) },
  registerAutomationTool: (name, handler) => { requireRegistration(); void queue('automation.register', [name, register(handler)]) },
  beforeUnload: callback => { requireRegistration(); void queue('unload.register', [register(callback)]) },
  onDispose: callback => { if (closed) throw Error('插件已停止。'); cleanups.push(callback) },
  interop: {
    register: (id, version, handlers, initial) => { requireRegistration(); void queue('interop.register', [id, version, Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, register(handler)])), initial]) },
    call: (id, version, method, input, options) => peer.call('interop.call', [id, version, method, input, options ? { timeoutMs: options.timeoutMs } : undefined], undefined, options?.signal),
    publish: (id, version, event, value) => { void queue('interop.publish', [id, version, event, value]) },
    subscribe: (id, version, event, listener) => { const callback = register(listener); void queue('interop.subscribe', [id, version, event, callback]); return () => { callbacks.delete(callback); if (!closed) void queue('interop.unsubscribe', [callback]) } },
  },
}
peer.onEvent = (name, value) => { if (name === 'abort' && typeof value === 'string') controllers.get(value)?.abort() }
peer.handler = async (method, args) => {
  if (method === 'activate') {
    const module: unknown = await import(pathToFileURL(workerData.file).href)
    const activate = (module as { activate?: unknown }).activate
    if (typeof activate !== 'function') throw Error('后端入口必须导出 activate(api)。')
    await activate(api); await flush(); registering = false; return
  }
  if (method === 'dispose') {
    closed = true; registering = false
    for (const controller of controllers.values()) controller.abort()
    const results = await Promise.allSettled(cleanups.reverse().map(cleanup => cleanup()))
    await flush(); callbacks.clear()
    if (results.some(result => result.status === 'rejected')) throw Error('插件资源清理失败。')
    return
  }
  if (method === 'invoke') {
    if (closed) throw Error('插件已经停止。')
    const [id, values, signalId] = args as [number, unknown[], string | null], callback = callbacks.get(id)
    if (!callback) throw Error('插件回调已撤销。')
    if (typeof signalId === 'string') {
      const call = values[1] as { signal: AbortSignal }
      const controller = new AbortController(); controllers.set(signalId, controller); call.signal = controller.signal
    }
    try { const result = await callback(...values); await flush(); return result }
    finally { if (typeof signalId === 'string') controllers.delete(signalId) }
  }
  throw Error('未知插件线程消息。')
}
setInterval(() => peer.event('heartbeat'), 1000).unref()
