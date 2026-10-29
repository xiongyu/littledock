import { Service, type Context } from 'cordis'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { releaseFile } from '../plugin-system/git.ts'
import type { CatalogDocument } from '@webnav/shared'
import { parseCatalogImport, serializeCatalog, parseTaskManagerTarget } from '@webnav/shared'
import { AppError, integer, publicError, record, string } from '../core/errors.ts'
import { requireConnectionCapacity } from '../core/connection-budget.ts'
import { readLocalSshConfig, type KeyReference } from './ssh-import.ts'
import { emptyWorkspaceView, parseWorkspaceView, type WorkspaceView } from '@webnav/shared'

type ClientState={ ws:WebSocket; owner:string; pageId:string; authorized:boolean; taskMonitors:Set<string>; pluginSubscription?:string; extensionPairing?:string; subscription?:string; bookmarkSubscription?:string; vaultWatching?:boolean;syncWatching?:boolean;themeSubscription?:string; pending:number; previews:Map<string,{data:CatalogDocument;references:KeyReference[];revision:number;expires:number}>;history?:{id:string;sessionId:string;lower:number;upper:number;expires:number} }
type Operation={hash:string;expires:number;promise:Promise<unknown>;state:'running'|'succeeded'|'failed';result?:unknown;error?:{code:string;message:string}}
declare module 'cordis' { interface Context { transport: TransportService } }
export class TransportService extends Service {
  static inject=['storage','auth','credentials','connectors','sessions','terminalHistory','webBookmarks','desktops','terminalThemes','sshInspector','sshFiles','remoteEditor','taskManager','plugins','deviceSessions','configSync','browserExtension','automation','mcp','maintenance','updates']
  readonly epoch=randomUUID()
  private clients=new Set<ClientState>()
  private automationWatchers=new Map<WebSocket,string>()
  private operations=new Map<string,Operation>()
  private digestKey=randomBytes(32)
  private syncOperations=new Map<string,{hash:string;expires:number}>()
  private workspaces=new Map<string,{revision:number;view:WorkspaceView}>()
  private server:Server
  private wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false})
  readonly ready:Promise<void>
  get listenPort(){const address=this.server.address();if(!address||typeof address==='string')throw new Error('业务入口尚未监听。');return address.port}
  constructor(ctx:Context,config:{port:number;frontendRoot:string;devOrigin?:string;runtimeGateway?:{token:string}}){
    super(ctx,'transport',true)
    const host=`127.0.0.1:${config.port}`,origin=`http://${host}`
    const allowedOrigins=new Set([origin,...(config.devOrigin?[config.devOrigin]:[])])
    const app=new Hono()
    app.use('*',async(c,next)=>{
      if(config.runtimeGateway&&c.req.header('x-webnav-runtime')!==config.runtimeGateway.token)return c.text('Forbidden gateway',403)
      if(!ctx.auth)return c.text('WebNav is restarting. Please reload shortly.',503)
      if(c.req.header('host')!==host)return c.text('Forbidden host',403)
      c.header('X-WebNav-Service','1')
      if(config.devOrigin)c.header('X-WebNav-Dev-Origin',config.devOrigin)
      c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
      if(c.req.path==='/'||c.req.path==='/index.html'){
        if(!ctx.auth.session(c.req.header('cookie'))){const token=ctx.auth.create();c.header('Set-Cookie',`${ctx.auth.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)}
        c.header('Cache-Control','no-store')
      }
      await next()
    })
    if(config.devOrigin)app.get('/',c=>c.redirect(config.devOrigin!))
    else app.get('/',serveStatic({root:config.frontendRoot,path:'index.html'}))
    app.get('/plugins/:id/:commit/*',async c=>{
      if(!ctx.auth.session(c.req.header('cookie'))?.authorized)return c.text('Forbidden',403)
      const active=ctx.plugins.served.get(c.req.param('id')+'/'+c.req.param('commit'))??ctx.plugins.manager.running.get(c.req.param('id'))??ctx.plugins.manager.registry.installed.find(p=>p.manifest.id===c.req.param('id')&&(p.manifest.theme||p.manifest.contributes?.settings)&&p.commit===c.req.param('commit'))
      const plugin=active?.commit===c.req.param('commit')?active:await ctx.plugins.manager.retainedTheme(c.req.param('id'),c.req.param('commit'))
      if(!plugin)return c.notFound()
      const path=c.req.path.split('/').slice(4).join('/'),entry=plugin.manifest.frontend,base=entry?.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):''
      const themeAsset=Object.values(plugin.manifest.theme?.backgrounds??{}).includes(path)
      const iconAsset=path===plugin.manifest.icon||plugin.manifest.contributes?.tools.some(tool=>tool.icon===path)
      const settings=plugin.manifest.contributes?.settings?.entry,settingsBase=settings?.slice(0,settings.lastIndexOf('/')+1)
      const settingsAsset=!ctx.plugins.manager.safeMode&&settingsBase&&path.startsWith(settingsBase)
      const frontendAsset=ctx.plugins.served.has(plugin.manifest.id+'/'+plugin.commit)&&base&&path.startsWith(base)
      if(!themeAsset&&!iconAsset&&(!(settingsAsset||frontendAsset)||!['.js','.mjs','.css','.png','.svg','.woff2'].some(ext=>path.endsWith(ext))))return c.notFound()
      try{const file=await releaseFile(ctx.plugins.manager.path(plugin),path);const data=await readFile(file);c.header('Content-Type',path.endsWith('.css')?'text/css':/\.m?js$/.test(path)?'text/javascript':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':path.endsWith('.webp')?'image/webp':/\.jpe?g$/.test(path)?'image/jpeg':'image/png');c.header('Cache-Control','private, max-age=31536000, immutable');return c.body(data)}catch{return c.notFound()}
    })
    app.get('/*',serveStatic({root:config.frontendRoot}))
    let resolveReady!:()=>void;this.ready=new Promise(resolve=>{resolveReady=resolve})
    this.server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:config.runtimeGateway?0:config.port},()=>resolveReady()) as Server
    this.server.on('upgrade',(request,socket,head)=>{
      if(config.runtimeGateway&&request.headers['x-webnav-runtime']!==config.runtimeGateway.token){socket.destroy();return}
      if(request.url==='/ws/extension'){ctx.browserExtension.upgrade(request,socket,head);return}
      if(request.url==='/ws/automation'){ctx.mcp.upgrade(request,socket,head);return}
      const session=ctx.auth.session(request.headers.cookie),path=request.url
      if(request.headers.host!==host||!allowedOrigins.has(request.headers.origin??'')||!session||!['/ws','/ws/terminal','/ws/desktop','/ws/device','/ws/automation-terminal'].includes(path??'')||(path!=='/ws'&&!session.authorized)||this.wss.clients.size>=64){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
      this.wss.handleUpgrade(request,socket,head,ws=>path==='/ws/automation-terminal'?this.automationTerminal(ws,session.id):path==='/ws'?this.business(ws,session.id,session.authorized):path==='/ws/desktop'?this.desktop(ws,session.id):path==='/ws/device'?this.device(ws,session.id):this.terminal(ws,session.id))
    })
    const alive=new WeakSet<WebSocket>()
    this.wss.on('connection',ws=>{alive.add(ws);ws.on('pong',()=>alive.add(ws))})
    const heartbeat=setInterval(()=>{for(const ws of this.wss.clients){if(!alive.has(ws))ws.terminate();else{alive.delete(ws);ws.ping()}}},15_000)
    const unwatchVault=ctx.credentials.subscribe(status=>{
      for(const client of this.clients)if(client.vaultWatching&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'vault.changed',epoch:this.epoch,status})
    })
    ctx.on('dispose',unwatchVault)
    ctx.on('dispose',ctx.automation.subscribe(()=>{
      if(!ctx.credentials.status().unlocked)return
      for(const [ws,owner]of this.automationWatchers)if(ctx.auth.authorized(owner))this.send(ws,{v:1,type:'event',event:'automation.changed',epoch:this.epoch,...ctx.automation.watch()})
    }))
    ctx.on('dispose',ctx.storage.subscribe(()=>this.publish()))
    ctx.on('dispose',ctx.plugins.subscribe(()=>{
      if(!ctx.credentials.status().unlocked)return
      for(const client of this.clients)if(client.pluginSubscription&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'plugins.changed',subscriptionId:client.pluginSubscription,epoch:this.epoch,revision:ctx.plugins.manager.runtimeRevision})
    }))
    ctx.on('dispose',ctx.configSync.subscribe(()=>{
      if(!ctx.credentials.status().unlocked)return
      for(const client of this.clients)if(client.syncWatching&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'configSync.changed',epoch:this.epoch,status:ctx.configSync.status()})
    }))
    ctx.on('dispose',ctx.terminalThemes.subscribe(()=>{
      if(!ctx.credentials.status().unlocked)return
      for(const client of this.clients)if(client.themeSubscription&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'terminalThemes.changed',subscriptionId:client.themeSubscription,epoch:this.epoch,...ctx.terminalThemes.snapshot()})
    }))
    ctx.on('dispose',ctx.webBookmarks.subscribe(()=>{
      if(!ctx.credentials.status().unlocked)return
      const snapshot=ctx.webBookmarks.snapshot()
      for(const client of this.clients)if(client.bookmarkSubscription&&ctx.auth.authorized(client.owner))this.send(client.ws,{v:1,type:'event',event:'bookmarks.changed',subscriptionId:client.bookmarkSubscription,epoch:this.epoch,...snapshot})
    }))
    ctx.on('dispose',async()=>{clearInterval(heartbeat);for(const ws of this.wss.clients)ws.terminate();this.wss.close();await new Promise<void>(resolve=>this.server.close(()=>resolve()));this.digestKey.fill(0);this.operations.clear();this.syncOperations.clear()})
  }
  private send(ws:WebSocket,data:unknown){if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>2*1024*1024){ws.close(1013);return}ws.send(JSON.stringify(data))}
  private business(ws:WebSocket,owner:string,authorized:boolean){
    this.wss.emit('connection',ws)
    const client:ClientState={ws,owner,pageId:randomUUID(),authorized,pending:0,taskMonitors:new Set(),previews:new Map()};this.clients.add(client)
    ws.on('close',()=>this.automationWatchers.delete(ws))
    this.send(ws,{v:1,type:'hello',epoch:this.epoch,authorized,limits:{messageBytes:2*1024*1024}})
    ws.on('close',()=>{client.previews.clear();client.history=undefined;for(const id of client.taskMonitors)void Promise.resolve().then(()=>this.ctx.taskManager?.close(client.owner,id)).catch(()=>{});client.taskMonitors.clear();if(client.extensionPairing)this.ctx.browserExtension?.cancel(client.owner,client.extensionPairing);this.clients.delete(client)})
    ws.on('error',()=>ws.close())
    ws.on('message',(raw,binary)=>{
      if(binary||client.pending>=8){ws.close(1008);return}
      client.pending++
      void this.request(client,raw).finally(()=>client.pending--)
    })
  }
  private automationTerminal(ws:WebSocket,owner:string){
    this.wss.emit('connection',ws)
    const timer=setTimeout(()=>ws.close(1008),10000)
    ws.once('close',()=>clearTimeout(timer));ws.on('error',()=>ws.close())
    ws.once('message',(raw,binary)=>{
      clearTimeout(timer)
      void (async()=>{try{if(binary)throw new AppError('INVALID_ARGUMENT','缺少观察票据。');await this.ctx.automation.attach(owner,ws,record(JSON.parse(raw.toString())))}catch(error){this.send(ws,{type:'terminal.error',...publicError(error)});ws.close(1008)}})()
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
      const mutates=['taskManager.start','taskManager.install','taskManager.hostKeyDecision','taskManager.prepareAction','taskManager.applyAction','taskManager.configureRecording','taskManager.close','catalog.replace','credentials.save','vault.configure','vault.changeMode','vault.update','vault.unlock','vault.lock','imports.apply','connections.open','sessions.close','desktops.close','devices.close','sessions.hostKeyDecision','bookmarks.save','bookmarks.remove','bookmarks.refresh','terminalThemes.save','files.save','files.action','files.begin','files.commit','files.startJob','files.jobAction','editor.prepare','editor.install','editor.stop','plugins.prepare','plugins.install','plugins.change'].includes(method)||this.ctx.plugins.rpc.get(method)?.mutate===true
      const checkVault=()=>{
        if(!['vault.status','vault.watch','vault.unlock','taskManager.close','sessions.close','desktops.close','devices.close','history.close','catalog.unwatch'].includes(method))this.ctx.credentials.requireUnlocked()
      }
      checkVault()
      if(method==='workspace.save'){
        const result=await this.operation(client.owner,string(message.operationId,100),method,params,()=>{
          checkVault()
          const old=this.workspaces.get(client.owner)??{revision:0,view:emptyWorkspaceView()}
          if(integer(params.expectedRevision,0,Number.MAX_SAFE_INTEGER)!==old.revision)throw new AppError('REVISION_CONFLICT','工作区已在其他页面更新。')
          let view:WorkspaceView
          try{view=parseWorkspaceView(params.view)}catch{throw new AppError('INVALID_ARGUMENT','工作区布局无效。')}
          for(const owner of this.workspaces.keys())if(!this.ctx.auth.authorized(owner))this.workspaces.delete(owner)
          if(!this.workspaces.has(client.owner)&&this.workspaces.size>=64)throw new AppError('BUSY','工作区数量超限。')
          const next={revision:old.revision+1,view};this.workspaces.set(client.owner,next);return next
        })
        this.send(client.ws,{v:1,type:'response',id,ok:true,result});return
      }
      if(method.startsWith('updates.')){
        const result=await this.ctx.updates.dispatch(method,params,method==='updates.status'||method==='updates.check'?undefined:string(message.operationId,100))
        this.send(client.ws,{v:1,type:'response',id,ok:true,result});return
      }
      const run=()=>{
        checkVault()
        const finish=method.startsWith('plugin.') ? this.ctx.plugins.rpc.get(method)?.maintenance !== undefined : /^(auth\.|vault\.(status|watch|unlock|lock)$|history\.|catalog\.(watch|unwatch)$|.*\.status$|.*\.watch$|.*\.unwatch$|workspace\.snapshot$|taskManager\.(close|snapshot|details|recordingStatus|queryHistory|historyPoint)$|sessions\.(close|hostKeyDecision|attachTicket)$|desktops\.(close|attachTicket)$|devices\.(close|attachTicket)$|files\.(chunk|commit|cancel|status|jobAction)$|editor\.stop$|configSync\.lock$|automation\.)/.test(method)
        return this.ctx.maintenance.run(finish,()=>this.dispatch(client,method,params,method==='taskManager.configureRecording'?string(message.operationId,100):undefined))
      }
      // Sync maintains its own encrypted durable operation journal. No password-bearing request or preview is cached here.
      if(method.startsWith('configSync.')&&!['configSync.status','configSync.watch','configSync.history','configSync.check'].includes(method)){
        const operationId=string(message.operationId,100),key=client.owner+'/'+operationId,hash=createHmac('sha256',this.digestKey).update(JSON.stringify([method,params])).digest('hex'),old=this.syncOperations.get(key)
        if(old)throw new AppError(old.hash===hash?'SYNC_ALREADY_REQUESTED':'OPERATION_CONFLICT',old.hash===hash?'此操作已经接收，请读取同步状态或核对待处理操作。':'操作 ID 内容不一致。')
        for(const [id,value]of this.syncOperations)if(value.expires<Date.now())this.syncOperations.delete(id)
        if(this.syncOperations.size>=1000)throw new AppError('BUSY','操作记录已满，请稍后再试。')
        this.syncOperations.set(key,{hash,expires:Date.now()+600_000})
      }
      const extensionMutation=['extensions.cancelPairing','extensions.revoke','extensions.revokeGrant'].includes(method)
      const operationOwner=method.startsWith('taskManager.')?client.owner+'/'+client.pageId:client.owner
      const result=method==='extensions.beginPairing'?await this.ctx.maintenance.run(false,()=>this.ctx.browserExtension.begin(client.owner,params,string(message.operationId,100))):(mutates||extensionMutation)?await this.operation(operationOwner,string(message.operationId,100),method,params,run):await run()
      if(method==='extensions.beginPairing'){
        const pairingId=string(record(result).id,36)
        if(client.ws.readyState!==WebSocket.OPEN){this.ctx.browserExtension.cancel(client.owner,pairingId);return}
        client.extensionPairing=pairingId
      }
      if(method==='bookmarks.reveal'||method==='extensions.beginPairing'||(method.startsWith('taskManager.')&&method!=='taskManager.close')){
        checkVault()
        if(!this.ctx.auth.authorized(client.owner))throw new AppError('UNAUTHORIZED','本地会话已失效。')
      }
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
  private async dispatch(client:ClientState,method:string,params:Record<string,unknown>,operationId?:string):Promise<unknown>{
    if(method==='automation.watch'){this.automationWatchers.set(client.ws,client.owner);return {epoch:this.epoch,...this.ctx.automation.watch()}}
    if(method.startsWith('automation.'))return this.ctx.automation.manage(client.owner,method,params)
    if(method==='plugins.watch'){client.pluginSubscription=randomUUID();return {subscriptionId:client.pluginSubscription,epoch:this.epoch,state:await this.ctx.plugins.manager.state()}}
    if(method.startsWith('plugins.')||method.startsWith('plugin.'))return this.ctx.plugins.dispatch(client.owner,method,params)
    if(method.startsWith('taskManager.')){
      const service=this.ctx.taskManager
      if(method==='taskManager.capabilities')return { recording: ['recordingStatus','configureRecording','queryHistory','historyPoint'].every(name=>typeof Reflect.get(service,name)==='function') }
      if(method==='taskManager.start'){
        this.ctx.plugins.requireAvailable('taskManager')
        if(client.taskMonitors.size>=8)throw new AppError('BUSY','请先关闭此页面已有的任务管理器。')
        let target;try{target=parseTaskManagerTarget(params.target)}catch{throw new AppError('INVALID_ARGUMENT','请选择本机或已保存的 SSH 连接。')}
        if(target.kind==='ssh')requireConnectionCapacity(this.ctx)
        const state=await service.start(client.owner,target)
        if(client.ws.readyState!==WebSocket.OPEN){await service.close(client.owner,state.id);return state}
        client.taskMonitors.add(state.id);return state
      }
      const id=string(params.monitorId,100)
      if(!client.taskMonitors.has(id))throw new AppError('NOT_FOUND','此页面没有对应的任务管理器，请重新选择目标。')
      if(method==='taskManager.status')return service.status(client.owner,id)
      if(method==='taskManager.install')return service.install(client.owner,id)
      if(method==='taskManager.snapshot')return service.snapshot(client.owner,id)
      if(['taskManager.recordingStatus','taskManager.configureRecording','taskManager.queryHistory','taskManager.historyPoint'].includes(method)&&!['recordingStatus','configureRecording','queryHistory','historyPoint'].every(name=>typeof Reflect.get(service,name)==='function'))throw new AppError('CAPABILITY_UNAVAILABLE','当前任务管理器提供者不支持持续记录与历史查询。')
      if(method==='taskManager.recordingStatus')return service.recordingStatus(client.owner,id)
      if(method==='taskManager.configureRecording')return service.configureRecording(client.owner,id,{config:params.config,expectedRevision:integer(params.expectedRevision,0,Number.MAX_SAFE_INTEGER),operationId:string(operationId,100)})
      if(method==='taskManager.queryHistory')return service.queryHistory(client.owner,id,params.query)
      if(method==='taskManager.historyPoint')return service.historyPoint(client.owner,id,string(params.id,160))
      if(method==='taskManager.hostKeyDecision'){
        if(typeof params.accept!=='boolean')throw new AppError('INVALID_ARGUMENT','请确认主机指纹。')
        return service.hostKeyDecision(client.owner,id,params.accept)
      }
      if(method==='taskManager.details'||method==='taskManager.commandLine'||method==='taskManager.prepareAction'){
        const identity={pid:integer(params.pid,1,0x7fffffff),startedAt:integer(params.startedAt,0,Number.MAX_SAFE_INTEGER)}
        if(method==='taskManager.commandLine'){
          if(typeof service.commandLine!=='function')throw new AppError('UNSUPPORTED','当前任务管理器提供者不支持启动参数。')
          return service.commandLine(client.owner,id,identity)
        }
        if(method==='taskManager.details')return service.details(client.owner,id,identity)
        if(params.force!==undefined&&typeof params.force!=='boolean')throw new AppError('INVALID_ARGUMENT','结束进程选项无效。')
        return service.prepareAction(client.owner,id,{...identity,force:params.force===true})
      }
      if(method==='taskManager.applyAction')return service.applyAction(client.owner,id,string(params.planId,100))
      if(method==='taskManager.close'){const result=await service.close(client.owner,id);client.taskMonitors.delete(id);return result??{}}
      throw new AppError('NOT_FOUND','未知任务管理器操作。')
    }
    switch(method){
      case 'workspace.snapshot':return {epoch:this.epoch,...(this.workspaces.get(client.owner)??{revision:0,view:emptyWorkspaceView()}),sessions:[...(typeof this.ctx.sessions.list==='function'?this.ctx.sessions.list(client.owner):[]),...(typeof this.ctx.desktops.list==='function'?this.ctx.desktops.list(client.owner):[]),...this.ctx.deviceSessions.list(client.owner)]}
      case 'devices.attachTicket':return this.ctx.deviceSessions.ticket(client.owner,string(params.sessionId))
      case 'sessions.attachTicket':if(typeof this.ctx.sessions.ticket!=='function')throw new AppError('CAPABILITY_UNAVAILABLE','此终端提供者不支持后台恢复。');return this.ctx.sessions.ticket(client.owner,string(params.sessionId))
      case 'desktops.attachTicket':if(typeof this.ctx.desktops.ticket!=='function')throw new AppError('CAPABILITY_UNAVAILABLE','此桌面提供者不支持后台恢复。');return this.ctx.desktops.ticket(client.owner,string(params.sessionId))
      case 'extensions.status':return this.ctx.browserExtension.status()
      case 'extensions.cancelPairing':return this.ctx.browserExtension.cancel(client.owner,string(params.id,36))
      case 'extensions.revoke':return this.ctx.browserExtension.revoke(string(params.id,36))
      case 'extensions.revokeGrant':return this.ctx.browserExtension.revokeGrant(string(params.id,36),string(params.bookmarkId,100))
      case 'configSync.status':return this.ctx.configSync.status()
      case 'configSync.watch':client.syncWatching=true;return this.ctx.configSync.status()
      case 'configSync.configure':return this.ctx.configSync.configure(params)
      case 'configSync.check':return this.ctx.configSync.check()
      case 'configSync.unlock':return this.ctx.configSync.unlock(params)
      case 'configSync.lock':return this.ctx.configSync.lock()
      case 'configSync.preview':return this.ctx.configSync.preview(client.owner,params)
      case 'configSync.apply':return this.ctx.configSync.apply(client.owner,params)
      case 'configSync.recover':return this.ctx.configSync.recover(params)
      case 'configSync.history':return this.ctx.configSync.history(params)
      case 'configSync.rotatePassword':return this.ctx.configSync.rotate(params)
      case 'configSync.confirmBinding':return this.ctx.configSync.confirmBinding(params)
      case 'editor.prepare':return this.ctx.remoteEditor.prepare(client.owner,params)
      case 'editor.status':return this.ctx.remoteEditor.status(client.owner,params)
      case 'editor.install':return this.ctx.remoteEditor.install(client.owner,params)
      case 'editor.stop':return this.ctx.remoteEditor.stopOwned(client.owner,params)
      case 'files.cwd':return this.ctx.sshFiles.directory(client.owner,params)
      case 'files.read':return this.ctx.sshFiles.readText(client.owner,params)
      case 'files.save':return this.ctx.sshFiles.saveText(client.owner,params)
      case 'files.action':return this.ctx.sshFiles.action(client.owner,params)
      case 'files.begin':return this.ctx.sshFiles.begin(client.owner,params)
      case 'files.chunk':return this.ctx.sshFiles.chunk(client.owner,params)
      case 'files.commit':return this.ctx.sshFiles.commit(client.owner,params)
      case 'files.cancel':return this.ctx.sshFiles.cancel(client.owner,params)
      case 'files.startJob':return this.ctx.sshFiles.startJob(client.owner,params)
      case 'files.status':return this.ctx.sshFiles.status(client.owner,params)
      case 'files.jobAction':return this.ctx.sshFiles.jobAction(client.owner,params)
      case 'terminalThemes.watch':client.themeSubscription=randomUUID();return {subscriptionId:client.themeSubscription,epoch:this.epoch,...this.ctx.terminalThemes.snapshot()}
      case 'terminalThemes.save':return this.ctx.terminalThemes.save(params.settings)
      case 'bookmarks.watch':client.bookmarkSubscription=randomUUID();return {subscriptionId:client.bookmarkSubscription,epoch:this.epoch,...this.ctx.webBookmarks.snapshot()}
      case 'bookmarks.save':return this.ctx.webBookmarks.save(params)
      case 'bookmarks.remove':return this.ctx.webBookmarks.remove(string(params.id,100),integer(params.expectedVersion,1,Number.MAX_SAFE_INTEGER))
      case 'bookmarks.refresh':return this.ctx.webBookmarks.refresh(string(params.id,100))
      case 'bookmarks.thumbnail':return this.ctx.webBookmarks.thumbnail(string(params.id,100))
      // Deliberately excluded from operation caching: plaintext is only returned to this request.
      case 'bookmarks.reveal':return this.ctx.webBookmarks.reveal(string(params.id,100),integer(params.version,1,Number.MAX_SAFE_INTEGER),string(params.masterPassword??'',1024,true))
      case 'catalog.watch':client.subscription=randomUUID();return {subscriptionId:client.subscription,epoch:this.epoch,...this.ctx.storage.snapshot()}
      case 'catalog.unwatch':client.subscription=undefined;return {}
      case 'catalog.replace':{
        let catalog: CatalogDocument
        try { catalog = parseCatalogImport(params.catalog) } catch { throw new AppError('INVALID_ARGUMENT', '目录格式不正确。') }
        const commitPasswords = this.ctx.credentials.prepareRdpPasswords(params.rdpPasswords, catalog)
        if (params.rdpPasswords !== undefined && params.desktopPasswords !== undefined) throw new AppError('INVALID_ARGUMENT', '不能重复提供桌面密码更新。')
        const commitDesktopPasswords = this.ctx.credentials.prepareDesktopPasswords(params.desktopPasswords, catalog)
        const result = this.ctx.storage.db.transaction(() => {
          const result = this.ctx.storage.replace(catalog,integer(params.expectedRevision,0,Number.MAX_SAFE_INTEGER))
          commitPasswords()
          commitDesktopPasswords()
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
      case 'connections.open':{const serverId=string(params.serverId),connectionId=string(params.connectionId),{connection}=this.ctx.storage.connection(serverId,connectionId);requireConnectionCapacity(this.ctx);if(['adb','wdb','vnc'].includes(connection.type)||(connection.type==='rdp'&&connection.rdpClient!=='native')){if(this.ctx.desktops.size+this.ctx.deviceSessions.size>=4)throw new AppError('BUSY','最多同时打开 4 个桌面或设备画面。')}return this.ctx.connectors.open(connection.type.replace(/^plugin:/,''),client.owner,serverId,connectionId,connection.providerId)}
      case 'sessions.close':return this.ctx.sessions.closeOwned(client.owner,string(params.sessionId))
      case 'ssh.system':return this.ctx.sshInspector.system(client.owner,params)
      case 'ssh.files':return this.ctx.sshInspector.files(client.owner,params)
      case 'devices.close':return this.ctx.deviceSessions.closeOwned(client.owner,string(params.sessionId))
      case 'desktops.close':return this.ctx.desktops.closeOwned(client.owner,string(params.sessionId))
      case 'sessions.hostKeyDecision':return this.ctx.sessions.hostKey(client.owner,params)
      case 'history.sessions':return this.ctx.terminalHistory.list(string(params.serverId))
      case 'history.open':{const sessionId=string(params.sessionId),range=this.ctx.terminalHistory.range(sessionId);client.history={id:randomUUID(),sessionId,...range,expires:Date.now()+1800_000};return {...client.history,capturedAt:Date.now()}}
      case 'history.page':{const range=client.history;if(!range||range.id!==params.snapshotId||range.expires<Date.now())throw new AppError('HISTORY_SNAPSHOT_EXPIRED','历史查询已过期，请刷新。');return this.ctx.terminalHistory.page(params,range)}
      case 'history.close':client.history=undefined;return {}
      case 'operations.get':{const id=string(params.operationId),op=this.operations.get(client.owner+'/'+client.pageId+'/'+id)??this.operations.get(client.owner+'/'+id);return op?{state:op.state,result:op.result,error:op.error}:{state:'unknown'}}
      default:throw new AppError('NOT_FOUND','未提供此方法。')
    }
  }
  private desktop(ws: WebSocket, owner: string) {
    this.wss.emit('connection', ws)
    let id = '', attaching = false
    const timer = setTimeout(() => ws.close(1008), 10_000)
    ws.on('error', () => ws.close()); ws.on('close', () => clearTimeout(timer))
    ws.on('message', (raw, binary) => {
      void (async () => {
        try {
          if (!this.ctx.auth.authorized(owner)) throw new AppError('UNAUTHORIZED', '本机会话已过期。')
          if (!id) {
            if (binary || attaching) throw new AppError('INVALID_ARGUMENT', '请先绑定桌面。')
            attaching = true
            const message = record(JSON.parse(raw.toString()))
            if (message.type !== 'desktop.attach') throw new AppError('INVALID_ARGUMENT', '缺少桌面绑定消息。')
            id = string(message.sessionId); clearTimeout(timer); await this.ctx.desktops.attach(owner, ws, message)
          } else {
            if (binary) this.ctx.desktops.input(owner, id, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),ws)
            else this.ctx.desktops.control(owner, id, ws, JSON.parse(raw.toString()))
          }
        } catch (cause) {
          this.send(ws, { type: 'desktop.error', ...publicError(cause) })
          if (id) this.ctx.desktops.closeAttached(owner, id, ws)
          ws.close(1008)
        }
      })()
    })
  }
  private device(ws:WebSocket,owner:string){
    this.wss.emit('connection',ws)
    let id='',attaching=false,pending=0
    const timer=setTimeout(()=>ws.close(1008),10_000)
    ws.on('error',()=>ws.close());ws.on('close',()=>clearTimeout(timer))
    ws.on('message',(raw,binary)=>{
      if(binary||raw.toString().length>16384||pending>=24){ws.close(1008);return}
      pending++
      void(async()=>{
        try{
          if(!this.ctx.auth.authorized(owner))throw new AppError('UNAUTHORIZED','授权已失效。')
          const message=record(JSON.parse(raw.toString()))
          if(!id){
            if(attaching||message.type!=='device.attach')throw new AppError('INVALID_ARGUMENT','请先绑定设备。')
            attaching=true;id=string(message.sessionId);clearTimeout(timer);await this.ctx.deviceSessions.attach(owner,ws,message)
          }else await this.ctx.deviceSessions.input(owner,id,ws,message)
        }catch(cause){
          this.send(ws,{type:'device.error',...publicError(cause)})
          if(id)this.ctx.deviceSessions.closeAttached(owner,id,ws)
          ws.close(1008)
        }finally{pending--}
      })()
    })
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
          }else if(binary)this.ctx.sessions.input(owner,sessionId,Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer),ws)
          else this.ctx.sessions.control(owner,sessionId,JSON.parse(raw.toString()),ws)
        }catch(cause){this.send(ws,{type:'terminal.error',...publicError(cause)});if(sessionId){try{this.ctx.sessions.closeAttached(owner,sessionId,ws)}catch{}}ws.close(1008)}
      })()
    })
  }
}
