import type { MessagePort, Worker } from 'node:worker_threads'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError } from '../core/errors.ts'

type Port = Pick<MessagePort | Worker, 'on' | 'off' | 'postMessage'>
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; context?: unknown; cleanup?: () => void }
export type RpcHandler = (method: string, args: unknown[], context: unknown, signal: AbortSignal) => unknown
const MAX_BYTES = 2 * 1024 * 1024
const MAX_PENDING = 64

/** Bounded, bidirectional JSON messages. Functions and host objects never cross this boundary. */
export class WorkerRpc {
  private nextId = 0
  private pending = new Map<number, Pending>()
  private incoming = 0
  private controllers = new Map<number, AbortController>()
  private closed?: Error
  private invocation = new AsyncLocalStorage<number>()
  private window = Date.now()
  private messages = 0
  onClose?: (error: Error) => void
  onEvent?: (name: string, value: unknown) => void
  handler?: RpcHandler
  private port: Port
  constructor(port: Port) { this.port = port; port.on('message', this.receive) }
  private send(value: unknown) {
    if (this.closed) throw this.closed
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > MAX_BYTES) throw new AppError('LIMIT_EXCEEDED', '插件线程消息超过 2 MiB。')
    this.port.postMessage(text)
  }
  event(name: string, value?: unknown) { this.send({ type: 'event', name, value }) }
  call<T = unknown>(method: string, args: unknown[] = [], context?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new AppError('BUSY', '插件线程请求过多。'))
    if (signal?.aborted) return Promise.reject(new AppError('CANCELLED', '插件调用已取消。'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const abort = () => { try { this.send({ type: 'cancel', id }) } catch { /* Closing rejects pending calls. */ } }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve: value => resolve(value as T), reject, context, cleanup: () => signal?.removeEventListener('abort', abort) })
      try { this.send({ type: 'call', id, method, args, parent: this.invocation.getStore() }) }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(error) }
    })
  }
  private receive = (input: unknown) => {
    if (this.closed) return
    if (Date.now() - this.window >= 1000) { this.window = Date.now(); this.messages = 0 }
    if (++this.messages > 1024) { this.close(new AppError('LIMIT_EXCEEDED', '插件线程消息频率超限。')); return }
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BYTES) { this.close(new AppError('PLUGIN_PROTOCOL', '插件线程消息无效。')); return }
    let packet: Record<string, unknown>
    try { packet = JSON.parse(input) as Record<string, unknown>; if (!packet || typeof packet !== 'object') throw Error() }
    catch { this.close(new AppError('PLUGIN_PROTOCOL', '插件线程消息无效。')); return }
    if (packet.type === 'event' && typeof packet.name === 'string') { try { this.onEvent?.(packet.name, packet.value) } catch { /* Host owns failure reporting. */ }; return }
    if (!Number.isSafeInteger(packet.id)) return
    const id = Number(packet.id)
    if (packet.type === 'cancel') { this.controllers.get(id)?.abort(); return }
    if (packet.type === 'result') {
      const pending = this.pending.get(id); if (!pending) return
      this.pending.delete(id)
      pending.cleanup?.()
      if (packet.error && typeof packet.error === 'object') {
        const error = packet.error as Record<string, unknown>
        pending.reject(new AppError(typeof error.code === 'string' ? error.code : 'PLUGIN_FAILED', typeof error.message === 'string' ? error.message : '插件调用失败。'))
      } else pending.resolve(packet.value)
      return
    }
    if (packet.type !== 'call' || typeof packet.method !== 'string' || !Array.isArray(packet.args)) return
    const replyError = (error: unknown) => {
      if (this.closed) return
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'PLUGIN_FAILED'
      try { this.send({ type: 'result', id, error: { code, message: error instanceof Error ? error.message.slice(0, 1000) : '插件调用失败。' } }) } catch { this.close(new Error('插件线程响应失败。')) }
    }
    if (this.incoming >= MAX_PENDING) { replyError(new AppError('BUSY', '插件线程并发请求超限。')); return }
    this.incoming++
    const controller = new AbortController(); this.controllers.set(id, controller)
    const context = typeof packet.parent === 'number' ? this.pending.get(packet.parent)?.context : undefined
    const method = packet.method, args = packet.args
    void Promise.resolve().then(() => this.invocation.run(id, () => {
      if (!this.handler) throw new AppError('PLUGIN_UNAVAILABLE', '插件线程尚未就绪。')
      return this.handler(method, args, context, controller.signal)
    })).then(value => { if (!this.closed) this.send({ type: 'result', id, value }) }).catch(replyError).finally(() => { this.incoming--; this.controllers.delete(id) })
  }
  close(error: Error = new AppError('PLUGIN_UNAVAILABLE', '插件线程已停止；未完成写入需要核对。')) {
    if (this.closed) return
    this.closed = error; this.port.off('message', this.receive)
    for (const request of this.pending.values()) { request.cleanup?.(); request.reject(error) }
    this.pending.clear()
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.onClose?.(error)
  }
}
