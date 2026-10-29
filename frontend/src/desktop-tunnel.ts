
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import Guacamole from 'guacamole-common-js'
import { GuacamoleDecoder, guacamoleInstruction, parseRdpCertificateChallenge, type RdpCertificateChallenge } from '@webnav/shared'

export interface DesktopAttachment { sessionId: string; attachToken: string; width: number; height: number }
export interface RdpFrameTiming { renderedAt: number; renderMs: number; bridgeMs: number; sourceUpdates: number; sourceFrames: number }

/** The local backend owns target selection and authentication. This tunnel only carries display/input. */
export class DesktopTunnel extends Guacamole.Tunnel {
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private url: string
  private attachment: DesktopAttachment
  private certificateRequest?: string
  private frames = new Map<string, { receivedAt: number; timing: number[] }>()
  private imagePendingAt?: number
  private timing: number[] = [0, 0, 0, 0]
  oncertificate?: (certificate: RdpCertificateChallenge) => void
  onframe?: (timing: RdpFrameTiming) => void
  constructor(url: string, attachment: DesktopAttachment) { super(); this.url = url; this.attachment = attachment }
  private transition(state: Guacamole.Tunnel.State) {
    if (this.state === state) return
    this.state = state; this.onstatechange?.(state)
  }
  private fail(message: string) {
    if (this.disposed) return
    this.onerror?.(new Guacamole.Status(Guacamole.Status.Code.SERVER_ERROR, message))
    this.disconnect()
  }
  connect = () => {
    if (this.socket || this.disposed) return
    this.transition(Guacamole.Tunnel.State.CONNECTING)
    const socket = this.socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    const decoder = new TextDecoder('utf-8', { fatal: true }), parser = new GuacamoleDecoder()
    const instruction = ([opcode, ...args]: string[]) => {
      if (opcode === 'webnav-frame') {
        const values = args.map(Number)
        if (values.length !== 4 || values.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) { this.fail(i18nT('mf10bc4270ab8')); return }
        this.timing = values; return
      }
      if (opcode === 'img' && args[2] === '0' && this.imagePendingAt === undefined) this.imagePendingAt = performance.now()
      if (opcode === 'sync' && this.imagePendingAt !== undefined) {
        if (this.frames.size >= 4) { this.fail(i18nT('m840795a3686d')); return }
        this.frames.set(String(args[0]), { receivedAt: this.imagePendingAt, timing: this.timing }); this.imagePendingAt = undefined
      }
      this.oninstruction?.(opcode!, args)
    }
    this.timer = setTimeout(() => this.fail(i18nT('mfdbe8f17fffa')), 35_000)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'desktop.attach', ...this.attachment }))
    socket.onmessage = event => {
      if (this.disposed) return
      try {
        if (event.data instanceof ArrayBuffer) { parser.push(decoder.decode(event.data, { stream: true }), instruction); return }
        const message = JSON.parse(String(event.data)) as Record<string, unknown>
        if (message.type === 'desktop.bound') { clearTimeout(this.timer); this.transition(Guacamole.Tunnel.State.OPEN) }
        else if (message.type === 'desktop.certificate') {
          if (this.certificateRequest || !this.oncertificate) { this.fail(i18nT('m4381c9647cb7')); return }
          const certificate = parseRdpCertificateChallenge(message)
          this.certificateRequest = certificate.requestId; clearTimeout(this.timer)
          this.timer = setTimeout(() => this.fail(i18nT('mdf7378de1faa')), 125_000)
          this.oncertificate(certificate)
        }
        else if (message.type === 'desktop.error') this.fail(typeof message.message === 'string' ? message.message : i18nT('ma66780ccc147'))
        else this.fail(i18nT('m67179a0fd4c3'))
      } catch { this.fail(i18nT('mbf8a2b2e98af')) }
    }
    socket.onerror = () => this.fail(i18nT('mf4b8e419214a'))
    socket.onclose = () => this.disconnect()
  }
  answerCertificate(requestId: string, accept: boolean): boolean {
    if (this.disposed || this.certificateRequest !== requestId || this.socket?.readyState !== WebSocket.OPEN) return false
    this.certificateRequest = undefined; clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fail(i18nT('mfdbe8f17fffa')), 35_000)
    this.socket.send(JSON.stringify({ type: 'desktop.certificateDecision', requestId, accept }))
    return true
  }
  sendMessage = (...elements: unknown[]) => {
    if (!this.isConnected() || this.socket?.readyState !== WebSocket.OPEN) return
    const bytes = new TextEncoder().encode(guacamoleInstruction(...elements.map(String)))
    if (bytes.length > 64 * 1024 || this.socket.bufferedAmount + bytes.length > 1024 * 1024) { this.fail(i18nT('m383e034892dc')); return }
    this.socket.send(bytes)
    if (elements[0] === 'sync') {
      const id = String(elements[1]), frame = this.frames.get(id)
      if (frame) {
        this.frames.delete(id); const renderedAt = performance.now()
        this.onframe?.({ renderedAt, renderMs: renderedAt - frame.receivedAt, bridgeMs: frame.timing[1]! / 1000, sourceUpdates: frame.timing[2]!, sourceFrames: frame.timing[3]! })
      }
    }
  }
  disconnect = () => {
    if (this.disposed) return
    this.disposed = true; this.certificateRequest = undefined; this.frames.clear(); this.onframe = undefined; clearTimeout(this.timer)
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close() }
    this.transition(Guacamole.Tunnel.State.CLOSED)
  }
}
