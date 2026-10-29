import { Service, type Context } from 'cordis'
import { requireConnectionCapacity } from '../core/connection-budget.ts'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Connection } from '@webnav/shared'
import { AppError, integer, publicError, record, string } from '../core/errors.ts'

export interface DeviceStream { input(message:Record<string,unknown>):void|Promise<void>; close():void; viewerVersion?:1 }
export type DeviceProvider=(options:{host:string;connection:Connection;password?:string;signal:AbortSignal;send:(message:Record<string,unknown>|Buffer)=>boolean;fail:(message:string)=>void})=>Promise<DeviceStream>
interface DeviceSession {id:string;owner:string;serverId:string;connectionId:string;protocol:string;token:string;expires:number;timer:ReturnType<typeof setTimeout>;abort:AbortController;ackTimer?:ReturnType<typeof setTimeout>;ws?:WebSocket;stream?:DeviceStream;closed:boolean;sequence:number;ack:number;inflight:Map<number,number>;bytes:number;pending:number;inputAt:number;inputCount:number;name:string;started?:boolean;info?:Record<string,unknown>}
declare module 'cordis' { interface Context { deviceSessions:DeviceSessionService } }

/** A single authenticated, ticket-bound device channel; providers never own browser sockets. */
export class DeviceSessionService extends Service {
  static inject=['storage','credentials','auth','desktops']
  private sessions=new Map<string,DeviceSession>()
  private providers=new Map<string,DeviceProvider>()
  get size(){return this.sessions.size}
  counts(){return {adb:[...this.sessions.values()].filter(s=>s.protocol==='adb'&&s.stream).length,wdb:[...this.sessions.values()].filter(s=>s.protocol==='wdb'&&s.stream).length}}
  list(owner:string){return [...this.sessions.values()].filter(s=>s.owner===owner&&['adb','wdb'].includes(s.protocol)).map(s=>({sessionId:s.id,serverId:s.serverId,connectionId:s.connectionId,protocol:s.protocol,name:s.name,connected:!!s.stream}))}
  ticket(owner:string,id:string){const s=this.owned(owner,id);this.ctx.credentials.requireUnlocked();s.token=randomBytes(32).toString('hex');s.expires=Date.now()+30_000;return {sessionId:id,attachToken:s.token}}
  constructor(ctx:Context){
    super(ctx,'deviceSessions',true)
    const timer=setInterval(()=>{for(const session of this.sessions.values())if(!ctx.auth.authorized(session.owner)||!ctx.credentials.status().unlocked)this.close(session.id,'连接授权已失效。')},1000)
    ctx.on('dispose',()=>{clearInterval(timer);for(const id of this.sessions.keys())this.close(id);this.providers.clear()})
  }
  register(protocol:string,provider:DeviceProvider){
    if(this.providers.has(protocol))throw new Error('Duplicate device provider')
    this.providers.set(protocol,provider)
    return()=>{this.providers.delete(protocol);for(const session of this.sessions.values())if(session.protocol===protocol)this.close(session.id,'设备插件已停止。')}
  }
  create(owner:string,serverId:string,connectionId:string){
    this.ctx.get('maintenance')?.requireAvailable()
    requireConnectionCapacity(this.ctx)
    this.ctx.credentials.requireUnlocked()
    const {server,connection}=this.ctx.storage.connection(serverId,connectionId)
    if(!this.providers.has(connection.type))throw new AppError('PLUGIN_UNAVAILABLE','设备插件不可用。')
    if(this.size+this.ctx.desktops.size>=4)throw new AppError('BUSY','最多同时打开 4 个桌面或设备画面。')
    const id=randomUUID(),token=randomBytes(32).toString('hex')
    this.sessions.set(id,{id,owner,serverId,connectionId,name:`${server.name} · ${connection.name}`,protocol:connection.type,token,expires:Date.now()+30_000,timer:setTimeout(()=>this.close(id,'设备未及时绑定。'),30_000),abort:new AbortController(),closed:false,sequence:0,ack:0,inflight:new Map(),bytes:0,pending:0,inputAt:0,inputCount:0})
    return {sessionId:id,attachToken:token,protocol:connection.type}
  }
  private owned(owner:string,id:string){const session=this.sessions.get(id);if(!session||session.owner!==owner)throw new AppError('NOT_FOUND','设备会话不存在。');return session}
  async attach(owner:string,ws:WebSocket,input:unknown){
    this.ctx.credentials.requireUnlocked()
    const p=record(input),s=this.owned(owner,string(p.sessionId)),token=string(p.attachToken)
    if(Date.now()>s.expires||! /^[a-f0-9]{64}$/.test(token)||token.length!==s.token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(s.token)))throw new AppError('UNAUTHORIZED','设备绑定票据无效或已使用。')
    s.token='';if(s.ws)this.detach(s,s.ws,4001)
    if(s.closed)throw new AppError('NOT_FOUND','此设备提供者不支持重新附着。')
    s.ws=ws
    ws.on('close',()=>this.detach(s,ws));ws.on('error',()=>ws.close())
    if(s.started){if(s.info)this.output(s,s.info);if(s.stream)this.output(s,{type:'device.ready',protocol:s.protocol});return}
    s.started=true;clearTimeout(s.timer);s.timer=setTimeout(()=>this.close(s.id,'设备连接超时。'),30_000)
    try{
      const {server,connection}=this.ctx.storage.connection(s.serverId,s.connectionId)
      if(connection.type!==s.protocol)throw new AppError('CONFLICT','连接配置已改变。')
      const provider=this.providers.get(s.protocol)
      if(!provider)throw new AppError('PLUGIN_UNAVAILABLE','设备插件不可用。')
      const stream=await provider({host:server.host,connection,password:s.protocol==='wdb'?this.ctx.credentials.desktopPassword(s.serverId,s.connectionId):undefined,signal:s.abort.signal,send:message=>this.output(s,message),fail:message=>this.close(s.id,message)})
      if(s.closed){stream.close();return}
      this.ctx.credentials.requireUnlocked();s.stream=stream;clearTimeout(s.timer)
      if(!s.ws){if(stream.viewerVersion!==1){this.close(s.id);return}await stream.input({type:'device.visible',visible:false})}
      this.output(s,{type:'device.ready',protocol:s.protocol})
    }catch(error){this.close(s.id,publicError(error).message)}
  }
  private output(s:DeviceSession,message:Record<string,unknown>|Buffer){
    if(!Buffer.isBuffer(message)&&message.type==='device.info')s.info={...s.info,...message}
    const ws=s.ws;if(s.closed)return false;if(ws?.readyState!==WebSocket.OPEN)return true
    if(Buffer.isBuffer(message)){
      // PNG frames can wait for ACK; H.264 callers stop rather than drop reference frames.
      if(s.inflight.size>=2||s.bytes+message.length>16*1024*1024||ws.bufferedAmount>2*1024*1024)return false
      const sequence=++s.sequence,frame=Buffer.allocUnsafe(message.length+4);frame.writeUInt32BE(sequence);message.copy(frame,4)
      s.inflight.set(sequence,message.length);s.bytes+=message.length;ws.send(frame,{binary:true})
      if(s.inflight.size===1){clearTimeout(s.ackTimer);s.ackTimer=setTimeout(()=>this.detach(s,ws,1013),15_000)}
    }else{
      if(ws.bufferedAmount>2*1024*1024){this.detach(s,ws,1013);return false}
      ws.send(JSON.stringify(message))
    }
    return true
  }
  async input(owner:string,id:string,ws:WebSocket,input:unknown){
    const s=this.owned(owner,id),message=record(input)
    if(s.ws!==ws)throw new AppError('UNAUTHORIZED','设备通道归属不正确。')
    if(message.type==='device.ack'){
      const sequence=integer(message.sequence,0,s.sequence)
      if(sequence<s.ack)throw new AppError('FLOW_CONTROL','设备确认序号不正确。')
      s.ack=sequence;for(const [id,size] of s.inflight)if(id<=sequence){s.inflight.delete(id);s.bytes-=size}
      if(!s.inflight.size)clearTimeout(s.ackTimer)
      return
    }
    this.ctx.credentials.requireUnlocked()
    if(!s.stream)throw new AppError('CONFLICT','设备尚未就绪。')
    if(Date.now()-s.inputAt>1000){s.inputAt=Date.now();s.inputCount=0}
    if(++s.inputCount>240||s.pending>=16)throw new AppError('FLOW_CONTROL','设备输入过快。')
    s.pending++;try{await s.stream.input(message)}finally{s.pending--}
  }
  private detach(s:DeviceSession,ws:WebSocket,code=1000){
    if(s.ws!==ws||s.closed)return
    s.ws=undefined;clearTimeout(s.ackTimer);s.inflight.clear();s.bytes=0;s.ack=s.sequence
    if(s.stream){
      if(s.stream.viewerVersion!==1){this.close(s.id);ws.close();return}
      try{void Promise.resolve(s.stream.input({type:'device.visible',visible:false})).catch(()=>this.close(s.id,'无法释放设备控制。'))}catch{this.close(s.id,'无法释放设备控制。')}
    }
    if(ws.readyState===WebSocket.OPEN)ws.close(code,code===4001?'此连接已在另一个页面打开':'')
  }
  closeAttached(owner:string,id:string,ws:WebSocket){const s=this.sessions.get(id);if(s?.owner===owner&&s.ws===ws)this.detach(s,ws)}
  closeOwned(owner:string,id:string){if(this.sessions.has(id)){this.owned(owner,id);this.close(id)}return {closed:true}}
  close(id:string,message='连接已结束。'){
    const s=this.sessions.get(id);if(!s||s.closed)return
    s.closed=true;this.sessions.delete(id);clearTimeout(s.timer);clearTimeout(s.ackTimer);s.abort.abort();s.stream?.close();s.inflight.clear();s.bytes=0
    if(s.ws?.readyState===WebSocket.OPEN){s.ws.send(JSON.stringify({type:'device.exit',message}));s.ws.close(1000)}
  }
}
