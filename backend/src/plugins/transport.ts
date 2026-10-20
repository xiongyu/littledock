import { Service, type Context } from 'cordis'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import type { CatalogDocument } from '@webnav/shared'
import { parseCatalogImport, serializeCatalog } from '@webnav/shared'
import { AppError, integer, publicError, record, string } from '../core/errors.ts'
import { readLocalSshConfig, type KeyReference } from './ssh-import.ts'

type ClientState={ ws:WebSocket; owner:string; authorized:boolean; subscription?:string; vaultWatching?:boolean; pending:number; previews:Map<string,{data:CatalogDocument;references:KeyReference[];revision:number;expires:number}>;history?:{id:string;sessionId:string;lower:number;upper:number;expires:number} }
type Operation={hash:string;expires:number;promise:Promise<unknown>;state:'running'|'succeeded'|'failed';result?:unknown;error?:{code:string;message:string}}
declare module 'cordis' { interface Context { transport: TransportService } }
export class TransportService extends Service {
  static inject=['storage','auth','credentials','connectors','sessions','terminalHistory']
  readonly epoch=randomUUID()
  private clients=new Set<ClientState>()
  private operations=new Map<string,Operation>()
  private digestKey=randomBytes(32)
  private server:Server
  private wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false})
  readonly ready:Promise<void>
  constructor(ctx:Context,config:{port:number;frontendRoot:string;devOrigin?:string}){
    super(ctx,'transport',true)
    const host=`127.0.0.1:${config.port}`,origin=`http://${host}`
    const allowedOrigins=new Set([origin,...(config.devOrigin?[config.devOrigin]:[])])
    const app=new Hono()
    app.use('*',async(c,next)=>{
      if(c.req.header('host')!==host)return c.text('Forbidden host',403)
      c.header('X-WebNav-Service','1')
      if(config.devOrigin)c.header('X-WebNav-Dev-Origin',config.devOrigin)
      c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
      if(c.req.path==='/'||c.req.path==='/index.html'){
        if(!ctx.auth.session(c.req.header('cookie'))){const token=ctx.auth.create();c.header('Set-Cookie',`${ctx.auth.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)}
        c.header('Cache-Control','no-store')
      }
      await next()
    })
    if(config.devOrigin)app.get('/',c=>c.redirect(config.devOrigin!))
    else app.get('/',serveStatic({root:config.frontendRoot,path:'index.html'}))
    app.get('/*',serveStatic({root:config.frontendRoot}))
    let resolveReady!:()=>void;this.ready=new Promise(resolve=>{resolveReady=resolve})
    this.server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:config.port},()=>resolveReady()) as Server
    this.server.on('upgrade',(request,socket,head)=>{
      const session=ctx.auth.session(request.headers.cookie),path=request.url
      if(request.headers.host!==host||!allowedOrigins.has(request.headers.origin??'')||!session||!['/ws','/ws/terminal'].includes(path??'')||(path==='/ws/terminal'&&!session.authorized)||this.wss.clients.size>=64){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
      this.wss.handleUpgrade(request,socket,head,ws=>path==='/ws'?this.business(ws,session.id,session.authorized):this.terminal(ws,session.id))
    })
    const alive=new WeakSet<WebSocket>()
    this.wss.on('connection',ws=>{alive.add(ws);ws.on('pong',()=>alive.add(ws))})
    const heartbeat=setInterval(()=>{for(const ws of this.wss.clients){if(!alive.has(ws))ws.terminate();else{alive.delete(ws);ws.ping()}}},15_000)
    const unwatchVault=ctx.credentials.subscribe(status=>{
      for(const client of this.clients)if(client.vaultWatching&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'vault.changed',epoch:this.epoch,status})
    })
    ctx.on('dispose',unwatchVault)
    ctx.on('dispose',async()=>{clearInterval(heartbeat);for(const ws of this.wss.clients)ws.terminate();this.wss.close();await new Promise<void>(resolve=>this.server.close(()=>resolve()));this.digestKey.fill(0);this.operations.clear()})
  }
  private send(ws:WebSocket,data:unknown){if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>2*1024*1024){ws.close(1013);return}ws.send(JSON.stringify(data))}
  private business(ws:WebSocket,owner:string,authorized:boolean){
    this.wss.emit('connection',ws)
    const client:ClientState={ws,owner,authorized,pending:0,previews:new Map()};this.clients.add(client)
    this.send(ws,{v:1,type:'hello',epoch:this.epoch,authorized,limits:{messageBytes:2*1024*1024}})
    ws.on('close',()=>{client.previews.clear();client.history=undefined;this.clients.delete(client)})
    ws.on('error',()=>ws.close())
    ws.on('message',(raw,binary)=>{
      if(binary||client.pending>=8){ws.close(1008);return}
      client.pending++
      void this.request(client,raw).finally(()=>client.pending--)
    })
  }
  private async request(client:ClientState,raw:RawData){
    let id=''
    try{
      const message=record(JSON.parse(raw.toString()));id=string(message.id,100)
      if(message.type!=='request'||message.v!==1)throw new AppError('INVALID_ARGUMENT','不支持的协议。')
      if(message.epoch!==this.epoch)throw new AppError('STALE_EPOCH','本地服务已重启，请重新同步。')
      const method=string(message.method,100),params=record(message.params??{})
      if(method==='auth.status'){this.send(client.ws,{v:1,type:'response',id,ok:true,result:{authorized:this.ctx.auth.authorized(client.owner)}});return}
      if(!this.ctx.auth.authorized(client.owner))throw new AppError('UNAUTHORIZED','本地会话已失效，正在重新连接。')
      const mutates=['catalog.replace','credentials.save','vault.configure','vault.changeMode','vault.update','vault.unlock','vault.lock','imports.apply','connections.open','sessions.close','sessions.hostKeyDecision'].includes(method)
      const checkVault=()=>{
        if(!['vault.status','vault.watch','vault.unlock','sessions.close','history.close','catalog.unwatch'].includes(method))this.ctx.credentials.requireUnlocked()
      }
      checkVault()
      const run=()=>{
        checkVault()
        return this.dispatch(client,method,params)
      }
      const result=mutates?await this.operation(client.owner,string(message.operationId,100),method,params,run):await run()
      this.send(client.ws,{v:1,type:'response',id,ok:true,result})
    }catch(cause){this.send(client.ws,{v:1,type:'response',id,ok:false,error:publicError(cause)})}
  }
  private async operation(owner:string,id:string,method:string,params:unknown,run:()=>unknown){
    const key=owner+'/'+id,hash=createHmac('sha256',this.digestKey).update(JSON.stringify([method,params])).digest('hex'),old=this.operations.get(key)
    if(old){if(old.hash!==hash)throw new AppError('OPERATION_CONFLICT','操作 ID 内容不一致。');return old.promise}
    for(const [key,value]of this.operations)if(value.state!=='running'&&value.expires<Date.now())this.operations.delete(key)
    if(this.operations.size>=1000)throw new AppError('BUSY','操作记录已满，请稍后再试。')
    const operation:Operation={hash,expires:Date.now()+600_000,state:'running',promise:Promise.resolve().then(run)};this.operations.set(key,operation)
    try{const result=await operation.promise;operation.state='succeeded';operation.result=result;return result}catch(cause){operation.state='failed';operation.error=publicError(cause);throw cause}finally{operation.expires=Date.now()+600_000}
  }
  private publish(){if(!this.ctx.credentials.status().unlocked)return;const snapshot=this.ctx.storage.snapshot();for(const client of this.clients)if(client.subscription&&this.ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'catalog.changed',subscriptionId:client.subscription,epoch:this.epoch,...snapshot})}
  private async dispatch(client:ClientState,method:string,params:Record<string,unknown>):Promise<unknown>{
    switch(method){
      case 'catalog.watch':client.subscription=randomUUID();return {subscriptionId:client.subscription,epoch:this.epoch,...this.ctx.storage.snapshot()}
      case 'catalog.unwatch':client.subscription=undefined;return {}
      case 'catalog.replace':{
        let catalog: CatalogDocument
        try { catalog = parseCatalogImport(params.catalog) } catch { throw new AppError('INVALID_ARGUMENT', '目录格式不正确。') }
        const commitPasswords = this.ctx.credentials.prepareRdpPasswords(params.rdpPasswords, catalog)
        const result = this.ctx.storage.db.transaction(() => {
          const result = this.ctx.storage.replace(catalog,integer(params.expectedRevision,0,Number.MAX_SAFE_INTEGER))
          commitPasswords()
          return result
        })()
        this.publish()
        return result
      }
      case 'exports.config':{const data=this.ctx.storage.snapshot().snapshot;return {text:serializeCatalog(data.groups,data.servers),filename:'webnav-config.json'}}
      case 'imports.preview':
      case 'ssh.importPreview':{
        if(client.previews.size>=4)client.previews.clear()
        let data:CatalogDocument,references:KeyReference[]=[],warnings:string[]=[],aliases:number|undefined
        if(method==='ssh.importPreview'){const result=await readLocalSshConfig();data=result.catalog;references=result.references;warnings=result.warnings;aliases=result.aliases}
        else{try{data=parseCatalogImport(params.catalog)}catch(cause){throw new AppError('INVALID_ARGUMENT',cause instanceof Error?cause.message:'配置不正确。')}}
        const token=randomUUID(),revision=this.ctx.storage.snapshot().revision
        client.previews.set(token,{data,references,revision,expires:Date.now()+300_000});return {token,catalog:data,warnings,aliases,keyReferences:references.length}
      }
      case 'imports.apply':{
        const token=string(params.token),preview=client.previews.get(token)
        if(!preview||preview.expires<Date.now())throw new AppError('PREVIEW_EXPIRED','预览已失效，请重新导入。')
        const result=this.ctx.storage.db.transaction(()=>{const result=this.ctx.storage.replace(preview.data,preview.revision);for(const ref of preview.references)this.ctx.credentials.importKeyReference(ref.serverId,ref.connectionId,ref.path);return result})()
        client.previews.delete(token);this.publish();return result
      }
      case 'vault.status':return this.ctx.credentials.status()
      case 'vault.watch':client.vaultWatching=true;return this.ctx.credentials.status()
      case 'vault.update':return this.ctx.credentials.update(params)
      case 'vault.configure':return this.ctx.credentials.configure(string(params.mode) as 'local'|'master',string(params.password??'',1024,true))
      case 'vault.changeMode':return this.ctx.credentials.changeMode(string(params.mode) as 'local'|'master',string(params.password??'',1024,true))
      case 'vault.unlock':return this.ctx.credentials.unlock(string(params.password,1024))
      case 'vault.lock':this.ctx.credentials.lock();return this.ctx.credentials.status()
      case 'credentials.describe':return this.ctx.credentials.describe(string(params.serverId),string(params.connectionId))
      case 'credentials.save':return this.ctx.credentials.save(params)
      case 'connections.open':{const serverId=string(params.serverId),connectionId=string(params.connectionId),{connection}=this.ctx.storage.connection(serverId,connectionId);return this.ctx.connectors.open(connection.type,client.owner,serverId,connectionId)}
      case 'sessions.close':return this.ctx.sessions.closeOwned(client.owner,string(params.sessionId))
      case 'sessions.hostKeyDecision':return this.ctx.sessions.hostKey(client.owner,params)
      case 'history.sessions':return this.ctx.terminalHistory.list(string(params.serverId))
      case 'history.open':{const sessionId=string(params.sessionId),range=this.ctx.terminalHistory.range(sessionId);client.history={id:randomUUID(),sessionId,...range,expires:Date.now()+1800_000};return {...client.history,capturedAt:Date.now()}}
      case 'history.page':{const range=client.history;if(!range||range.id!==params.snapshotId||range.expires<Date.now())throw new AppError('HISTORY_SNAPSHOT_EXPIRED','历史查询已过期，请刷新。');return this.ctx.terminalHistory.page(params,range)}
      case 'history.close':client.history=undefined;return {}
      case 'operations.get':{const op=this.operations.get(client.owner+'/'+string(params.operationId));return op?{state:op.state,result:op.result,error:op.error}:{state:'unknown'}}
      default:throw new AppError('NOT_FOUND','未提供此方法。')
    }
  }
  private terminal(ws:WebSocket,owner:string){
    this.wss.emit('connection',ws)
    let sessionId='',attaching=false
    const timer=setTimeout(()=>ws.close(1008),10_000)
    ws.on('error',()=>ws.close());ws.on('close',()=>clearTimeout(timer))
    ws.on('message',(raw,binary)=>{
      void(async()=>{
        try{
          if(!this.ctx.auth.authorized(owner))throw new AppError('UNAUTHORIZED','授权已失效。')
          if(!sessionId){
            if(binary||attaching)throw new AppError('INVALID_ARGUMENT','请先绑定终端。')
            attaching=true;const message=record(JSON.parse(raw.toString()));if(message.type!=='terminal.attach')throw new AppError('INVALID_ARGUMENT','缺少绑定消息。')
            sessionId=string(message.sessionId);clearTimeout(timer);await this.ctx.sessions.attach(owner,ws,message)
          }else if(binary)this.ctx.sessions.input(owner,sessionId,Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer))
          else this.ctx.sessions.control(owner,sessionId,JSON.parse(raw.toString()))
        }catch(cause){this.send(ws,{type:'terminal.error',...publicError(cause)});if(sessionId){try{this.ctx.sessions.closeOwned(owner,sessionId)}catch{}}ws.close(1008)}
      })()
    })
  }
}
