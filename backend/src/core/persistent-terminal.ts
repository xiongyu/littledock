import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { WebSocket } from 'ws'
import { AppError, integer } from './errors.ts'

type Viewer = { ws: WebSocket; sent: number; ack: number; queue: Buffer[]; bytes: number; lastAck: number; events:{after:number;value:unknown}[] }

/** The PTY belongs to the host; a browser is one replaceable input/display attachment. */
export class PersistentTerminal {
  readonly terminal: InstanceType<typeof headless.Terminal>
  private serializer = new serialize.SerializeAddon()
  private viewer?: Viewer
  private parsing = Promise.resolve()
  private pendingWrite?:()=>void
  private ended = false
  private disposed = false
  private reason = ''
  private finished?:Promise<void>
  private resolveFinished?:()=>void
  private timer: ReturnType<typeof setInterval>
  constructor(cols: number, rows: number, input: (bytes: Buffer) => void) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer)
    this.terminal.onData(text => { if (!this.ended) { try { input(Buffer.from(text)) } catch { /* Connection owner handles exit. */ } } })
    this.timer = setInterval(() => {
      const viewer = this.viewer
      if (viewer && viewer.sent > viewer.ack && Date.now() - viewer.lastAck > 30_000) this.detach(viewer.ws, 1013)
      if (this.ended && !this.viewer) this.dispose()
    }, 5000)
    this.timer.unref()
  }
  write(bytes: Buffer) {
    this.parsing = this.parsing.then(() => new Promise<void>(resolve => {
      if (this.disposed) { resolve(); return }
      this.pendingWrite=resolve
      this.terminal.write(bytes, () => { this.pendingWrite=undefined;if (this.viewer) this.enqueue(this.viewer, bytes); resolve() })
    }))
    return this.parsing
  }
  attach(ws: WebSocket) {
    // Serialize attachment with parsing so no output is duplicated or lost at the snapshot boundary.
    this.parsing = this.parsing.then(() => {
      if (this.disposed || ws.readyState !== WebSocket.OPEN) return
      if (this.viewer) this.detach(this.viewer.ws, 4001)
      const viewer: Viewer = { ws, sent: 0, ack: 0, queue: [], bytes: 0, lastAck: Date.now(),events:[] }
      this.viewer = viewer
      ws.on('close', () => this.detach(ws)); ws.on('error', () => this.detach(ws))
      ws.send(JSON.stringify({ type: 'terminal.snapshot', cols: this.terminal.cols, rows: this.terminal.rows }))
      this.enqueue(viewer, Buffer.from(this.serializer.serialize({ scrollback: 2000 })))
    })
    return this.parsing
  }
  resize(cols: number, rows: number) { this.terminal.resize(cols, rows) }
  event(value:unknown){const v=this.viewer;if(!v)return;v.events.push({after:v.sent+v.bytes,value});this.pump(v)}
  ack(ws: WebSocket, value: unknown) {
    const viewer = this.viewer
    if (!viewer || viewer.ws !== ws) throw new AppError('READ_ONLY', '此终端已在另一个页面打开。')
    const ack = integer(value, viewer.ack, viewer.sent)
    viewer.ack = ack; viewer.lastAck = Date.now(); this.pump(viewer)
  }
  detach(ws: WebSocket, code = 1000) {
    if (this.viewer?.ws !== ws) return
    this.viewer.queue = []; this.viewer.bytes = 0; this.viewer = undefined
    if (ws.readyState === WebSocket.OPEN) ws.close(code, code === 4001 ? '此连接已在另一个页面打开' : '')
    if (this.ended) this.dispose()
  }
  private enqueue(viewer: Viewer, bytes: Buffer) {
    if (viewer.bytes + viewer.sent - viewer.ack + bytes.length > 8 * 1024 * 1024) { this.detach(viewer.ws, 1013); return }
    for (let offset = 0; offset < bytes.length; offset += 16384) { const chunk = Buffer.from(bytes.subarray(offset, offset + 16384)); viewer.queue.push(chunk); viewer.bytes += chunk.length }
    this.pump(viewer)
  }
  private pump(viewer: Viewer) {
    if (this.viewer !== viewer || viewer.ws.readyState !== WebSocket.OPEN) return
    while (viewer.queue.length && viewer.sent - viewer.ack + viewer.queue[0]!.length <= 256 * 1024 && viewer.ws.bufferedAmount < 256 * 1024) {
      const bytes = viewer.queue.shift()!; viewer.bytes -= bytes.length; viewer.sent += bytes.length
      viewer.ws.send(bytes, { binary: true }, error => { if (error) this.detach(viewer.ws); else this.pump(viewer) })
    }
    while(viewer.events.length&&viewer.events[0]!.after<=viewer.ack)viewer.ws.send(JSON.stringify(viewer.events.shift()!.value))
    if (this.ended && !viewer.queue.length && viewer.sent === viewer.ack) {
      viewer.ws.send(JSON.stringify({ type: 'terminal.exit', message: this.reason })); this.detach(viewer.ws)
    }
  }
  finish(reason: string) {
    if(this.finished)return this.finished
    this.finished=new Promise(resolve=>{this.resolveFinished=resolve})
    this.ended = true; this.reason = reason
    if (this.viewer) this.pump(this.viewer); else this.dispose()
    return this.finished
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; clearInterval(this.timer)
    this.pendingWrite?.();this.pendingWrite=undefined
    if (this.viewer) this.detach(this.viewer.ws)
    this.terminal.dispose()
    this.resolveFinished?.()
  }
}
