import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { TASK_MANAGER_LIMITS } from '@webnav/shared'
import { AppError, record } from '../../core/errors.ts'

export interface CollectorStreams { input: Writable; output: Readable; stderr?: Readable; close: () => void; }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const collectorErrors: Record<string, string> = {
  INVALID_REQUEST: '采集请求格式无效，请更新 WebNav 与采集器后重试。',
  UNKNOWN_METHOD: '此采集器不支持请求的功能，请更新到匹配版本。',
  REQUEST_TOO_LARGE: '采集请求超出大小限制。',
  RESPONSE_TOO_LARGE: '采集结果超出大小限制，请缩小查询范围。',
  COLLECTION_FAILED: '当前权限或系统环境无法读取所需信息。',
  COLLECTION_TIMEOUT: '采集操作已取消或超时；涉及进程操作时请核对实际状态。',
  PROCESS_UNAVAILABLE: '进程已退出，或当前权限无法读取并核验该进程。',
  IDENTITY_MISMATCH: '进程身份已变化，请刷新后重新选择。',
  PROTECTED_PROCESS: '不能结束系统关键进程、WebNav、采集器或承载连接的进程。',
  PERMISSION_DENIED: '当前目标用户没有执行此进程操作的权限。',
  UNSUPPORTED: '目标系统不支持这项安全操作，可能受平台、系统版本或内核限制。',
  UNSAFE_PATH: '目标记录目录包含链接或不安全的文件，操作已停止。',
  RECORDING_STORAGE_FAILED: '目标无法保存持续记录，请检查用户目录权限和可用磁盘空间。',
  RECORDING_BUSY: '目标正在调整持续记录，请稍后读取实际状态。',
  REVISION_CONFLICT: '持续记录设置已经变化，请刷新实际状态后再保存。',
  OPERATION_CONFLICT: '此操作标识已用于其他持续记录设置，请核对后重新操作。',
  RECORDING_START_FAILED: '目标持续记录程序未能启动，请核对目标状态后重试。',
  HISTORY_NOT_FOUND: '此历史采样已过期、被容量清理，或已经不存在，请刷新历史范围。',
  HISTORY_CORRUPT: '目标历史文件无法通过校验，此部分记录暂时无法读取。',
}

/** One bounded, non-replaying stdio RPC connection, shared by local and SSH collectors. */
export class CollectorPeer {
  private pending = new Map<string, Pending>()
  private buffer = Buffer.alloc(0)
  private stopped = false
  private errorBytes = 0
  private onFailure?: (error: Error) => void
  private streams: CollectorStreams
  constructor(streams: CollectorStreams, onFailure?: (error: Error) => void) {
    this.streams = streams
    this.onFailure = onFailure
    streams.output.on('data', this.read)
    streams.output.once('end', this.ended); streams.output.once('close', this.ended); streams.output.once('error', this.errored)
    streams.input.on('error', this.errored)
    streams.stderr?.on('data', this.drain); streams.stderr?.on('error', this.errored)
  }
  get active() { return !this.stopped }
  private drain = (bytes: Buffer) => { this.errorBytes += bytes.length; if (this.errorBytes > 1024 * 1024) this.fail(new AppError('COLLECTOR_OUTPUT_LIMIT', '采集器错误输出超出限制，连接已停止。')) }
  private ended = () => this.fail(new AppError('COLLECTOR_CLOSED', '采集器连接已断开。'))
  private errored = () => this.fail(new AppError('COLLECTOR_CLOSED', '采集器通信异常，连接已停止。'))
  private read = (bytes: Buffer) => {
    if (this.stopped) return
    // A transport chunk may contain multiple valid lines. Bound each line before concatenation.
    let start = 0
    for (;;) {
      const end = bytes.indexOf(10, start), part = bytes.subarray(start, end < 0 ? bytes.length : end)
      if (this.buffer.length + part.length > TASK_MANAGER_LIMITS.messageBytes) { this.fail(new AppError('COLLECTOR_OUTPUT_LIMIT', '采集器响应超出限制。')); return }
      this.buffer = Buffer.concat([this.buffer, part])
      if (end < 0) return
      const line = this.buffer; this.buffer = Buffer.alloc(0)
      try {
        const data = record(JSON.parse(line.toString('utf8')))
        if (data.v !== 1 || typeof data.id !== 'string' || typeof data.ok !== 'boolean') throw new Error('protocol')
        const pending = this.pending.get(data.id)
        if (!pending) throw new Error('unknown response')
        const error = data.ok ? undefined : record(data.error)
        this.pending.delete(data.id); clearTimeout(pending.timer)
        if (!error) pending.resolve(data.result)
        else { const code = typeof error.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'COLLECTOR_ERROR'; pending.reject(new AppError(code, collectorErrors[code] ?? '采集器操作失败，请检查目标状态后重试。')) }
      } catch { this.fail(new AppError('COLLECTOR_PROTOCOL', '采集器响应无效，连接已停止。')); return }
      start = end + 1
      if (start === bytes.length) return
    }
  }
  request(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<unknown> {
    if (this.stopped) return Promise.reject(new AppError('COLLECTOR_CLOSED', '采集器尚未连接。'))
    if (this.pending.size >= 4) return Promise.reject(new AppError('BUSY', '采集器正在处理请求，请稍后重试。'))
    const id = randomUUID(), bytes = Buffer.from(JSON.stringify({ v: 1, id, method, params }) + '\n')
    if (bytes.length > TASK_MANAGER_LIMITS.requestBytes) return Promise.reject(new AppError('LIMIT', '采集请求超出限制。'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AppError('COLLECTOR_TIMEOUT', '采集器响应超时；操作结果可能未知，请重新连接并核对。')), timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.streams.input.write(bytes, error => { if (error) this.errored() }) } catch { this.errored() }
    })
  }
  private fail(error: Error) { if (this.stopped) return; this.dispose(error); this.onFailure?.(error) }
  close() { this.onFailure = undefined; this.dispose(new AppError('CANCELLED', '监控已关闭。')) }
  private dispose(error: Error) {
    if (this.stopped) return
    this.stopped = true; this.buffer = Buffer.alloc(0)
    this.streams.output.off('data', this.read); this.streams.stderr?.off('data', this.drain)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear(); this.streams.close()
  }
}
