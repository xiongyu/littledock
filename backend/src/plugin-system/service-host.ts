import { Worker, threadId } from 'node:worker_threads'
import { WorkerRpc, type RpcHandler } from './worker-rpc.ts'
import { bounded } from './lifecycle.ts'
import { AppError } from '../core/errors.ts'
import type { WorkerService, WorkerServiceHost } from './service-worker.ts'

export function startService(entry: URL, config: unknown, execution: 'shared' | 'dedicated', handler: RpcHandler, failed: (error: Error) => void) {
  if (execution === 'dedicated') return startWorkerService(entry, config, handler, failed)
  const listeners = new Set<(name: string, value: unknown) => void>(), controller = new AbortController()
  const host: WorkerServiceHost = {
    call: async <T>(method: string, args: unknown[] = []) => await handler(method, args, undefined, controller.signal) as T,
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  let service: WorkerService | undefined, closed = false
  const ready = bounded((async () => {
    const module = await import(entry.href) as { createService(host: WorkerServiceHost, config: unknown): Promise<WorkerService> }
    service = await module.createService(host, config); return Object.keys(service.methods)
  })(), 14000, '插件服务启动超时。').catch(error => { failed(error); throw error })
  void ready.catch(() => {})
  return {
    threadId, ready,
    async call<T>(method: string, args: unknown[]): Promise<T> {
      await ready
      if (closed || !Object.hasOwn(service!.methods, method)) throw new AppError('PLUGIN_UNAVAILABLE', '插件服务不可用。')
      return await service!.methods[method]!(...args as never[]) as T
    },
    event(name: string, value?: unknown) { if (!closed) for (const listener of listeners) listener(name, value) },
    async stop() { if (closed) return; closed = true; controller.abort(); await ready.catch(() => {}); try { await service?.dispose() } finally { listeners.clear() } },
  }
}

/** Framework-owned actor lifecycle. Only this bootstrap is imported by the coordinator. */
export function startWorkerService(entry: URL, config: unknown, handler: RpcHandler, failed: (error: Error) => void) {
  const source = import.meta.url.endsWith('.ts')
  const worker = new Worker(new URL(source ? './service-worker.ts' : './service-worker.js', import.meta.url), {
    workerData: { entry: entry.href, config }, execArgv: source ? ['--experimental-strip-types'] : [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
  })
  const peer = new WorkerRpc(worker)
  let heartbeat = Date.now(), dead = false, closing: Promise<void> | undefined
  const fail = (error: Error) => {
    if (dead) return
    dead = true; clearInterval(watchdog); peer.close(error); void worker.terminate()
    if (!closing) failed(error)
  }
  const watchdog = setInterval(() => { if (Date.now() - heartbeat > 10000) fail(new AppError('PLUGIN_UNRESPONSIVE', '插件线程无响应，已停止；未完成操作需要核对。')) }, 1000)
  watchdog.unref(); peer.handler = handler; peer.onClose = fail
  peer.onEvent = name => { if (name === 'heartbeat') heartbeat = Date.now() }
  worker.on('error', () => fail(new AppError('PLUGIN_FAILED', '插件线程异常退出；未完成操作需要核对。')))
  worker.on('exit', () => fail(new AppError('PLUGIN_UNAVAILABLE', '插件线程已退出；未完成操作需要核对。')))
  const ready = bounded(peer.call<string[]>('initialize'), 14000, '插件线程启动超时。').catch(error => { fail(error); throw error })
  // Startup can precede Cordis ready; retain the rejection for the awaited startup hook.
  void ready.catch(() => {})
  return {
    threadId: worker.threadId, ready,
    async call<T>(method: string, args: unknown[]): Promise<T> { await ready; return peer.call<T>(method, args) },
    event(name: string, value?: unknown) { if (!dead) peer.event(name, value) },
    stop() { return closing ??= (async () => {
      try { if (!dead) await bounded(peer.call('dispose'), 8000, '插件资源清理超时。') }
      finally { fail(new AppError('PLUGIN_UNAVAILABLE', '插件已经停止。')); await worker.terminate() }
    })() },
  }
}
