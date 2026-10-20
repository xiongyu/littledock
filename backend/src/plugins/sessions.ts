import { Service, type Context } from 'cordis'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { WebSocket } from 'ws'
import { AppError, integer, record, string } from '../core/errors.ts'

type Session = {
  id:string; owner:string; serverId:string; connectionId:string; token:string; expires:number;
  client?:Client; channel?:ClientChannel; ws?:WebSocket; timer:ReturnType<typeof setTimeout>;
  sent:number; ack:number; queue:Buffer[]; queued:number; closed:boolean; inputBytes:number; inputAt:number;
  pendingKey?:{ fingerprint:string; changed:boolean; decide:(valid:boolean)=>void };
  finished?:boolean
}
declare module 'cordis' { interface Context { sessions: SessionService; connectors: ConnectorService } }
export class ConnectorService extends Service {
  private handlers=new Map<string,(owner:string,serverId:string,connectionId:string)=>unknown>()
  constructor(ctx:Context){super(ctx,'connectors',true)}
  register(type:string,handler:(owner:string,serverId:string,connectionId:string)=>unknown){if(this.handlers.has(type))throw new Error('Duplicate connector');this.handlers.set(type,handler);return()=>this.handlers.delete(type)}
  open(type:string,owner:string,serverId:string,connectionId:string){const handler=this.handlers.get(type);if(!handler)throw new AppError('NOT_IMPLEMENTED','这个连接器尚未接入。');return handler(owner,serverId,connectionId)}
}
export class SessionService extends Service {
  static inject=['storage','credentials','terminalHistory','connectors','auth']
  private sessions=new Map<string,Session>()
  constructor(ctx:Context){
    super(ctx,'sessions',true)
    const unregister=ctx.connectors.register('ssh',(owner,serverId,connectionId)=>this.create(owner,serverId,connectionId))
    const check=setInterval(()=>{for(const session of this.sessions.values())if(!ctx.auth.authorized(session.owner))this.close(session.id,'浏览器授权已过期。')},15_000)
    ctx.on('dispose',()=>{unregister();clearInterval(check);for(const id of this.sessions.keys())this.close(id)})
  }
  create(owner:string,serverId:string,connectionId:string){
    this.ctx.credentials.requireUnlocked()
    this.ctx.storage.connection(serverId,connectionId)
    if(this.sessions.size>=8)throw new AppError('BUSY','最多同时打开 8 个 SSH 终端。')
    const id=randomUUID(),token=randomBytes(32).toString('hex')
    const session:Session={id,owner,serverId,connectionId,token,expires:Date.now()+30_000,timer:setTimeout(()=>this.close(id,'终端未及时绑定。'),30_000),sent:0,ack:0,queue:[],queued:0,closed:false,inputBytes:0,inputAt:Date.now()}
    this.sessions.set(id,session);return {sessionId:id,attachToken:token}
  }
  async attach(owner:string,ws:WebSocket,input:unknown){
    const params=record(input),id=string(params.sessionId),token=string(params.attachToken),cols=integer(params.cols??100,20,400),rows=integer(params.rows??30,5,200)
    const session=this.sessions.get(id)
    if(!session||session.owner!==owner||session.ws||Date.now()>session.expires||token.length!==session.token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(session.token)))throw new AppError('UNAUTHORIZED','终端绑定票据无效。')
    session.token='';session.ws=ws;clearTimeout(session.timer)
    session.timer=setTimeout(()=>this.close(id,'连接或认证等待超时。'),120_000)
    ws.on('close',()=>this.close(id));ws.on('error',()=>this.close(id))
    const {server,connection}=this.ctx.storage.connection(session.serverId,session.connectionId)
    if(!connection.username)throw new AppError('INVALID_ARGUMENT','请先在服务器编辑中填写 SSH 用户名。')
    const credentials=await this.ctx.credentials.resolve(session.serverId,session.connectionId)
    if(session.closed){credentials.privateKey?.fill(0);return}
    const client=new ssh2.Client();session.client=client
    const send=(data:unknown)=>this.send(session,data)
    const releaseKey=()=>credentials.privateKey?.fill(0)
    client.on('error',()=>{releaseKey();this.close(id,'SSH 连接或认证失败，请检查地址、用户名和认证信息。')})
    client.on('close',()=>{releaseKey();this.finish(session)})
    client.on('ready',()=>{
      releaseKey();clearTimeout(session.timer)
      client.shell({term:'xterm-256color',cols,rows},(error,channel)=>{
        if(error){this.close(id,'无法打开 SSH 终端。');return}
        if(session.closed){channel.close();return}
        session.channel=channel
        if(connection.saveHistory!==false){try{this.ctx.terminalHistory.open(id,server.id,server.name)}catch{send({type:'terminal.notice',message:'输出历史暂时无法保存。'})}}
        send({type:'terminal.ready'})
        const output=(bytes:Buffer)=>{
          if(session.closed)return
          this.ctx.terminalHistory.append(id,bytes)
          for(let offset=0;offset<bytes.length;offset+=16*1024){const chunk=Buffer.from(bytes.subarray(offset,offset+16*1024));session.queue.push(chunk);session.queued+=chunk.length}
          if(session.queued+session.sent-session.ack+(ws.bufferedAmount??0)>1024*1024){this.close(id,'终端输出超出缓冲上限。');return}
          channel.pause();channel.stderr.pause();this.pump(session)
        }
        channel.on('data',output);channel.stderr.on('data',output)
        channel.on('close',()=>{session.finished=true;this.finish(session)})
        channel.on('error',()=>this.close(id,'SSH 通道异常。'))
      })
    })
    const endpoint=JSON.stringify([server.host.replace(/^\[|\]$/g,''),connection.port])
    try{client.connect({host:server.host.replace(/^\[|\]$/g,''),port:connection.port,username:connection.username,...credentials,readyTimeout:120_000,keepaliveInterval:15_000,keepaliveCountMax:3,
      hostVerifier:(key:Buffer,verify:(accepted:boolean)=>void)=>{
        const fingerprint='SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')
        const known=this.ctx.storage.db.prepare('SELECT fingerprint FROM hostkeys WHERE endpoint=?').get(endpoint) as {fingerprint:string}|undefined
        if(known?.fingerprint===fingerprint){verify(true);return}
        const changed=!!known
        session.pendingKey={fingerprint,changed,decide:accepted=>{if(accepted)this.ctx.storage.db.prepare('INSERT OR REPLACE INTO hostkeys VALUES (?,?)').run(endpoint,fingerprint);verify(accepted)}}
        send({type:'terminal.hostkey',fingerprint,changed,previous:known?.fingerprint??'',host:server.host,port:connection.port})
      }
    })}catch{releaseKey();this.close(id,'SSH 参数或私钥不正确。')}
  }
  hostKey(owner:string,input:unknown){const params=record(input),session=this.owned(owner,string(params.sessionId)),pending=session.pendingKey;if(!pending)throw new AppError('CONFLICT','没有待确认指纹。');const accept=params.accept===true;if(accept&&string(params.fingerprint)!==pending.fingerprint)throw new AppError('INVALID_ARGUMENT','指纹不匹配。');if(accept&&pending.changed&&params.verifiedChange!==true)throw new AppError('HOSTKEY_CHANGED','主机指纹已改变，必须先核验。');session.pendingKey=undefined;pending.decide(accept);return {accepted:accept}}
  owned(owner:string,id:string){const session=this.sessions.get(id);if(!session||session.owner!==owner)throw new AppError('NOT_FOUND','终端不存在。');return session}
  control(owner:string,id:string,input:unknown){
    const session=this.owned(owner,id),params=record(input)
    if(params.type==='terminal.ack'){
      const ack=integer(params.parsedBytes,0,Number.MAX_SAFE_INTEGER)
      if(ack<session.ack||ack>session.sent)throw new AppError('FLOW_CONTROL','终端确认字节数不正确。')
      session.ack=ack;this.pump(session)
    }else if(params.type==='terminal.resize'){session.channel?.setWindow(integer(params.rows,5,200),integer(params.cols,20,400),0,0)}
    else throw new AppError('INVALID_ARGUMENT','未知终端消息。')
  }
  input(owner:string,id:string,bytes:Buffer){
    const session=this.owned(owner,id)
    if(!session.channel||session.finished)throw new AppError('CONFLICT','终端尚未就绪。')
    if(Date.now()-session.inputAt>1000){session.inputAt=Date.now();session.inputBytes=0}
    session.inputBytes+=bytes.length
    if(bytes.length>16*1024||session.inputBytes>128*1024||session.channel.writableLength>128*1024)throw new AppError('FLOW_CONTROL','输入过快，请分段粘贴。')
    session.channel.write(bytes)
  }
  private pump(session:Session){
    const ws=session.ws;if(!ws||ws.readyState!==WebSocket.OPEN||session.closed)return
    while(session.queue.length && session.sent-session.ack+session.queue[0]!.length<=256*1024 && ws.bufferedAmount<256*1024){
      const chunk=session.queue.shift()!;session.queued-=chunk.length;session.sent+=chunk.length
      ws.send(chunk,{binary:true},error=>{if(error)this.close(session.id);else this.pump(session)})
    }
    if(!session.queue.length&&session.sent-session.ack<256*1024&&!session.finished){session.channel?.resume();session.channel?.stderr.resume()}
    if(session.finished&&!session.queue.length&&session.sent===session.ack)this.close(session.id)
    else if(session.sent>session.ack){clearTimeout(session.timer);session.timer=setTimeout(()=>this.close(session.id,'终端长时间未确认输出。'),30_000)}
    else clearTimeout(session.timer)
  }
  private finish(session:Session){if(session.closed)return;session.finished=true;if(session.channel){this.pump(session)}else this.close(session.id)}
  private send(session:Session,data:unknown){if(session.ws?.readyState===WebSocket.OPEN)session.ws.send(JSON.stringify(data))}
  close(id:string,reason='连接已结束。'){
    const session=this.sessions.get(id);if(!session||session.closed)return;session.closed=true;this.sessions.delete(id);clearTimeout(session.timer)
    session.pendingKey?.decide(false);session.pendingKey=undefined
    try{this.ctx.terminalHistory.close(id)}catch{}
    this.send(session,{type:'terminal.exit',message:reason});session.ws?.close(1000);session.channel?.destroy();session.client?.destroy();session.queue=[];session.queued=0
  }
  closeOwned(owner:string,id:string){this.owned(owner,id);this.close(id);return {closed:true}}
}
