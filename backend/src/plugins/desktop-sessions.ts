import { Service, type Context } from 'cordis'
import { requireConnectionCapacity } from '../core/connection-budget.ts'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { GuacamoleDecoder, guacamoleInstruction, DEFAULT_BROWSER_RDP_DISPLAY, type Connection, type RdpCertificateChange } from '@webnav/shared'
import { AppError, integer, publicError, record, string } from '../core/errors.ts'
import { connectDesktopSocket } from './desktop-socket.ts'
import { authenticateVnc } from './vnc-auth.ts'
import type { DesktopStream } from '../core/desktop-stream.ts'
import { persistentVnc } from './vnc-stream.ts'

export type DesktopProvider = (options: { host: string; connection: Connection; password?: string; width: number; height: number; signal: AbortSignal; confirmCertificate: (certificate: RdpCertificateChange) => Promise<boolean> }) => Promise<Duplex>

type DesktopSession = {
  id: string; owner: string; serverId: string; connectionId: string; protocol: 'rdp' | 'vnc';
  token: string; expires: number; timer: ReturnType<typeof setTimeout>; abort: AbortController;
  socket?: DesktopStream; ws?: WebSocket; bound: boolean; closed: boolean; phase: 'connecting' | 'version' | 'security' | 'init' | 'streaming';
  handshake: Buffer; parser: GuacamoleDecoder; inputBytes: number; inputAt: number;
  certificate?: { requestId: string; resolve: (accepted: boolean) => void; message:Record<string,unknown> };
  started?: boolean; name:string; keys:Set<string>; mouse?:string[];
}
declare module 'cordis' { interface Context { desktops: DesktopSessionService } }

