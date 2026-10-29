import { Service, type Context } from 'cordis'
import { Ajv, type ValidateFunction } from 'ajv'
import { randomBytes, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebSocket } from 'ws'
import type { AutomationTaskState, AutomationTaskView, AutomationTool, ServiceCapability } from '@webnav/shared'
import { AppError, integer, record, string } from '../errors.ts'
import { connectionCount } from '../connection-budget.ts'
import { AutomationAuthority } from './authority.ts'
import { AiTerminal } from './terminal.ts'
import { hostTools, pluginTools } from './definitions.ts'
import type { AutomationHandler } from '../../plugin-system/runtime.ts'
import { credentialKey } from '../../plugins/storage.ts'
import { decodeText, encodeText } from '../../plugins/ssh-files/index.ts'
import { hash, stamp, type RemoteFs } from '../../plugins/ssh-files/remote-fs.ts'

type Entry = { name:string;provider:string;revision:string;definition:AutomationTool;handler?:AutomationHandler }
type Task = { view:AutomationTaskView;client:string;owner:string;terminal:AiTerminal;release:()=>void;binding:string;lastUse:number;busy:number;finish?:Promise<unknown>;closed:boolean;finalized:boolean }
type Plan = { entry:Entry;params:Record<string,unknown>;binding:unknown;expires:number;client:string }
declare module 'cordis' { interface Context { automation:AutomationService } }
export class AutomationService extends Service {
  static inject=['storage','credentials','auth','plugins','sessions','sshFiles','sshInspector','terminalHistory','webBookmarks','terminalThemes','desktops','deviceSessions','maintenance']
  readonly authority:AutomationAuthority
  private tasks=new Map<string,Task>()
  private plans=new Map<string,Plan>()
  private tickets=new Map<string,{owner:string;task:string;expires:number}>()
  private snapshots=new Map<string,{client:string;task:string;sessionId:string;lower:number;upper:number;expires:number}>()
  private validators=new Map<string,{input:ValidateFunction;output:ValidateFunction}>()
  private ajv=new Ajv({strict:false,allErrors:false,validateFormats:false})
  private listeners=new Set<()=>void>()
  private revision=0
  private stopping=false
  private calls=new Map<string,number>()
  private port:number
  constructor(ctx:Context,config:{port:number}){
    super(ctx,'automation',true);this.authority=new AutomationAuthority(ctx.storage.directory)
    this.port=config.port
    const timer=setInterval(()=>this.clean(),5000);timer.unref()
    const unwatch=ctx.credentials.subscribe(status=>{if(!status.unlocked){for(const t of this.tasks.values())void this.finish(t,'interrupted',true);this.plans.clear();this.snapshots.clear();this.tickets.clear()}this.publish()})
    ctx.on('dispose',async()=>{this.stopping=true;clearInterval(timer);unwatch();await Promise.allSettled([...this.tasks.values()].map(t=>this.finish(t,'interrupted',true)));for(const t of this.tasks.values())t.terminal.dispose();this.tasks.clear();this.authority.close()})
  }
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  private publish(){this.revision++;for(const listener of this.listeners)listener()}
  private enabled(){return this.ctx.storage.getSetting('automation-enabled')!=='false'}
  require(client:string){if(!this.enabled()||this.stopping)throw new AppError('UNAVAILABLE','MCP 接入已停用。');this.ctx.credentials.requireUnlocked();this.authority.client(client)}
  private browser(owner:string){return this.ctx.auth.authorized(owner)&&this.ctx.credentials.status().unlocked}
  private definitions(){
    const entries:Entry[]=hostTools.map(definition=>({name:definition.id,definition,provider:'host',revision:'1'}))
    for(const [service,definitions] of Object.entries(pluginTools)){
      if(this.ctx.plugins.manager.runningProviders['service:'+service]!=='builtin.'+service)continue
      if(service==='sessions'&&typeof this.ctx.sessions.createManaged!=='function')continue
      const manifest=this.ctx.plugins.manager.builtinDetails.find(b=>b.id==='builtin.'+service)?.manifest
      for(const definition of manifest?.automation?.tools??[])if(definitions.some(d=>d.id===definition.id))entries.push({name:definition.id,definition,provider:'builtin.'+service,revision:manifest!.version})
    }
    for(const entry of this.ctx.plugins.automationEntries()){
      if(entry.definition.execution!=='request')continue
      // A canonical contract is only accepted with the same schemas and permissions.
      const expected=Object.values(pluginTools).flat().find(d=>d.id===entry.definition.contract?.id)
      const comparable=(d:AutomationTool)=>JSON.stringify([d.inputSchema,d.outputSchema,d.scopes,d.access,d.binding])
      const name=expected&&comparable(expected)===comparable(entry.definition)?expected.id:`plugin.${entry.provider}.${entry.definition.id}`
      if(!entries.some(e=>e.name===name))entries.push({name,...entry})
    }
    return entries.filter(entry=>{try{this.validate(entry);return true}catch{return false}})
  }
  private validate(entry:Entry){
    const key=this.authority.hash([entry.provider,entry.revision,entry.definition])
    let validators=this.validators.get(key)
    if(!validators){validators={input:this.ajv.compile(entry.definition.inputSchema),output:this.ajv.compile(entry.definition.outputSchema)};if(this.validators.size>500)this.validators.clear();this.validators.set(key,validators)}
    return validators
  }
  list(client:string){this.require(client);return this.definitions().filter(e=>{try{this.authority.allow(client,e.definition.scopes);return true}catch{return false}}).map(e=>({name:e.name,title:e.definition.title,description:e.definition.description+(e.definition.access==='write'||e.definition.access==='execute'?' 此调用只准备操作，返回 ticket 后调用 workbench_apply。':''),inputSchema:e.definition.inputSchema,outputSchema:{type:'object',properties:{data:{type:'object'},meta:{type:'object'}},required:['data','meta']},annotations:{readOnlyHint:e.definition.access==='read',destructiveHint:e.definition.access!=='read',openWorldHint:true}}))}
  private task(client:string,id:string,active=false){
    const t=this.tasks.get(id);if(!t||t.client!==client)throw new AppError('NOT_FOUND','任务不存在或结果已过期。')
    this.authority.allow(client,[],[t.view.serverId,t.view.connectionId])
    if(active&&(t.finalized||t.view.state==='finishing'||t.view.state==='cancelling'||t.terminal.controller!=='ai'))throw new AppError('CONTROL_CHANGED','任务已结束、正在收尾或已交给人工。')
    if(t.binding!==this.targetBinding(t.view.serverId,t.view.connectionId))throw new AppError('TARGET_CHANGED','连接配置已改变，请结束旧任务后重新开始。')
    t.lastUse=Date.now();return t
  }
  private targetBinding(serverId:string,connectionId:string){const {server,connection}=this.ctx.storage.connection(serverId,connectionId);return this.authority.hash([server.host,server.groupId,connection,this.ctx.storage.db.prepare('SELECT * FROM credentials WHERE id=?').get(credentialKey(serverId,connectionId))])}
  private binding(client:string,entry:Entry,p:Record<string,unknown>){
    const t=typeof p.taskId==='string'?(entry.name==='history_read'?this.historicalTask(client,p.taskId):this.task(client,p.taskId)):undefined
    const target=t?[t.view.serverId,t.view.connectionId]:p.serverId&&p.connectionId?[string(p.serverId),string(p.connectionId)]:undefined
    if(target)this.authority.allow(client,entry.definition.scopes,target as [string,string])
    return {provider:entry.provider,revision:entry.revision,definition:entry.definition,target:target?this.targetBinding(target[0]!,target[1]!):null,grant:this.authority.grant(client)}
  }
  async call(client:string,name:string,params:unknown){
    this.require(client)
    if((this.calls.get(client)??0)>=4||[...this.calls.values()].reduce((n,v)=>n+v,0)>=32)throw new AppError('BUSY','自动化请求额度已满，请等在途操作结束。')
    this.calls.set(client,(this.calls.get(client)??0)+1)
    try{return await this.ctx.maintenance.run(true,()=>this.callChecked(client,name,params))}finally{const count=(this.calls.get(client)??1)-1;if(count)this.calls.set(client,count);else this.calls.delete(client)}
  }
  private async callChecked(client:string,name:string,params:unknown){
    this.require(client)
    const entry=this.definitions().find(e=>e.name===name);if(!entry)throw new AppError('NOT_FOUND','工具未运行或没有有效能力声明。')
    const p=record(params);if(!this.validate(entry).input(p))throw new AppError('INVALID_ARGUMENT','工具参数不符合能力声明。')
    this.authority.allow(client,entry.definition.scopes)
    const binding=this.binding(client,entry,p)
    let data:unknown
    if(entry.definition.access==='write'||entry.definition.access==='execute'){
      let preview:unknown={tool:name,target:p.serverId?{serverId:p.serverId,connectionId:p.connectionId}:p.taskId?{taskId:p.taskId}:undefined}
      if(name==='files_save'&&!entry.handler)preview=await this.file(client,p,'preview')
      this.require(client);if(this.authority.hash(binding)!==this.authority.hash(this.binding(client,entry,p)))throw new AppError('CONFLICT','预览期间授权或目标已变化。')
      if(this.plans.size>=100)throw new AppError('BUSY','准备操作过多，请先处理现有计划。')
      const plan=this.authority.prepare(client,name,p,binding);this.plans.set(plan.operationId,{entry,params:structuredClone(p),binding,expires:plan.expiresAt,client})
      data={...plan,preview,requiresApply:true}
    }else data=await this.run(client,entry,p)
    this.require(client);this.authority.allow(client,entry.definition.scopes)
    if(entry.definition.access==='read'&&this.authority.hash(binding)!==this.authority.hash(this.binding(client,entry,p)))throw new AppError('CONFLICT','读取期间授权或目标已变化。')
    if(entry.definition.access==='read'&&!this.validate(entry).output(data))throw new AppError('INVALID_RESULT','插件返回值不符合声明。')
    const result={data,meta:{provider:entry.provider,version:entry.revision}}
    if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw new AppError('LIMIT','结果超过 512 KiB，请缩小范围。')
    return result
  }
  private async run(client:string,entry:Entry,p:Record<string,unknown>):Promise<unknown>{
    if(entry.handler){
      const capability=entry.definition.binding.capability,services=capability?.startsWith('service:')?[capability.slice(8) as ServiceCapability]:[]
      const release=this.ctx.plugins.acquireAutomation(services,entry.provider),abort=new AbortController()
      const timer=setTimeout(()=>abort.abort(),30_000)
      try {const data=await entry.handler(p,{clientId:client,signal:abort.signal});this.require(client);this.authority.allow(client,entry.definition.scopes);if(!this.validate(entry).output(data))throw new AppError('INVALID_RESULT','插件返回值不符合声明。');return data}finally{clearTimeout(timer);release()}
    }
    if(entry.name==='workbench_apply')return this.apply(client,string(p.operationId),string(p.ticket))
    if(entry.name==='operation_status'){const r=this.authority.operation(string(p.operationId),client);return {operationId:r.id,state:r.state,result:r.result?JSON.parse(r.result):null}}
    if(entry.name==='task_finish')return this.finish(this.task(client,string(p.taskId)),p.outcome as 'succeeded'|'failed'|'cancelled')
    if(entry.name==='task_status'){const t=this.task(client,string(p.taskId));return {...this.view(t),output:t.terminal.read(integer(p.after??0,0,Number.MAX_SAFE_INTEGER))}}
    if(entry.name==='catalog_list'){
      const snapshot=this.ctx.storage.snapshot(),grant=this.authority.grant(client),servers=snapshot.snapshot.servers.flatMap(s=>{const connections=s.connections.filter(c=>grant.targets===null||grant.targets.some(t=>t[0]===s.id&&t[1]===c.id));return connections.length?[{id:s.id,name:s.name,host:s.host,groupId:s.groupId,connections:connections.map(c=>({id:c.id,type:c.type,name:c.name,port:c.port}))}]:[]})
      const offset=integer(p.offset??0,0,Number.MAX_SAFE_INTEGER),limit=integer(p.limit??100,1,200);return {revision:snapshot.revision,servers:servers.slice(offset,offset+limit),nextOffset:offset+limit<servers.length?offset+limit:null}
    }
    if(entry.name==='plugins_list')return {plugins:[...this.ctx.plugins.manager.builtinDetails.map(b=>({id:b.id,name:b.name,automation:b.manifest.automation})),...this.ctx.plugins.manager.running.values()].map(b=>'manifest' in b?{id:b.manifest.id,name:b.manifest.name,automation:b.manifest.automation}:b),availableTools:this.list(client).map(t=>t.name)}
    if(entry.name==='ssh_open')return this.open(client,p)
    if(entry.name==='ssh_input'){const t=this.task(client,string(p.taskId),true);return t.terminal.input(integer(p.controlEpoch,1,Number.MAX_SAFE_INTEGER),integer(p.seq,1,Number.MAX_SAFE_INTEGER),string(p.text,16384),this.authority.hash(p.text))}
    if(entry.name==='files_list'||entry.name==='files_read'||entry.name==='files_save')return this.file(client,p,entry.name==='files_list'?'list':entry.name==='files_read'?'read':'save')
    if(entry.name==='history_list')return {tasks:(this.authority.db.prepare('SELECT id,state,metadata FROM tasks WHERE client=? ORDER BY created DESC LIMIT 200').all(client) as {id:string;state:string;metadata:string|null}[]).flatMap(row=>{try{const saved=this.historicalTask(client,row.id);return [{...saved.view,state:row.state,connected:this.tasks.get(row.id)?.terminal.connected??false}]}catch{return []}})}
    if(entry.name==='history_read'){
      const t=this.historicalTask(client,string(p.taskId));let id=typeof p.snapshot==='string'?p.snapshot:undefined,snapshot=id?this.snapshots.get(id):undefined
      if(id&&(!snapshot||snapshot.client!==client||snapshot.task!==t.view.id||snapshot.expires<Date.now()))throw new AppError('EXPIRED','历史快照已过期，请重新打开。')
      if(!snapshot){if(this.snapshots.size>=100)throw new AppError('BUSY','历史查询过多。');id=randomUUID();snapshot={client,task:t.view.id,sessionId:t.view.sessionId,...this.ctx.terminalHistory.range(t.view.sessionId),expires:Date.now()+300_000};this.snapshots.set(id,snapshot)}
      return {snapshot:id,...this.ctx.terminalHistory.page(p,snapshot)}
    }
    if(entry.name==='themes_list')return this.ctx.terminalThemes.snapshot()
    if(entry.name==='bookmarks_list')return {bookmarks:this.ctx.webBookmarks.snapshot().bookmarks.map(b=>({id:b.id,name:b.name,url:b.url}))}
    if(entry.name==='system_read'){const t=this.task(client,string(p.taskId),true);return this.taskWork(t,()=>this.ctx.sshInspector.system(t.owner,{sessionId:t.view.sessionId}))}
    throw new AppError('NOT_IMPLEMENTED','此能力没有运行处理器。')
  }
  private async apply(client:string,id:string,ticket:string){
    const row=this.authority.operation(id,client);this.authority.checkTicket(row,ticket)
    if(row.state!=='prepared')return {operationId:id,state:row.state,result:row.result?JSON.parse(row.result):null}
    const plan=this.plans.get(id)
    if(!plan||plan.client!==client||row.expires<Date.now())throw new AppError('EXPIRED','操作预览已过期或服务已重启，不能执行。')
    const entry=this.definitions().find(e=>e.name===row.tool)
    if(!entry||this.authority.hash([plan.params,this.binding(client,entry,plan.params)])!==row.digest)throw new AppError('CONFLICT','授权、配置或运行插件已变更，请重新预览。')
    this.authority.allow(client,entry.definition.scopes)
    this.authority.db.prepare("UPDATE operations SET state='running' WHERE id=? AND state='prepared'").run(id)
    this.plans.delete(id)
    try {
      const result=await this.run(client,entry,plan.params)
      // Persist only non-sensitive reconciliation metadata, never input/file contents or plugin results.
      const safe=!entry.handler&&['ssh_open','files_save'].includes(entry.name)?result:{completed:true}
      this.authority.db.prepare("UPDATE operations SET state='succeeded',result=? WHERE id=?").run(JSON.stringify(safe),id)
      return {operationId:id,state:'succeeded',result}
    }catch(error){this.authority.db.prepare("UPDATE operations SET state='unknown' WHERE id=?").run(id);throw error}
  }
  private open(client:string,p:Record<string,unknown>){
    const serverId=string(p.serverId),connectionId=string(p.connectionId);this.authority.allow(client,['ssh.execute'],[serverId,connectionId])
    if(this.ctx.plugins.manager.runningProviders['service:sessions']!=='builtin.sessions')throw new AppError('PLUGIN_UNAVAILABLE','当前 SSH 提供者尚未支持后台 AI 会话。')
    const active=[...this.tasks.values()].filter(t=>!t.closed)
    if(active.length>=4||active.filter(t=>t.client===client).length>=2||connectionCount(this.ctx)>=8)throw new AppError('BUSY','AI 或工作区连接额度已满。')
    const {connection}=this.ctx.storage.connection(serverId,connectionId)
    if(connection.type!=='ssh')throw new AppError('INVALID_ARGUMENT','请选择 SSH 入口。')
    const bindings=JSON.parse(this.ctx.storage.getSetting('sync-bindings')??'[]') as string[]
    if(bindings.includes(credentialKey(serverId,connectionId)))throw new AppError('LOCAL_BINDING_REQUIRED','请先在工作台确认恢复的本机绑定。')
    if(this.ctx.plugins.manager.pending.size&&[...this.ctx.plugins.manager.pending.values()].some(p=>p.kind==='waiting'))throw new AppError('PLUGIN_DRAINING','插件正在等待资源释放，请稍后新建任务。')
    const release=this.ctx.plugins.acquireAutomation(['sessions','terminalHistory','sshFiles','sshInspector']),id=randomUUID(),owner='ai:'+client+':'+id
    const view:AutomationTaskView={id,sessionId:'',clientName:this.authority.client(client).name,name:string(p.name,100),serverId,connectionId,state:'running',message:'正在连接',connected:false,createdAt:Date.now(),expiresAt:Date.now()+integer(p.timeoutSeconds??1800,30,3600)*1000,controller:'ai',controlEpoch:1}
    let task!:Task
    const terminal=new AiTerminal({
      input:bytes=>{task.lastUse=Date.now();this.ctx.sessions.input(owner,view.sessionId,bytes)},resize:(cols,rows)=>this.ctx.sessions.control(owner,view.sessionId,{type:'terminal.resize',cols,rows}),
      authorized:o=>this.browser(o),confirm:p=>{this.ctx.sessions.hostKey(owner,{...p,sessionId:view.sessionId});view.message='正在连接';this.publish()},
      changed:()=>{if(task){if(!task.finalized&&!['finishing','cancelling'].includes(view.state)){if(terminal.pendingKey){view.state='waiting_user';view.message='等待用户确认主机指纹'}else if(terminal.connected){view.state='running';view.message=terminal.controller==='user'?'人工接管中':terminal.controller==='none'?'等待交还控制权':'AI 正在工作'}}if(task.finalized&&!task.closed&&terminal.controller==='none')void this.closeTask(task);this.publish()}},
      returned:()=>{if(task.finalized)void this.closeTask(task)},
    })
    task={view,client,owner,terminal,release,binding:this.targetBinding(serverId,connectionId),lastUse:Date.now(),busy:0,closed:false,finalized:false}
    try{
      const opened=this.ctx.sessions.createManaged(owner,serverId,connectionId,{authorized:()=>{try{this.require(client);this.authority.allow(client,['ssh.execute'],[serverId,connectionId]);return task.binding===this.targetBinding(serverId,connectionId)}catch{return false}},output:bytes=>terminal.write(bytes),event:data=>terminal.event(data),closed:reason=>{
        if(!task.closed){task.closed=true;terminal.disconnect(reason);release();if(!task.finalized){view.state='interrupted';view.message=reason;task.finalized=true;this.saveTask(task)}this.trimResults(task.view.id);this.publish()}
      }})
      view.sessionId=opened.sessionId;this.tasks.set(id,task);this.saveTask(task);this.publish();return {taskId:id,sessionId:view.sessionId,controlEpoch:1,state:view.state}
    }catch(e){release();terminal.dispose();throw e}
  }
  private saveTask(t:Task){this.authority.db.prepare('INSERT OR REPLACE INTO tasks(id,client,state,created,metadata) VALUES (?,?,?,?,?)').run(t.view.id,t.client,t.view.state,t.view.createdAt,JSON.stringify({view:this.view(t),binding:t.binding}))}
  private historicalTask(client:string,id:string):{view:AutomationTaskView;binding:string}{
    const row=this.authority.db.prepare('SELECT metadata,state FROM tasks WHERE id=? AND client=?').get(id,client) as {metadata:string|null;state:AutomationTaskState}|undefined
    if(!row?.metadata)throw new AppError('NOT_FOUND','历史任务不存在或已清理。')
    const saved=JSON.parse(row.metadata) as {view:AutomationTaskView;binding:string}
    this.authority.allow(client,['history.read'],[saved.view.serverId,saved.view.connectionId])
    if(saved.binding!==this.targetBinding(saved.view.serverId,saved.view.connectionId))throw new AppError('TARGET_CHANGED','历史任务的目标配置已经改变。')
    saved.view.state=row.state;return saved
  }
  private async taskWork<T>(t:Task,run:()=>Promise<T>){t.busy++;try{return await run()}finally{t.busy--}}
  private async path(t:Task,fs:RemoteFs,path:string){
    if(!path.startsWith('/')||path.includes('\\')||path.split('/').includes('..'))throw new AppError('FORBIDDEN','文件工具需要授权目录内的绝对路径。')
    const canonical=await fs.realpath(path),grant=this.authority.grant(t.client)
    if(!grant.paths.some(root=>canonical===root||canonical.startsWith(root==='/'?'/':root+'/')))throw new AppError('FORBIDDEN','路径或符号链接目标超出授权目录。')
    return canonical
  }
  private async file(client:string,p:Record<string,unknown>,action:'list'|'read'|'preview'|'save'){
    const t=this.task(client,string(p.taskId),true),scope=action==='save'||action==='preview'?'files.write':'files.read'
    this.authority.allow(client,[scope],[t.view.serverId,t.view.connectionId])
    return this.taskWork(t,()=>this.ctx.sshFiles.withRemote(t.owner,t.view.sessionId,async fs=>{
      const path=await this.path(t,fs,string(p.path,1024))
      if(action==='list') {const entries=await fs.children(path),offset=integer(p.offset??0,0,Number.MAX_SAFE_INTEGER);return {path,entries:entries.slice(offset,offset+200).map(e=>({name:e.filename,kind:(e.attrs.mode&0o170000)===0o040000?'directory':(e.attrs.mode&0o170000)===0o120000?'link':'file',size:e.attrs.size})),nextOffset:offset+200<entries.length?offset+200:null}}
      const before=decodeText(path,await fs.readFile(path,128*1024))
      if(action==='read')return before
      if(before.version!==p.version)throw new AppError('CONFLICT','远端文件已变化，请重新读取并合并。')
      const bytes=encodeText(p);if(bytes.length>128*1024)throw new AppError('LIMIT','AI 文件编辑最多 128 KiB。')
      if(action==='preview')return {path,version:before.version,before:before.text,after:p.text}
      this.require(client);this.task(client,t.view.id,true);this.authority.allow(client,[scope],[t.view.serverId,t.view.connectionId])
      if(await this.path(t,fs,string(p.path))!==path)throw new AppError('CONFLICT','路径目标发生变化。')
      await fs.writeFile(path,bytes,stamp(await fs.fileStat(path)),before.version)
      return {path,version:hash(bytes)}
    }))
  }
  private async finish(t:Task,outcome:'succeeded'|'failed'|'cancelled'|'interrupted',force=false):Promise<unknown>{
    if(t.finalized){if(force)await this.closeTask(t);return this.view(t)}
    if(t.finish)return t.finish
    t.finish=(async()=>{
      t.view.state=outcome==='cancelled'?'cancelling':'finishing';this.publish()
      await t.terminal.finish()
      const until=Date.now()+30_000
      while(t.busy&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20))
      if(t.busy)outcome='interrupted'
      t.finalized=true
      const message=outcome==='succeeded'?'任务已结束，连接已释放。':outcome==='cancelled'?'已取消，连接已释放。':outcome==='interrupted'?'已中断，连接已释放。':'任务失败，连接已释放。'
      if(force||t.terminal.controller!=='user')await this.closeTask(t,message)
      t.view.state=outcome;if(!t.closed)t.view.message='AI 已结束，人工仍在使用'
      this.saveTask(t);this.trimResults(t.view.id);this.publish();return this.view(t)
    })();return t.finish
  }
  private async closeTask(t:Task,message='任务已结束，连接已释放。'){
    if(t.closed)return
    try{const complete=await this.ctx.sessions.drainManaged(t.owner,t.view.sessionId);if(!complete)message+='尾部输出未完整收取。'}catch{}
    t.closed=true;t.view.message=message;this.ctx.sessions.close(t.view.sessionId);t.terminal.disconnect(message);t.release();this.saveTask(t);this.publish()
  }
  private view(t:Task):AutomationTaskView{return {...t.view,connected:t.terminal.connected,controller:t.terminal.controller,controlEpoch:t.terminal.controlEpoch}}
  watch(){return {revision:this.revision,tasks:[...this.tasks.values()].map(t=>this.view(t))}}
  settings(){return {enabled:this.enabled(),clients:this.authority.clients(),grants:this.authority.grants(),tools:this.definitions().map(e=>({name:e.name,title:e.definition.title,provider:e.provider,scopes:e.definition.scopes})),serverKey:this.authority.publicKey}}
  async manage(owner:string,method:string,p:Record<string,unknown>){
    if(!this.browser(owner))throw new AppError('UNAUTHORIZED','请先解锁工作台。')
    if(method==='automation.settings')return this.settings()
    if(method==='automation.grant'){const grant=this.authority.saveGrant(p);this.recheck();return grant}
    if(method==='automation.pair'){
      const pairing=this.authority.begin(string(p.name,80),string(p.grantId,100)),development=import.meta.url.endsWith('.ts')
      const port=this.port,profile=join(this.ctx.storage.directory,'ai-clients',randomUUID(),'identity.json')
      return {...pairing,config:{mcpServers:{webnav:{command:process.execPath,args:[...(development?['--experimental-strip-types']:[]),fileURLToPath(new URL('../../mcp-bridge.'+(development?'ts':'js'),import.meta.url)),'--profile',profile,'--url',`ws://127.0.0.1:${port}/ws/automation`,'--server-key',pairing.serverKey,'--pairing-code',pairing.code]}}}}
    }
    if(method==='automation.revoke'){this.authority.revoke(string(p.id));this.recheck();return {revoked:true}}
    if(method==='automation.enabled'){this.ctx.storage.setSetting('automation-enabled',p.enabled===true?'true':'false');this.recheck();return this.settings()}
    if(method==='automation.close'){const t=[...this.tasks.values()].find(t=>t.view.sessionId===p.sessionId);if(t)await this.finish(t,'cancelled',true);return {closed:true}}
    if(method==='automation.attach'){
      const t=[...this.tasks.values()].find(t=>t.view.sessionId===p.sessionId);if(!t)throw new AppError('NOT_FOUND','任务结果已过期。')
      if(this.tickets.size>=64)throw new AppError('BUSY','观察票据过多。')
      const token=randomBytes(32).toString('hex');this.tickets.set(token,{owner,task:t.view.id,expires:Date.now()+30_000});return {attachToken:token}
    }
    throw new AppError('NOT_FOUND','未知 AI 设置操作。')
  }
  async attach(owner:string,ws:WebSocket,p:Record<string,unknown>){
    const token=string(p.attachToken),ticket=this.tickets.get(token);this.tickets.delete(token)
    const t=ticket?this.tasks.get(ticket.task):undefined
    if(!ticket||!t||ticket.owner!==owner||ticket.expires<Date.now()||!this.browser(owner)||t.view.sessionId!==p.sessionId)throw new AppError('FORBIDDEN','观察票据无效。')
    await t.terminal.attach(owner,ws)
  }
  private recheck(){for(const t of this.tasks.values())if(!t.closed){try{this.require(t.client);this.authority.allow(t.client,['ssh.execute'],[t.view.serverId,t.view.connectionId]);if(t.binding!==this.targetBinding(t.view.serverId,t.view.connectionId))throw new AppError('TARGET_CHANGED','目标已变化。')}catch{void this.finish(t,'interrupted',true)}}this.publish()}
  private trimResults(protect?:string){
    const ended=[...this.tasks.values()].filter(t=>t.closed).sort((a,b)=>Number(b.view.id===protect)-Number(a.view.id===protect)||b.view.createdAt-a.view.createdAt)
    for(const [index,t]of ended.entries())if(index>=8||Date.now()-t.lastUse>1800_000){t.terminal.dispose();this.tasks.delete(t.view.id);this.publish()}
  }
  private clean(){
    for(const [id,p]of this.plans)if(p.expires<Date.now())this.plans.delete(id)
    for(const [id,p]of this.tickets)if(p.expires<Date.now())this.tickets.delete(id)
    for(const [id,p]of this.snapshots)if(p.expires<Date.now())this.snapshots.delete(id)
    this.trimResults()
    for(const t of this.tasks.values())if(!t.closed&&(Date.now()>t.view.expiresAt||Date.now()-t.lastUse>600_000))void this.finish(t,'interrupted',true)
    this.recheck();this.authority.clean()
  }
}
