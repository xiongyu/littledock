import { Service, type Context } from 'cordis'
import { requireConnectionCapacity } from '../core/connection-budget.ts'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { WebSocket } from 'ws'
import { AppError, integer, record, string } from '../core/errors.ts'
import { TerminalDirectoryTracker } from '../core/terminal-directory.ts'
import { PersistentTerminal } from '../core/persistent-terminal.ts'
import { credentialKey } from './storage.ts'
import type { TerminalProcess, TerminalProvider } from '../core/terminal-provider.ts'

type Session = {
  id:string; owner:string; serverId:string; connectionId:string; token:string; expires:number;
  client?:Client; channel?:ClientChannel; ws?:WebSocket; timer:ReturnType<typeof setTimeout>;
  sent:number; ack:number; queue:Buffer[]; queued:number; closed:boolean; inputBytes:number; inputAt:number;
  pendingKey?:{ fingerprint:string; changed:boolean; decide:(valid:boolean)=>void };
  finished?:boolean; directory?:TerminalDirectoryTracker; process?:TerminalProcess; abort?:AbortController; protocol:string
  managed?: ManagedTerminal; parsing?: boolean; terminal?: PersistentTerminal; connected?: boolean; name:string
  hostKeyMessage?: unknown
}
/** Backend-owned PTY. Its parser, not a browser, acknowledges output. */
export interface ManagedTerminal {
  authorized(): boolean
  output(bytes: Buffer): Promise<void>
  event(data: unknown): void
  closed(reason: string): void
}
declare module 'cordis' { interface Context { sessions: SessionService; connectors: ConnectorService } }
export class ConnectorService extends Service {
  static inject = { storage: { required: false } }
  private handlers=new Map<string,Map<string,(owner:string,serverId:string,connectionId:string)=>unknown>>()
  private providers:Record<string,string>={}
  private pluginWaits:Record<string,string>={}
  constructor(ctx:Context){super(ctx,'connectors',true)}
  configure(providers:Record<string,string>){this.providers={...providers}}
  setPluginWaits(waits:Record<string,string>){this.pluginWaits={...waits}}
  register(type:string,handler:(owner:string,serverId:string,connectionId:string)=>unknown,provider='builtin'){const entries=this.handlers.get(type)??new Map();if(entries.has(provider))throw new Error('Duplicate connector');entries.set(provider,handler);this.handlers.set(type,entries);return()=>{if(entries.get(provider)===handler)entries.delete(provider);if(!entries.size)this.handlers.delete(type)}}
  open(type:string,owner:string,serverId:string,connectionId:string,provider?:string){
    this.ctx.get('maintenance')?.requireAvailable()
    const bindings = JSON.parse(this.ctx.storage?.getSetting('sync-bindings') ?? '[]') as string[]
    if(bindings.includes(credentialKey(serverId,connectionId)))throw new AppError('LOCAL_BINDING_REQUIRED','此入口由云端恢复，请检查本机路径或设备，然后在全局设置的“配置同步”中确认本机绑定。')
    const selected=provider??this.providers['connector:'+type]??'builtin',waiting=this.pluginWaits['provider:'+selected]??this.pluginWaits['type:'+type];if(waiting)throw new AppError('PLUGIN_DRAINING',waiting+' 暂不接受新连接。')
    const handler=this.handlers.get(type)?.get(selected);if(!handler)throw new AppError(selected==='builtin'?'NOT_IMPLEMENTED':'PLUGIN_UNAVAILABLE','此连接入口的插件未安装、未启用或不可用，请在插件中心检查。原有配置已保留。');return handler(owner,serverId,connectionId)
  }
}
export class SessionService extends Service {
  static inject=['storage','credentials','terminalHistory','connectors','auth']
  private sessions=new Map<string,Session>()
  get size(){return this.sessions.size}
  counts(){return {ssh:[...this.sessions.values()].filter(s=>s.protocol==='ssh'&&s.connected).length,local:[...this.sessions.values()].filter(s=>s.protocol==='local'&&s.connected).length}}
  list(owner:string){return [...this.sessions.values()].filter(s=>s.owner===owner&&!s.managed&&(s.protocol==='ssh'||s.protocol==='local')).map(s=>({sessionId:s.id,serverId:s.serverId,connectionId:s.connectionId,protocol:s.protocol,name:s.name,connected:!!s.connected}))}
  ticket(owner:string,id:string){const s=this.owned(owner,id);if(s.managed)throw new AppError('FORBIDDEN','AI 会话使用独立观察入口。');this.ctx.credentials.requireUnlocked();s.token=randomBytes(32).toString('hex');s.expires=Date.now()+30_000;return {sessionId:id,attachToken:s.token}}
  private providers=new Map<string,TerminalProvider>()
  register(protocol:string,provider:TerminalProvider){
    if(protocol==='ssh'||this.providers.has(protocol))throw new Error('Duplicate terminal provider')
    this.providers.set(protocol,provider)
    return()=>{this.providers.delete(protocol);for(const session of this.sessions.values())if(session.protocol===protocol)this.close(session.id,'终端插件已停止。')}
  }
  constructor(ctx:Context){
    super(ctx,'sessions',true)
    const unregister=ctx.connectors.register('ssh',(owner,serverId,connectionId)=>this.create(owner,serverId,connectionId))
    const check=setInterval(()=>{for(const session of this.sessions.values())if(!(session.managed?session.managed.authorized():ctx.auth.authorized(session.owner)))this.close(session.id,'会话授权已过期。')},15_000)
    ctx.on('dispose',()=>{unregister();clearInterval(check);for(const id of this.sessions.keys())this.close(id)})
  }
  create(owner:string,serverId:string,connectionId:string){
    this.ctx.get('maintenance')?.requireAvailable()
    this.ctx.credentials.requireUnlocked()
    const {server,connection}=this.ctx.storage.connection(serverId,connectionId)
    if(connection.type!=='ssh'&&!this.providers.has(connection.type))throw new AppError('PLUGIN_UNAVAILABLE','终端插件不可用。')
    requireConnectionCapacity(this.ctx)
    const id=randomUUID(),token=randomBytes(32).toString('hex')
    const session:Session={id,owner,serverId,connectionId,name:`${server.name} · ${connection.name}`,token,protocol:connection.type,expires:Date.now()+30_000,timer:setTimeout(()=>this.close(id,'终端未及时绑定。'),30_000),sent:0,ack:0,queue:[],queued:0,closed:false,inputBytes:0,inputAt:Date.now()}
    this.sessions.set(id,session);return {sessionId:id,attachToken:token}
  }
  async attach(owner:string,ws:WebSocket,input:unknown){
    this.ctx.credentials.requireUnlocked()
    const params=record(input),id=string(params.sessionId),token=string(params.attachToken),cols=integer(params.cols??100,20,400),rows=integer(params.rows??30,5,200)
    const session=this.sessions.get(id)
    if(!session||session.owner!==owner||session.managed||!token||Date.now()>session.expires||token.length!==session.token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(session.token)))throw new AppError('UNAUTHORIZED','终端绑定票据无效。')
    session.token=''
    const started=!!session.terminal
    if(session.ws){session.terminal?.detach(session.ws,4001);session.ws.close(4001,'此连接已在另一个页面打开')}
    session.ws=ws
    if(!session.terminal)session.terminal=new PersistentTerminal(cols,rows,bytes=>this.input(owner,id,bytes))
    ws.on('close',()=>{if(session.ws===ws)session.ws=undefined;session.terminal?.detach(ws)})
    ws.on('error',()=>ws.close())
    await session.terminal.attach(ws)
    if(session.closed)return
    if(started){if(session.connected)this.send(session,{type:'terminal.ready'});else if(session.hostKeyMessage)this.send(session,session.hostKeyMessage);return}
    clearTimeout(session.timer)
    session.timer=setTimeout(()=>this.close(id,'连接或认证等待超时。'),120_000)
    try{await this.startConnection(session,cols,rows)}catch(error){this.close(id,'无法建立终端连接。');throw error}
  }
  createManaged(owner:string,serverId:string,connectionId:string,managed:ManagedTerminal,cols=100,rows=30){
    const result=this.create(owner,serverId,connectionId),session=this.owned(owner,result.sessionId)
    if(session.protocol!=='ssh'){this.close(session.id);throw new AppError('INVALID_ARGUMENT','AI 任务仅支持已保存的 SSH 入口。')}
    session.managed=managed;session.token='';clearTimeout(session.timer)
    session.timer=setTimeout(()=>this.close(session.id,'连接或认证等待超时。'),120_000)
    // Allow the task to publish its identity before synchronous errors/events.
    queueMicrotask(()=>{void this.startConnection(session,cols,rows).catch(()=>this.close(session.id,'SSH 启动失败。'))})
    return {sessionId:session.id}
  }
  private async startConnection(session:Session,cols:number,rows:number){
    const id=session.id
    if(session.closed)return
    const {server,connection}=this.ctx.storage.connection(session.serverId,session.connectionId)
    if(connection.type!==session.protocol)throw new AppError('CONFLICT','连接配置已变更，请重新打开。')
    if(connection.type!=='ssh'){
      const provider=this.providers.get(connection.type)
      if(!provider)throw new AppError('PLUGIN_UNAVAILABLE','终端插件不可用。')
      session.abort=new AbortController()
      if(connection.saveHistory===true){try{this.ctx.terminalHistory.open(id,server.id,server.name)}catch{this.send(session,{type:'terminal.notice',message:'输出历史暂时无法保存。'})}}
      try{
        const process=await provider({connection,cols,rows,signal:session.abort.signal,output:bytes=>this.output(session,bytes),exit:()=>this.finish(session)})
        if(session.closed){process.close();return}
        session.process=process;clearTimeout(session.timer);this.send(session,{type:'terminal.ready'});this.pump(session)
      }catch{this.close(id,'无法启动本地终端，请检查所选 Shell 是否已安装、工作目录是否存在。')}
      return
    }
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
          ;(session.directory??=new TerminalDirectoryTracker()).feed(bytes)
          this.ctx.terminalHistory.append(id,bytes)
          for(let offset=0;offset<bytes.length;offset+=16*1024){const chunk=Buffer.from(bytes.subarray(offset,offset+16*1024));session.queue.push(chunk);session.queued+=chunk.length}
          if(session.queued+session.sent-session.ack+(session.ws?.bufferedAmount??0)>1024*1024){this.close(id,'终端输出超出缓冲上限。');return}
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
  directory(owner:string,id:string){return this.owned(owner,id).directory?.snapshot()??{path:'',revision:0}}
  control(owner:string,id:string,input:unknown,ws?:WebSocket){
    const session=this.owned(owner,id),params=record(input)
    if(ws&&session.ws!==ws)throw new AppError('READ_ONLY','此终端已在另一个页面打开。')
    if(params.type==='terminal.ack'){
      if(session.terminal&&ws){session.terminal.ack(ws,params.parsedBytes);return}
      const ack=integer(params.parsedBytes,0,Number.MAX_SAFE_INTEGER)
      if(ack<session.ack||ack>session.sent)throw new AppError('FLOW_CONTROL','终端确认字节数不正确。')
      session.ack=ack;this.pump(session)
    }else if(params.type==='terminal.resize'){const rows=integer(params.rows,5,200),cols=integer(params.cols,20,400);session.terminal?.resize(cols,rows);session.channel?.setWindow(rows,cols,0,0);session.process?.resize(cols,rows)}
    else throw new AppError('INVALID_ARGUMENT','未知终端消息。')
  }
  input(owner:string,id:string,bytes:Buffer,ws?:WebSocket){
    const session=this.owned(owner,id)
    if(ws&&session.ws!==ws)throw new AppError('READ_ONLY','此终端已在另一个页面打开。')
    if((!session.channel&&!session.process)||session.finished)throw new AppError('CONFLICT','终端尚未就绪。')
    if(Date.now()-session.inputAt>1000){session.inputAt=Date.now();session.inputBytes=0}
    session.inputBytes+=bytes.length
    if(bytes.length>16*1024||session.inputBytes>128*1024||(session.channel?.writableLength??0)>128*1024)throw new AppError('FLOW_CONTROL','输入过快，请分段粘贴。')
    if(session.process)session.process.write(bytes);else session.channel!.write(bytes)
  }
  private output(session:Session,bytes:Buffer){
    if(session.closed)return
    this.ctx.terminalHistory.append(session.id,bytes)
    if(session.queued+session.sent-session.ack+bytes.length+(session.ws?.bufferedAmount??0)>1024*1024){this.close(session.id,'终端输出超出缓冲上限。');return}
    for(let offset=0;offset<bytes.length;offset+=16*1024){const chunk=Buffer.from(bytes.subarray(offset,offset+16*1024));session.queue.push(chunk);session.queued+=chunk.length}
    session.process?.pause();this.pump(session)
  }
  private pump(session:Session){
    if(session.managed||session.terminal){
      if(session.closed||session.parsing)return
      const chunk=session.queue.shift()
      if(chunk){
        session.queued-=chunk.length;session.parsing=true;session.sent+=chunk.length
        const timer=setTimeout(()=>this.close(session.id,'后台终端解析超时。'),30_000)
        void (session.managed?session.managed.output(chunk):session.terminal!.write(chunk)).then(()=>{session.ack+=chunk.length},()=>this.close(session.id,'后台终端解析失败。')).finally(()=>{clearTimeout(timer);session.parsing=false;this.pump(session)})
      }else if(session.finished){
        session.connected=false
        if(session.terminal)void session.terminal.finish('连接已结束。').then(()=>this.close(session.id))
        else this.close(session.id)
      }
      else {session.channel?.resume();session.channel?.stderr.resume();session.process?.resume()}
      return
    }
    const ws=session.ws;if(!ws||ws.readyState!==WebSocket.OPEN||session.closed)return
    while(session.queue.length && session.sent-session.ack+session.queue[0]!.length<=256*1024 && ws.bufferedAmount<256*1024){
      const chunk=session.queue.shift()!;session.queued-=chunk.length;session.sent+=chunk.length
      ws.send(chunk,{binary:true},error=>{if(error)this.close(session.id);else this.pump(session)})
    }
    if(!session.queue.length&&session.sent-session.ack<256*1024&&!session.finished){session.channel?.resume();session.channel?.stderr.resume();session.process?.resume()}
    else session.process?.pause()
    if(session.finished&&!session.queue.length&&session.sent===session.ack)this.close(session.id)
    else if(session.sent>session.ack){clearTimeout(session.timer);session.timer=setTimeout(()=>this.close(session.id,'终端长时间未确认输出。'),30_000)}
    else clearTimeout(session.timer)
  }
  private finish(session:Session){if(session.closed)return;session.finished=true;if(session.channel||session.process||session.abort){this.pump(session)}else this.close(session.id)}
  private send(session:Session,data:unknown){const p=record(data);if(p.type==='terminal.ready'){session.connected=true;session.hostKeyMessage=undefined}if(p.type==='terminal.hostkey')session.hostKeyMessage=data;session.managed?.event(data);if(session.terminal&&p.type!=='terminal.exit')session.terminal.event(data);else if(session.ws?.readyState===WebSocket.OPEN)session.ws.send(JSON.stringify(data))}
  async drainManaged(owner:string,id:string,timeoutMs=2000){
    const session=this.owned(owner,id);session.channel?.pause();session.channel?.stderr.pause()
    const until=Date.now()+timeoutMs
    while(!session.closed&&(session.parsing||session.queue.length)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10))
    return !session.parsing&&!session.queue.length
  }
  close(id:string,reason='连接已结束。'){
    const session=this.sessions.get(id);if(!session||session.closed)return;session.closed=true;this.sessions.delete(id);clearTimeout(session.timer)
    session.pendingKey?.decide(false);session.pendingKey=undefined
    try{this.ctx.terminalHistory.close(id)}catch{}
    this.send(session,{type:'terminal.exit',message:reason});session.ws?.close(1000);session.terminal?.dispose();session.abort?.abort();session.process?.close();session.channel?.destroy();session.client?.destroy();session.queue=[];session.queued=0
    session.managed?.closed(reason)
  }
  closeOwned(owner:string,id:string){if(this.sessions.has(id)){this.owned(owner,id);this.close(id)}return {closed:true}}
  closeAttached(owner:string,id:string,ws:WebSocket){const session=this.sessions.get(id);if(session?.owner===owner&&session.ws===ws){session.ws=undefined;session.terminal?.detach(ws)}}
}
