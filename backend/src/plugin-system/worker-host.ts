import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { PluginBackendApi } from './runtime.ts'
import type { PluginInteropRegistry } from './interop.ts'
import { bounded, type PluginScope } from './lifecycle.ts'
import { WorkerRpc } from './worker-rpc.ts'
import { AppError } from '../core/errors.ts'
import type { ServiceCapability, LocaleBundle } from '@webnav/shared'

/** The coordinator retains authorization, leases and registration generations. No plugin module is imported here. */
export async function activateDedicated(file: string, api: PluginBackendApi, scope: PluginScope, interop: PluginInteropRegistry, failed: (error: Error) => void, locales?: LocaleBundle) {
  const source = import.meta.url.endsWith('.ts')
  const worker = new Worker(new URL(source ? './worker-entry.ts' : './worker-entry.js', import.meta.url), {
    workerData: { file, manifest: api.manifest, config: api.config, dataDirectory: api.dataDirectory, locales },
    execArgv: source ? ['--experimental-strip-types'] : [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
  })
  const peer = new WorkerRpc(worker), leases = new Map<number, () => void>(), subscriptions = new Map<number, () => void>()
  let closing = false, dead = false, heartbeat = Date.now(), nextLease = 0
  const fail = (error: Error) => {
    if (dead) return
    dead = true; clearInterval(watchdog); peer.close(error)
    for (const release of leases.values()) release(); leases.clear()
    for (const remove of subscriptions.values()) remove(); subscriptions.clear()
    void worker.terminate()
    if (!closing) failed(error)
  }
  const watchdog = setInterval(() => { if (Date.now() - heartbeat > 10000) fail(new AppError('PLUGIN_UNRESPONSIVE', '独占插件线程无响应，已停止；未完成写入需要核对。')) }, 1000)
  peer.onClose = fail
  watchdog.unref()
  worker.on('error', () => fail(new AppError('PLUGIN_FAILED', '独占插件线程异常退出；未完成写入需要核对。')))
  worker.on('exit', () => fail(new AppError('PLUGIN_UNAVAILABLE', '独占插件线程已退出；未完成写入需要核对。')))
  peer.onEvent = name => { if (name === 'heartbeat') heartbeat = Date.now() }
  const invoke = (id: number, args: unknown[], signalId?: string) => peer.call('invoke', [id, args, signalId], interop.capture())
  const cancel = (signalId: string) => { try { peer.event('abort', signalId) } catch { /* A stopped thread has already rejected its outstanding calls. */ } }
  peer.handler = (method, args, context, signal) => interop.withContext(context as ReturnType<PluginInteropRegistry['capture']>, () => {
    if (method === 'lease.release') { const id = Number(args[0]); leases.get(id)?.(); leases.delete(id); return }
    if (method === 'interop.unsubscribe') { const id = Number(args[0]); subscriptions.get(id)?.(); subscriptions.delete(id); return }
    scope.requireActive()
    if (method === 'service.register') {
      const [name, methods, values] = args as [ServiceCapability, Record<string, number>, Record<string, unknown>]
      api.registerService(name, Object.assign(Object.create(null), values, Object.fromEntries(Object.entries(methods).map(([key, callback]) => [key, (...args: unknown[]) => invoke(callback, args)]))))
      return
    }
    if (method === 'rpc.register') {
      const [name, mutate, maintenance, id] = args as [string, boolean, 'read' | 'finish' | undefined, number]
      api.registerRpc(name, { mutate, ...(maintenance ? { maintenance } : {}), handler: (owner, params) => invoke(id, [owner, params]) }); return
    }
    if (method === 'connector.register') { const [name, id] = args as [string, number]; api.registerConnector(name, (...values) => invoke(id, values)); return }
    if (method === 'automation.register') {
      const [name, id] = args as [string, number]
      api.registerAutomationTool(name, async (params, call) => {
        const signalId = `${id}:${randomUUID()}`, abort = () => cancel(signalId)
        if (call.signal.aborted) throw new AppError('CANCELLED', '调用已取消。')
        call.signal.addEventListener('abort', abort, { once: true })
        try { return await invoke(id, [params, { clientId: call.clientId }], signalId) }
        finally { call.signal.removeEventListener('abort', abort) }
      }); return
    }
    if (method === 'unload.register') { const id = Number(args[0]); scope.beforeUnload = () => bounded(invoke(id, []) as Promise<string | undefined>, 5000, '独占插件收尾检查超时。'); return }
    if (method === 'lease.acquire') { if (scope.resources >= 64) throw new AppError('LIMIT_EXCEEDED', '插件资源租约超限。'); const id = ++nextLease; leases.set(id, scope.acquire(true)); return id }
    if (method === 'vault.status') return api.host.vaultStatus()
    if (method === 'interop.register') {
      const [id, version, handlers, initial] = args as [string, number, Record<string, number>, Record<string, Record<string, unknown>>]
      api.interop.register(id, version, Object.fromEntries(Object.entries(handlers).map(([name, callback]) => [name, (input, call) => {
        const signalId = `${callback}:${randomUUID()}`
        const abort = () => cancel(signalId)
        call.signal.addEventListener('abort', abort, { once: true })
        return invoke(callback, [input, { caller: call.caller, owner: call.owner }], signalId).finally(() => call.signal.removeEventListener('abort', abort))
      }])), initial ?? undefined); return
    }
    if (method === 'interop.call') return api.interop.call(args[0] as string, args[1] as number, args[2] as string, args[3] as Record<string, unknown>, { ...(args[4] as { timeoutMs?: number } | undefined), signal })
    if (method === 'interop.publish') { api.interop.publish(args[0] as string, args[1] as number, args[2] as string, args[3] as Record<string, unknown>); return }
    if (method === 'interop.subscribe') {
      const [id, version, event, callback] = args as [string, number, string, number]
      subscriptions.set(callback, api.interop.subscribe(id, version, event, value => { void invoke(callback, [value]).catch(() => {}) })); return
    }
    throw new AppError('PLUGIN_CONTRACT', '独占插件请求了未提供的宿主接口。')
  })
  scope.onDispose(async () => {
    closing = true
    try { if (!dead) await bounded(peer.call('dispose'), 4000, '独占插件清理超时。') }
    finally { fail(new AppError('PLUGIN_UNAVAILABLE', '独占插件已经停止。')); await worker.terminate() }
  })
  try { await bounded(peer.call('activate'), 14000, '独占插件导入或启动超时。') }
  catch (error) { closing = true; fail(error instanceof Error ? error : new Error('插件启动失败。')); throw error }
  return worker.threadId
}