export class DesktopSessionService extends Service {
  static inject = ['storage', 'credentials', 'connectors', 'auth']
  private sessions = new Map<string, DesktopSession>()
  get size(){return this.sessions.size}
  counts(){return {rdp:[...this.sessions.values()].filter(s=>s.protocol==='rdp'&&s.bound).length,vnc:[...this.sessions.values()].filter(s=>s.protocol==='vnc'&&s.bound).length}}
  list(owner:string){return [...this.sessions.values()].filter(s=>s.owner===owner).map(s=>({sessionId:s.id,serverId:s.serverId,connectionId:s.connectionId,protocol:s.protocol,name:s.name,connected:s.bound}))}
  ticket(owner:string,id:string){const s=this.owned(owner,id);this.ctx.credentials.requireUnlocked();s.token=randomBytes(32).toString('hex');s.expires=Date.now()+30_000;return {sessionId:id,attachToken:s.token}}
  private providers = new Map<'rdp', DesktopProvider>()
  constructor(ctx: Context) {
    super(ctx, 'desktops', true)
    const vnc = ctx.connectors.register('vnc', (owner, server, connection) => this.create(owner, server, connection))
    const expiry = setInterval(() => { for (const session of this.sessions.values()) if (!ctx.auth.authorized(session.owner)) this.close(session.id, '本机会话已过期。') }, 15_000)
    ctx.on('dispose', () => { vnc(); clearInterval(expiry); for (const id of this.sessions.keys()) this.close(id); this.providers.clear() })
  }
  register(protocol: 'rdp', provider: DesktopProvider) {
    if (this.providers.has(protocol)) throw new Error(`Duplicate desktop provider: ${protocol}`)
    this.providers.set(protocol, provider)
    return () => {
      if (this.providers.get(protocol) !== provider) return
      this.providers.delete(protocol)
      for (const session of this.sessions.values()) if (session.protocol === protocol) this.close(session.id, '桌面插件已停止。')
    }
  }
  create(owner: string, serverId: string, connectionId: string) {
    this.ctx.get('maintenance')?.requireAvailable()
    requireConnectionCapacity(this.ctx)
    this.ctx.credentials.requireUnlocked()
    const { server, connection } = this.ctx.storage.connection(serverId, connectionId)
    if (connection.type !== 'rdp' && connection.type !== 'vnc') throw new AppError('INVALID_ARGUMENT', '不是网页桌面入口。')
    if (connection.type === 'rdp' && connection.rdpDisplay?.mode === 'multimon') throw new AppError('DISPLAY_MODE', '网页桌面不支持系统多屏模式，请选择窗口、单屏全屏或使用系统 RDP。')
    if (connection.rdpDisplay?.mode === 'windowed' && (connection.rdpDisplay.width > 4096 || connection.rdpDisplay.height > 2160)) throw new AppError('DISPLAY_MODE', '网页 RDP 最大分辨率为 4096 × 2160，更大分辨率请使用系统客户端。')
    if (this.sessions.size >= 4) throw new AppError('BUSY', '最多同时打开 4 个网页桌面，请先关闭一个。')
    const id = randomUUID(), token = randomBytes(32).toString('hex')
    this.sessions.set(id, { id, owner, serverId, connectionId, name:`${server.name} · ${connection.name}`,keys:new Set(),protocol: connection.type, token, expires: Date.now() + 30_000,
      timer: setTimeout(() => this.close(id, '桌面未及时绑定。'), 30_000), abort: new AbortController(), bound: false, closed: false, phase: 'connecting',
      handshake: Buffer.alloc(0), parser: new GuacamoleDecoder(), inputBytes: 0, inputAt: Date.now() })
    return { sessionId: id, attachToken: token, protocol: connection.type }
  }
  private owned(owner: string, id: string) {
    const session = this.sessions.get(id)
    if (!session || session.owner !== owner) throw new AppError('NOT_FOUND', '网页桌面不存在。')
    return session
  }
  async attach(owner: string, ws: WebSocket, input: unknown) {
    this.ctx.credentials.requireUnlocked()
    const params = record(input), id = string(params.sessionId), token = string(params.attachToken)
    const session = this.owned(owner, id)
    if (Date.now() > session.expires || !/^[a-f0-9]{64}$/.test(token) || token.length !== session.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))) throw new AppError('UNAUTHORIZED', '桌面绑定票据无效或已使用。')
    const size = { width: integer(params.width ?? 1280, 200, 4096), height: integer(params.height ?? 720, 200, 2160) }
    session.token = ''
    if(session.ws)this.detach(session,session.ws,4001)
    if(session.closed)throw new AppError('NOT_FOUND','此桌面提供者不支持重新附着。')
    if(session.bound)session.socket?.setViewer?.(true)
    session.ws=ws;session.parser=new GuacamoleDecoder()
    ws.on('close', () => this.detach(session,ws)); ws.on('error', () => ws.close())
    if(session.started){if(session.bound)this.bound(session);else if(session.certificate)ws.send(JSON.stringify(session.certificate.message));return}
    session.started=true;clearTimeout(session.timer)
    session.timer = setTimeout(() => this.close(id, '远程桌面连接或认证超时。'), 30_000)
    try {
      const { server, connection } = this.ctx.storage.connection(session.serverId, session.connectionId)
      if (connection.type !== session.protocol) throw new AppError('CONFLICT', '连接配置已改变，请重新打开。')
      let password = this.ctx.credentials.desktopPassword(session.serverId, session.connectionId)
      try {
        if (session.protocol === 'rdp') {
          const provider = this.providers.get('rdp')
          if (!provider) throw new AppError('RDP_UNAVAILABLE', '网页 RDP 插件未启用。')
          const savedDisplay = connection.rdpDisplay ?? DEFAULT_BROWSER_RDP_DISPLAY
          const display = savedDisplay.mode === 'windowed' ? savedDisplay : size
          session.socket = await provider({ host: server.host.replace(/^\[|\]$/g, ''), connection, password, width: display.width, height: display.height, signal: session.abort.signal,
            confirmCertificate: certificate => this.confirmCertificate(session, server.host, connection.port, certificate) })
        } else {
          const socket: Socket = await connectDesktopSocket(server.host.replace(/^\[|\]$/g, ''), connection.port, session.abort.signal)
          session.socket = socket
          await authenticateVnc(socket, password)
          session.socket=await persistentVnc(socket)
        }
        if (session.closed || !this.ctx.auth.authorized(owner)) { session.socket.destroy(); this.close(id); return }
        this.ctx.credentials.requireUnlocked()
        session.socket.on('close', () => this.close(id)); session.socket.on('error', () => this.close(id, '远程桌面网络连接中断。'))
        session.bound = true; clearTimeout(session.timer)
        session.socket.on('data', bytes => this.output(session, bytes as Buffer))
        if(session.ws?.readyState===WebSocket.OPEN)this.bound(session)
        else if(session.socket.viewerVersion===1){session.socket.setViewer?.(false);session.socket.resume()}
        else this.close(id)
      } finally { password = undefined }
    } catch (cause) { this.close(id, publicError(cause).message) }
  }
  private bound(session:DesktopSession){
    const ws=session.ws;if(!ws||ws.readyState!==WebSocket.OPEN)return
    ws.send(JSON.stringify({type:'desktop.bound',protocol:session.protocol}))
    if(session.protocol==='vnc'){session.phase='version';session.handshake=Buffer.alloc(0);ws.send(Buffer.from('RFB 003.008\n'),{binary:true});session.timer=setTimeout(()=>this.detach(session,ws),10_000)}
    else {session.phase='streaming';session.socket?.resume()}
  }
  private detach(session:DesktopSession,ws:WebSocket,code=1000){
    if(session.ws!==ws||session.closed)return
    session.ws=undefined;session.parser=new GuacamoleDecoder()
    if(session.socket&&!session.socket.destroyed&&session.protocol==='rdp'){
      for(const key of session.keys)session.socket.write(guacamoleInstruction('key',key,0))
      if(session.mouse)session.socket.write(guacamoleInstruction('mouse',session.mouse[0]!,session.mouse[1]!,0))
    }
    session.keys.clear();session.mouse=undefined
    if(session.bound){
      clearTimeout(session.timer)
      if(session.socket?.viewerVersion!==1){this.close(session.id);ws.close();return}
      session.socket.setViewer?.(false);session.socket.resume()
    }
    if(ws.readyState===WebSocket.OPEN)ws.close(code,code===4001?'此连接已在另一个页面打开':'')
  }
  private confirmCertificate(session: DesktopSession, host: string, port: number, certificate: RdpCertificateChange): Promise<boolean> {
    if (session.closed || session.bound || session.certificate) return Promise.resolve(false)
    clearTimeout(session.timer)
    session.timer = setTimeout(() => this.close(session.id, '证书更新确认已超时，连接已停止。'), 120_000)
    return new Promise(resolve => {
      const requestId = randomUUID()
      const message={type:'desktop.certificate',requestId,host,port,...certificate}
      session.certificate = { requestId, resolve, message }
      if(session.ws?.readyState===WebSocket.OPEN)session.ws.send(JSON.stringify(message))
    })
  }
  control(owner: string, id: string, ws: WebSocket, input: unknown) {
    this.ctx.credentials.requireUnlocked()
    const session = this.owned(owner, id), message = record(input), pending = session.certificate
    if (session.ws !== ws || session.bound || !pending || message.type !== 'desktop.certificateDecision' || message.requestId !== pending.requestId || typeof message.accept !== 'boolean') throw new AppError('CONFLICT', '证书确认已失效，请重新连接。')
    session.certificate = undefined; clearTimeout(session.timer)
    session.timer = setTimeout(() => this.close(id, '远程桌面连接或认证超时。'), 30_000)
    pending.resolve(message.accept)
  }
  input(owner: string, id: string, bytes: Buffer, ws?:WebSocket) {
    const session = this.owned(owner, id), socket = session.socket
    if(ws&&session.ws!==ws)throw new AppError('READ_ONLY','此桌面已在另一个页面打开。')
    if (!session.bound || !socket || session.closed) throw new AppError('CONFLICT', '桌面尚未就绪。')
    if (Date.now() - session.inputAt >= 1000) { session.inputAt = Date.now(); session.inputBytes = 0 }
    session.inputBytes += bytes.length
    if (bytes.length > 64 * 1024 || session.inputBytes > 1024 * 1024 || socket.writableLength > 1024 * 1024) throw new AppError('FLOW_CONTROL', '桌面输入超过缓冲上限。')
    if (session.protocol === 'rdp') {
      // Never allow connection arguments, credentials or new targets from the browser.
      const decoder = new TextDecoder('utf-8', { fatal: true })
      session.parser.push(decoder.decode(bytes), values => {
        if(ws&&session.ws!==ws)return
        const opcode = values[0]
        if (!opcode || !['sync', 'key', 'mouse', 'size', 'clipboard', 'blob', 'end', 'ack', 'disconnect', 'nop'].includes(opcode)) throw new AppError('INVALID_ARGUMENT', '不支持的桌面输入。')
        if (opcode === 'size') { integer(Number(values[1]), 200, 4096); integer(Number(values[2]), 200, 2160) }
        if(opcode==='disconnect'){if(session.ws)this.detach(session,session.ws);return}
        if(opcode==='key'){const key=String(integer(Number(values[1]),0,0x1fffffff));if(integer(Number(values[2]),0,1))session.keys.add(key);else session.keys.delete(key);if(session.keys.size>256)throw new AppError('LIMIT','按键状态超限。')}
        if(opcode==='mouse')session.mouse=values.slice(1,3)
        socket.write(guacamoleInstruction(...values))
      })
      return
    }
    if (session.phase === 'streaming') { socket.write(bytes); return }
    session.handshake = Buffer.concat([session.handshake, bytes])
    if (session.handshake.length > 1024) throw new AppError('INVALID_ARGUMENT', '网页 VNC 握手数据过长。')
    if (session.phase === 'version' && session.handshake.length >= 12) {
      if (session.handshake.subarray(0, 12).toString() !== 'RFB 003.008\n') throw new AppError('INVALID_ARGUMENT', '网页 VNC 版本不正确。')
      session.handshake = session.handshake.subarray(12); session.phase = 'security'; session.ws!.send(Buffer.from([1, 1]))
    }
    if (session.phase === 'security' && session.handshake.length >= 1) {
      if (session.handshake[0] !== 1) throw new AppError('INVALID_ARGUMENT', '网页 VNC 握手不正确。')
      session.handshake = session.handshake.subarray(1); session.phase = 'init'; session.ws!.send(Buffer.alloc(4))
    }
    if (session.phase === 'init' && session.handshake.length >= 1) {
      clearTimeout(session.timer); session.phase = 'streaming'; socket.write(session.handshake); session.handshake = Buffer.alloc(0); socket.resume()
    }
  }
  private output(session: DesktopSession, bytes: Buffer) {
    const ws = session.ws, socket = session.socket
    if (session.closed || !socket) return
    if(!ws||ws.readyState!==WebSocket.OPEN){socket.resume();return}
    socket.pause()
    if (ws.bufferedAmount + bytes.length > 4 * 1024 * 1024) { this.detach(session,ws,1013); return }
    ws.send(bytes, { binary: true }, error => { if (error) this.detach(session,ws); if (!session.closed) socket.resume() })
  }
  closeOwned(owner: string, id: string) { if (this.sessions.has(id)) { this.owned(owner, id); this.close(id) }; return { closed: true } }
  closeAttached(owner: string, id: string, ws: WebSocket) {
    const session = this.sessions.get(id)
    if (session?.owner === owner && session.ws === ws) this.detach(session,ws)
  }
  close(id: string, reason = '连接已结束。') {
    const session = this.sessions.get(id)
    if (!session || session.closed) return
    session.closed = true; this.sessions.delete(id); clearTimeout(session.timer); session.certificate?.resolve(false); session.certificate = undefined; session.abort.abort(); session.socket?.destroy(); session.handshake = Buffer.alloc(0)
    if (session.ws?.readyState === WebSocket.OPEN) {
      if (!session.bound || session.protocol === 'rdp') session.ws.send(JSON.stringify({ type: 'desktop.error', message: reason }))
      session.ws.close(1000)
    }
  }
}
