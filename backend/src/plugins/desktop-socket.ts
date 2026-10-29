import { createConnection, type Socket } from 'node:net'
import { AppError } from '../core/errors.ts'

export async function connectDesktopSocket(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted()
  const socket = createConnection({ host, port })
  socket.setNoDelay(true)
  const abort = () => socket.destroy()
  signal.addEventListener('abort', abort, { once: true })
  socket.once('close', () => signal.removeEventListener('abort', abort))
  // Always install an error listener, including the gap between connection and handshake.
  socket.on('error', () => {})
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new AppError('DESKTOP_UNREACHABLE', '远程桌面服务连接超时。')) }, 8000)
    const failed = () => { clearTimeout(timer); reject(new AppError('DESKTOP_UNREACHABLE', '无法连接远程桌面服务，请检查地址、端口及服务是否开启。')) }
    socket.once('error', failed); socket.once('close', failed)
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); socket.off('close', failed); socket.pause(); resolve(socket) })
  })
}

/** Read exact, bounded handshake records without losing coalesced trailing bytes. */
export class DesktopSocketReader {
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false
  private waiting?: { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }
  private readonly socket: Socket
  constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', this.data); socket.on('close', this.end); socket.on('error', this.end)
  }
  private data = (bytes: Buffer) => {
    if (this.buffer.length + bytes.length > 128 * 1024) { this.socket.destroy(); this.end(); return }
    this.buffer = Buffer.concat([this.buffer, bytes]); this.deliver()
  }
  private end = () => {
    this.closed = true
    this.waiting?.reject(new AppError('VNC_HANDSHAKE_FAILED', 'VNC 握手中断，请检查认证方式与密码。')); this.waiting = undefined
  }
  private deliver() {
    const pending = this.waiting
    if (!pending || this.buffer.length < pending.size) return
    this.socket.pause(); this.waiting = undefined
    const bytes = this.buffer.subarray(0, pending.size); this.buffer = this.buffer.subarray(pending.size); pending.resolve(bytes)
  }
  read(size: number): Promise<Buffer> {
    if (!Number.isInteger(size) || size < 1 || size > 64 * 1024 || this.waiting || this.closed) return Promise.reject(new AppError('VNC_HANDSHAKE_FAILED', 'VNC 握手数据不正确。'))
    return new Promise((resolve, reject) => { this.waiting = { size, resolve, reject }; this.deliver(); if (this.waiting) this.socket.resume() })
  }
  release() {
    this.socket.pause(); this.socket.off('data', this.data); this.socket.off('close', this.end); this.socket.off('error', this.end)
    if (this.buffer.length) this.socket.unshift(this.buffer)
    this.buffer = Buffer.alloc(0)
  }
}
