import { parentPort, workerData } from 'node:worker_threads'
import { WorkerRpc } from './worker-rpc.ts'

export interface WorkerServiceHost {
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>
  onEvent(listener: (name: string, value: unknown) => void): () => void
}
export interface WorkerService {
  methods: Record<string, (...args: never[]) => unknown>
  dispose(): Promise<void>
}

if (!parentPort) throw new Error('服务入口只能在 Worker 内运行。')
const peer = new WorkerRpc(parentPort), listeners = new Set<(name: string, value: unknown) => void>()
let service: WorkerService | undefined, closing = false
const host: WorkerServiceHost = {
  call: (method, args) => peer.call(method, args),
  onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
}
peer.onEvent = (name, value) => { for (const listener of listeners) listener(name, value) }
peer.handler = async (method, args) => {
  if (method === 'initialize') {
    if (service || closing) throw Error('服务已经启动或关闭。')
    const entry = await import(workerData.entry) as { createService(host: WorkerServiceHost, config: unknown): Promise<WorkerService> }
    service = await entry.createService(host, workerData.config)
    return Object.keys(service.methods)
  }
  if (method === 'dispose') { closing = true; await service?.dispose(); listeners.clear(); return }
  if (!service || closing || !Object.hasOwn(service.methods, method)) throw Error('服务方法不可用。')
  return service.methods[method]!(...args as never[])
}
setInterval(() => peer.event('heartbeat'), 1000).unref()
