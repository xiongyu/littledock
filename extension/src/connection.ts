import { extensionCipher, extensionProof, extensionRecord, extensionString, extensionTranscript, randomExtensionNonce, verifyExtensionProof, type ExtensionPairing } from '@webnav/shared'

export class LocalConnection {
  private socket?: WebSocket
  private cipher?: Awaited<ReturnType<typeof extensionCipher>>
  private connecting?: Promise<void>
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private outgoing = Promise.resolve()
  private incoming = Promise.resolve()
  private heartbeat?: ReturnType<typeof setInterval>
  generation = 0
  constructor(private pairing: ExtensionPairing, private origin: string) {}
  close(message = '与小站的连接已断开，请重新操作。') {
    this.generation++
    const ws = this.socket; this.socket = undefined; this.cipher = undefined; clearInterval(this.heartbeat)
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.pending.clear()
  }
  authorized(generation: number) { return this.generation === generation && this.socket?.readyState === WebSocket.OPEN && !!this.cipher }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN && this.cipher) return
    if (this.connecting) return this.connecting
    this.connecting = this.handshake()
    try { await this.connecting } finally { this.connecting = undefined }
  }
  private async handshake(): Promise<void> {
    this.close()
    this.incoming = Promise.resolve(); this.outgoing = Promise.resolve()
    const ws = new WebSocket(this.pairing.endpoint); this.socket = ws
    return new Promise<void>((resolve, reject) => {
      let done = false, transcript = '', stage: 'challenge' | 'proof' | 'ready' = 'challenge'
      const fail = (message: string) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(message)) } if (this.socket === ws) this.close(message) }
      const timer = setTimeout(() => fail('小站连接超时，请确认本机服务已启动。'), 10_000)
      ws.onerror = () => fail('无法连接本机小站，请确认服务已启动。')
      ws.onclose = () => fail('小站已锁定、授权被撤销或连接已断开。请解锁后重新操作。')
      ws.onmessage = event => {
        this.incoming = this.incoming.then(async () => {
          if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return
          if (typeof event.data !== 'string' || event.data.length > 36_000) throw new Error('扩展响应超出限制。')
          const message = extensionRecord(JSON.parse(event.data))
          if (message.type === 'unavailable') throw new Error('请先打开小站，输入主密码解锁。')
          if (stage === 'challenge') {
            if (message.v !== 1 || message.type !== 'challenge' || message.serverId !== this.pairing.serverId) throw new Error('本机服务身份不匹配，请在小站重新配对。')
            const nonce = randomExtensionNonce()
            transcript = extensionTranscript(this.pairing.serverId, this.pairing.endpoint, this.origin, this.pairing.id, extensionString(message.nonce, 43), nonce)
            const proof = await extensionProof(this.pairing.key, transcript, 'client')
            if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return
            stage = 'proof'; ws.send(JSON.stringify({ v: 1, type: 'authenticate', id: this.pairing.id, nonce, proof })); return
          }
          if (stage === 'proof') {
            if (message.v !== 1 || message.type !== 'authenticated' || !await verifyExtensionProof(this.pairing.key, transcript, 'server', extensionString(message.proof, 43))) throw new Error('本机服务身份验证失败。')
            const cipher = await extensionCipher(this.pairing.key, transcript, 'client')
            if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return
            this.cipher = cipher; stage = 'ready'; done = true; clearTimeout(timer)
            this.heartbeat = setInterval(() => { void this.request('ping', {}).catch(() => {}) }, 20_000)
            resolve(); return
          }
          const response = await this.cipher!.open(message), id = extensionString(response.id, 100), pending = this.pending.get(id)
          if (!pending) return
          clearTimeout(pending.timer); this.pending.delete(id)
          if (response.ok === true) pending.resolve(response.result)
          else { const error = extensionRecord(response.error); pending.reject(new Error(extensionString(error.message, 500))) }
        }).catch(cause => fail(cause instanceof Error ? cause.message : '扩展认证失败。'))
      }
    })
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connect()
    if (this.pending.size >= 8) throw new Error('请求过多，请稍后再试。')
    const ws = this.socket!, cipher = this.cipher!, id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时，结果未知。请重新查看状态；不会自动重试。')); this.close() }, 8000)
      this.pending.set(id, { resolve, reject, timer })
      this.outgoing = this.outgoing.then(async () => {
        const encrypted = await cipher.seal({ id, method, params })
        if (this.socket !== ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64_000) throw new Error('连接已改变，请重新操作。')
        ws.send(JSON.stringify(encrypted))
      }).catch(() => this.close())
    })
  }
}
