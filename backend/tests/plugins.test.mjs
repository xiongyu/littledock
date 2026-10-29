import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Context } from 'cordis'
import { WebSocket } from 'ws'
import { parsePluginManifest, parsePluginIndex, pluginCategories, parseCatalogImport } from '@webnav/shared'
import { PluginManager } from '../src/plugin-system/manager.ts'
import { runFile } from '../src/plugin-system/git.ts'
import { PluginScope } from '../src/plugin-system/lifecycle.ts'
import { ConnectorService } from '../src/plugins/sessions.ts'
import { createApp } from '../src/app.ts'

const sample=resolve('../examples/plugins/midnight-themes')
const manifest=JSON.parse(await readFile(join(sample,'webnav.plugin.json'),'utf8'))
const url='https://example.invalid/midnight.git'
const disposers=new Map()
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'webnav-plugins-'));t.after(async()=>{await disposers.get(dir)?.();await rm(dir,{recursive:true,force:true})});return dir}
async function commit(repo){await runFile('git',['add','.'],repo);await runFile('git',['-c','user.name=WebNav Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],repo);return (await runFile('git',['rev-parse','HEAD'],repo)).trim()}
async function repo(t){const root=await directory(t),path=join(root,'repository');await cp(sample,path,{recursive:true});await runFile('git',['init'],path);await commit(path);return {root,path}}
function mirror(manager,repository){let reads=0;manager.fetch=async(repositoryUrl,ref)=>{reads++;const target=join(manager.root,'repositories',createHash('sha256').update(repositoryUrl).digest('hex'));await mkdir(target,{recursive:true});await runFile('git',['init','--bare',target],target);await runFile('git',['fetch','--depth=1',repository,ref],target);return (await runFile('git',['rev-parse','FETCH_HEAD'],target)).trim()};return ()=>reads}
async function completed(manager,result,owner='owner'){for(let i=0;i<500;i++){const job=manager.jobStatus(owner,{jobId:result.jobId});if(job.state==='succeeded')return job.result;if(job.state==='failed')throw new Error(job.error);await new Promise(r=>setTimeout(r,20))}throw new Error('job timeout')}
async function install(manager){const preview=await completed(manager,manager.prepare('owner',{repository:url}));assert.equal(preview.compatible,true,preview.reasons.join('\n'));await completed(manager,manager.install('owner',{token:preview.token,commit:preview.commit,acceptRisk:true,expectedRevision:manager.registry.revision}));return preview}
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port}

test('plugin specification validates fixed categories, platform tuples, paths, identities and provenance',()=>{
  assert.equal(Object.keys(pluginCategories).length,17)
  assert.equal(parsePluginManifest(manifest).id,manifest.id)
  for(const override of [{reload:'unknown'},{category:'custom'},{secondaryCategories:['terminal','files','backup']},{platforms:[]},{platforms:[{os:'win32',arch:'x86'}]},{icon:'../secret.svg'},{id:'builtin.ssh'},{apiVersion:2},{capabilities:[{id:'service:credentials',version:1}]}])assert.throws(()=>parsePluginManifest({...manifest,...override}))
  const entry={id:manifest.id,name:manifest.name,description:manifest.description,repository:url,category:manifest.category,platforms:manifest.platforms}
  assert.equal(parsePluginIndex({schemaVersion:1,plugins:[entry]}).plugins[0].publisher,'community')
  assert.throws(()=>parsePluginIndex({schemaVersion:1,plugins:[entry,entry]}))
})

test('repository metadata and icons persist; reading and preview never execute installation scripts; commit stays pinned',async t=>{
  const {root,path}=await repo(t),data=join(root,'data'),manager=new PluginManager(data);await manager.initialize();const reads=mirror(manager,path)
  await writeFile(join(path,'install.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('installed-proof.txt','yes')")
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,install:[{command:'node',args:['install.mjs']}]}));const first=await commit(path)
  const detail=await manager.details(url);assert.match(detail.iconDataUrl,/^data:image\/svg\+xml;base64,/);assert.equal(detail.commit,first)
  await manager.details(url);assert.equal(reads(),1)
  const restarted=new PluginManager(data);await restarted.initialize();restarted.fetch=()=>{throw new Error('network must not be used')};assert.equal((await restarted.details(url)).cached,true)
  const preview=await completed(manager,manager.prepare('owner',{repository:url}));assert.equal(preview.commit,first)
  assert.throws(()=>manager.install('owner',{token:preview.token,commit:first,expectedRevision:0}),{code:'RISK_NOT_ACCEPTED'})
  assert.throws(()=>manager.install('other',{token:preview.token,commit:first,expectedRevision:0,acceptRisk:true}),{code:'PREVIEW_EXPIRED'})
  assert.throws(()=>manager.install('owner',{token:preview.token,commit:'a'.repeat(40),expectedRevision:0,acceptRisk:true}),{code:'PREVIEW_EXPIRED'})
  await writeFile(join(path,'README.md'),'Moved branch');await commit(path)
  const result=manager.install('owner',{token:preview.token,commit:first,expectedRevision:0,acceptRisk:true});assert.throws(()=>manager.jobStatus('other',{jobId:result.jobId}),{code:'NOT_FOUND'});await completed(manager,result)
  const plugin=manager.registry.installed[0];assert.equal(plugin.commit,first);assert.equal(plugin.enabled,true)
  assert.equal(await readFile(join(manager.path(plugin),'installed-proof.txt'),'utf8'),'yes')
  assert.match(await readFile(join(manager.path(plugin),'README.md'),'utf8'),/午夜配色示例/)
  await manager.change({id:manifest.id,action:'uninstall',expectedRevision:1});assert.ok((await readdir(join(manager.root,'repositories'))).length)
  assert.equal((await manager.details(url)).cached,true)
})

test('platform, engine and missing dependency checks block installation; failed update preserves the installed release',async t=>{
  const {root,path}=await repo(t),manager=new PluginManager(join(root,'data'));await manager.initialize();mirror(manager,path)
  assert.match((await manager.compatibility({...manifest,platforms:[{os:'other',arch:'other'}]})).join(''),/宿主/)
  assert.match((await manager.compatibility({...manifest,node:'>=999',dependencies:{'missing.plugin':'^1.0.0'}})).join(''),/Node.js.*缺少已启用依赖/s)
  const original=await install(manager)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version:'1.0.1',install:[{command:'node',args:['-e','process.exit(1)']}]}));await commit(path)
  const preview=await completed(manager,manager.prepare('owner',{repository:url}));await assert.rejects(completed(manager,manager.install('owner',{token:preview.token,commit:preview.commit,acceptRisk:true,expectedRevision:1})))
  assert.equal(manager.registry.installed[0].commit,original.commit)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version:'2.0.0',dataVersion:2}));await commit(path)
  const migration=await completed(manager,manager.prepare('owner',{repository:url}));assert.equal(migration.compatible,false);assert.match(migration.reasons.join(''),/数据格式/)
})

test('update previews compare pinned releases and declarations without running candidate code',async t=>{
  const {root,path}=await repo(t),manager=new PluginManager(join(root,'data'));await manager.initialize();mirror(manager,path)
  const first=await install(manager);assert.equal(first.change,'install');assert.equal(first.registryRevision,0)
  const current=await completed(manager,manager.prepare('owner',{repository:url}));assert.equal(current.change,'current');assert.equal(current.installedRelease.commit,first.commit)
  const automation={version:1,description:'Test declaration',tools:[{id:'inspect',version:1,title:'检查',description:'Read test status',inputSchema:{type:'object'},outputSchema:{type:'object'},access:'read',scopes:['plugin.test.read'],execution:'request',binding:{kind:'plugin'}}]}
  for(const [version,change] of [['1.0.0','rebuild'],['0.9.0','downgrade'],['1.1.0','upgrade']]){
    await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version,automation,install:[{command:'node',args:['-e','process.exit(1)']}]}));const target=await commit(path)
    const preview=await completed(manager,manager.prepare('owner',{repository:url}))
    assert.equal(preview.change,change);assert.equal(preview.commit,target);assert.equal(preview.installedRelease.version,'1.0.0')
    assert.match(preview.changes.join('\n'),/新增 AI 工具.*安装步骤变化/s)
    assert.ok(preview.changes.some(change=>change.includes('未开放 → 读取 / plugin.test.read')))
    assert.equal(manager.registry.installed[0].commit,first.commit,'inspection does not install or run the failing script')
  }
})

test('a preview cannot be reused after settings change even when the caller supplies the latest revision',async t=>{
  const {root,path}=await repo(t),manager=new PluginManager(join(root,'data'));await manager.initialize();mirror(manager,path);await install(manager)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version:'1.0.1'}));await commit(path)
  const preview=await completed(manager,manager.prepare('owner',{repository:url}))
  await manager.change({id:manifest.id,action:'disable',expectedRevision:manager.registry.revision})
  for(const revision of [preview.registryRevision,manager.registry.revision])assert.throws(()=>manager.install('owner',{token:preview.token,commit:preview.commit,acceptRisk:true,expectedRevision:revision}),{code:'REVISION_CONFLICT'})
  const refreshed=await install(manager);assert.equal(refreshed.registryRevision,2);assert.equal(manager.registry.installed[0].enabled,false)
})

test('independent plugin replaces backend service, serves its frontend, restores built-in and supports safe-mode boot',async t=>{
  const {root,path}=await repo(t),data=join(root,'data'),manager=new PluginManager(data);await manager.initialize();mirror(manager,path);await install(manager)
  await manager.change({id:manifest.id,action:'select',expectedRevision:1})
  const frontendRoot=join(root,'ui');await mkdir(frontendRoot);await writeFile(join(frontendRoot,'index.html'),'<html>test</html>')
  const config={directory:data,port:await freePort(),frontendRoot}
  let ctx=await createApp(config);disposers.set(root,()=>ctx.stop())
  assert.equal(ctx.terminalThemes.snapshot().defaultId,'midnight')
  assert.equal(ctx.plugins.manager.runningProviders['service:terminalThemes'],manifest.id)
  assert.deepEqual(await ctx.plugins.dispatch('owner','plugin.example.midnight-themes.about',{}),{name:manifest.name,version:'1.0.0'})
  const origin=`http://127.0.0.1:${config.port}`,cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0],asset=ctx.plugins.assets()[0].entry
  assert.equal((await fetch(origin+asset)).status,403)
  assert.equal((await fetch(origin+asset,{headers:{cookie}})).status,200)
  assert.equal((await fetch(origin+asset.replace('ui/index.js','backend.mjs'),{headers:{cookie}})).status,404)
  await ctx.terminalThemes.save({revision:0,defaultId:'paper',themes:[]})
  await ctx.plugins.manager.change({id:'builtin.terminalThemes',action:'select',expectedRevision:2})
  await ctx.stop();ctx=await createApp(config)
  assert.equal(ctx.plugins.manager.runningProviders['service:terminalThemes'],'builtin.terminalThemes')
  assert.equal(ctx.terminalThemes.snapshot().defaultId,'forest')
  await ctx.plugins.manager.change({id:manifest.id,action:'select',expectedRevision:3});await ctx.stop();ctx=await createApp({...config,disablePlugins:true})
  assert.equal(ctx.plugins.manager.running.size,0);assert.equal(ctx.terminalThemes.snapshot().defaultId,'forest')
})

test('connector selection has explicit providers and cleanup; missing plugin configuration round-trips intact',async()=>{
  const ctx=new Context();ctx.plugin(ConnectorService)
  const remove=ctx.connectors.register('ssh',()=>({kind:'alternate'}),'example.connector')
  ctx.connectors.register('ssh',()=>({kind:'builtin'}))
  assert.deepEqual(ctx.connectors.open('ssh','owner','server','connection'),{kind:'builtin'})
  ctx.connectors.configure({'connector:ssh':'example.connector'})
  assert.deepEqual(ctx.connectors.open('ssh','owner','server','connection'),{kind:'alternate'})
  assert.deepEqual(ctx.connectors.open('ssh','owner','server','connection','builtin'),{kind:'builtin'})
  remove();remove();assert.throws(()=>ctx.connectors.open('ssh','owner','server','connection'),{code:'PLUGIN_UNAVAILABLE'})
  const connection={id:'connection',name:'Custom',type:'plugin:example.custom',port:1234,providerId:'missing.plugin',pluginSettings:{theme:'custom',count:2}}
  const doc={schemaVersion:1,groups:[],servers:[{id:'server',name:'Synthetic',host:'127.0.0.1',groupId:'',tags:[],note:'',favorite:false,connections:[connection]}]}
  assert.deepEqual(parseCatalogImport(doc).servers[0].connections[0],connection)
  await ctx.stop()
})

test('static marketplace themes install without code, do not require restart, and reject executable theme payloads',async t=>{
  const root=await directory(t),path=join(root,'theme-repo')
  await cp(resolve('../examples/plugins/deep-sea-theme'),path,{recursive:true})
  const theme=JSON.parse(await readFile(join(path,'webnav.plugin.json'),'utf8'))
  assert.equal(parsePluginManifest(theme).category,'themes')
  assert.throws(()=>parsePluginManifest({...theme,backend:'backend.mjs'}),/主题/)
  assert.throws(()=>parsePluginManifest({...theme,install:[{command:'node',args:[]}]}),/主题/)
  assert.throws(()=>parsePluginManifest({...theme,theme:{...theme.theme,accent:'url(https://tracking.invalid)'}}),/配色/)
  assert.throws(()=>parsePluginManifest({...theme,theme:undefined,frontend:'ui/index.js'}),/主题/)
  theme.theme.backgrounds={left:'background.svg'}
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify(theme))
  await writeFile(join(path,'background.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#132c3b"/></svg>')
  await writeFile(join(path,'private.txt'),'not a public theme resource')
  await runFile('git',['init'],path);await commit(path)
  const manager=new PluginManager(join(root,'data'));await manager.initialize();mirror(manager,path)
  const original=await install(manager)
  assert.equal((await manager.state()).restartRequired,false)
  assert.equal(manager.registry.installed[0].manifest.theme.accent,'#237a82')
  assert.equal(manager.registry.installed[0].manifest.backend,undefined)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...theme,version:'1.0.1',theme:{...theme.theme,backgrounds:undefined}}));await commit(path);await install(manager)
  await manager.change({id:theme.id,action:'uninstall',expectedRevision:2})
  assert.equal((await manager.state()).restartRequired,false)
  const frontendRoot=join(root,'ui');await mkdir(frontendRoot);await writeFile(join(frontendRoot,'index.html'),'<html>test</html>')
  const port=await freePort(),ctx=await createApp({directory:join(root,'data'),port,frontendRoot});disposers.set(root,()=>ctx.stop())
  const origin=`http://127.0.0.1:${port}`,cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0]
  const asset=`/plugins/${theme.id}/${original.commit}/background.svg`
  assert.equal((await fetch(origin+asset)).status,403)
  assert.equal((await fetch(origin+asset,{headers:{cookie}})).status,200,'saved background survives theme upgrade and uninstall')
  assert.equal((await fetch(origin+asset.replace('background.svg','private.txt'),{headers:{cookie}})).status,404)
})

test('market index uses persistent last-good cache after network or index failure',async t=>{
  const {root,path}=await repo(t),directory=join(root,'data'),manager=new PluginManager(directory)
  const entry={id:manifest.id,name:manifest.name,description:manifest.description,repository:url,category:manifest.category,platforms:manifest.platforms}
  await writeFile(join(path,'index.json'),JSON.stringify({schemaVersion:1,plugins:[entry]}));await commit(path)
  await manager.initialize();const reads=mirror(manager,path)
  const first=await manager.market(true);assert.equal(first.index.plugins.length,1);assert.equal(first.error,undefined)
  assert.equal((await manager.market(false)).cached,true);assert.equal(reads(),1)
  await writeFile(join(path,'index.json'),'invalid');await commit(path)
  const failed=await manager.market(true);assert.equal(failed.index.plugins.length,1);assert.ok(failed.error);assert.equal(failed.fetchedAt,first.fetchedAt)
  const restarted=new PluginManager(directory);await restarted.initialize();restarted.fetch=async()=>{throw new Error('offline')}
  const offline=await restarted.market(true);assert.equal(offline.index.plugins[0].id,manifest.id);assert.ok(offline.error)
})

async function runningFixture(t){
  const {root,path}=await repo(t),frontendRoot=join(root,'ui');await mkdir(frontendRoot);await writeFile(join(frontendRoot,'index.html'),'<html>test</html>')
  const config={directory:join(root,'data'),port:await freePort(),frontendRoot},ctx=await createApp(config)
  disposers.set(root,()=>ctx.stop());mirror(ctx.plugins.manager,path)
  return {root,path,config,ctx,manager:ctx.plugins.manager}
}

test('hot install, update, restore and disable preserve transport identity and live subscriptions; bad activation retains the old release',async t=>{
  const {ctx,manager,path}=await runningFixture(t),transport=ctx.transport.epoch,events=[]
  const remove=ctx.terminalThemes.subscribe(()=>events.push(ctx.terminalThemes.snapshot().defaultId));t.after(remove)
  await install(manager);assert.equal(manager.running.size,1);assert.equal((await manager.state()).restartRequired,false)
  await manager.change({id:manifest.id,action:'select',expectedRevision:manager.registry.revision})
  assert.equal(ctx.terminalThemes.snapshot().defaultId,'midnight');assert.equal(ctx.transport.epoch,transport)
  const backend=await readFile(join(path,'backend.mjs'),'utf8')
  await writeFile(join(path,'backend.mjs'),backend.replace("defaultId: 'midnight'","defaultId: 'paper'"));await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version:'1.0.1'}));await commit(path);const good=await install(manager)
  assert.equal(ctx.terminalThemes.snapshot().defaultId,'paper');assert.equal(manager.running.get(manifest.id).commit,good.commit)
  await writeFile(join(path,'backend.mjs'),"export function activate(){throw new Error('synthetic activation failure')}");await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,version:'1.0.2'}));await commit(path);await install(manager)
  assert.equal(manager.running.get(manifest.id).commit,good.commit);assert.equal(ctx.terminalThemes.snapshot().defaultId,'paper');assert.equal((await manager.state()).pending[0].kind,'error')
  const failedState=(await manager.state()).installed.find(p=>p.manifest.id===manifest.id)
  assert.equal(failedState.manifest.version,'1.0.2');assert.equal(failedState.running,false);assert.deepEqual(failedState.activeRelease,{version:'1.0.1',commit:good.commit})
  await manager.change({id:manifest.id,action:'rollback',expectedRevision:manager.registry.revision})
  await manager.change({id:'builtin.terminalThemes',action:'select',expectedRevision:manager.registry.revision})
  assert.equal(manager.runningProviders['service:terminalThemes'],'builtin.terminalThemes')
  await manager.change({id:manifest.id,action:'disable',expectedRevision:manager.registry.revision})
  assert.equal(manager.running.size,0);assert.equal(ctx.transport.epoch,transport);assert.ok(events.includes('midnight'));assert.ok(events.includes('paper'))
  for(let i=0;i<3;i++){
    await manager.change({id:manifest.id,action:'select',expectedRevision:manager.registry.revision})
    await manager.change({id:manifest.id,action:'disable',expectedRevision:manager.registry.revision})
  }
  assert.equal(manager.pending.size,0)
})

test('resource leases defer uninstall without killing activity and automatically unload when the resource ends',async t=>{
  const {ctx,manager,path}=await runningFixture(t)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,frontend:undefined,capabilities:[{id:'connector:example.test',version:1}]}))
  await writeFile(join(path,'backend.mjs'),`export function activate(api){let release;api.registerConnector('example.test',()=>({active:true}));api.registerRpc('hold',{mutate:true,handler:async()=>{release??=await api.host.acquireResource();return true}});api.registerRpc('release',{mutate:true,handler:()=>{release?.();release=undefined;return true}})}`)
  await commit(path);await install(manager)
  assert.deepEqual(ctx.connectors.open('example.test','owner','server','connection',manifest.id),{active:true})
  await ctx.plugins.dispatch('owner','plugin.example.midnight-themes.hold',{})
  await manager.change({id:manifest.id,action:'uninstall',expectedRevision:manager.registry.revision})
  assert.equal((await manager.state()).pending[0].kind,'waiting');assert.equal(manager.running.size,1)
  assert.throws(()=>ctx.connectors.open('example.test','owner','server','connection',manifest.id),{code:'PLUGIN_DRAINING'})
  await ctx.plugins.dispatch('owner','plugin.example.midnight-themes.release',{})
  for(let i=0;i<100&&manager.running.size;i++)await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(manager.running.size,0);assert.equal(manager.pending.size,0)
  assert.throws(()=>ctx.connectors.open('example.test','owner','server','connection',manifest.id),{code:'PLUGIN_UNAVAILABLE'})
})

test('active terminal prevents history replacement until it closes, without restarting the business transport',async t=>{
  const {ctx,manager,path,config}=await runningFixture(t),transport=ctx.transport.epoch,origin=`http://127.0.0.1:${config.port}`
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0],owner=ctx.auth.session(cookie).id
  ctx.storage.replace({schemaVersion:1,groups:[],servers:[{id:'test',name:'Synthetic',host:'127.0.0.1',groupId:'',tags:[],note:'',favorite:false,connections:[{id:'local',name:'Local',type:'local',port:1,saveHistory:false,pluginSettings:{shell:'auto'}}]}]},0)
  const active=ctx.connectors.open('local',owner,'test','local')
  const socket=new WebSocket(origin.replace('http','ws')+'/ws/terminal',{origin,headers:{cookie}}),messages=[],output=[]
  t.after(()=>socket.terminate());let bytes=0
  socket.on('message',(raw,binary)=>{if(binary){output.push(raw.toString('utf8'));bytes+=raw.length;socket.send(JSON.stringify({type:'terminal.ack',parsedBytes:bytes}))}else messages.push(JSON.parse(raw.toString()))})
  const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw new Error('Terminal condition timed out');await new Promise(resolve=>setTimeout(resolve,20))}}
  await once(socket,'open');socket.send(JSON.stringify({type:'terminal.attach',...active,cols:80,rows:24}));await until(()=>messages.some(m=>m.type==='terminal.ready'))
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,frontend:undefined,capabilities:[{id:'service:terminalHistory',version:1}]}))
  await writeFile(join(path,'backend.mjs'),`export function activate(api){api.registerService('terminalHistory',{open(){},append(){},close(){},list(){return []},range(){},page(){}})}`)
  await commit(path);await install(manager)
  await manager.change({id:manifest.id,action:'select',expectedRevision:manager.registry.revision})
  assert.equal((await manager.state()).pending[0].kind,'waiting');assert.equal(ctx.sessions.size,1);assert.equal(ctx.transport.epoch,transport)
  assert.equal(manager.runningProviders['service:terminalHistory'],'builtin.terminalHistory')
  assert.equal(socket.readyState,WebSocket.OPEN)
  socket.send(Buffer.from(process.platform==='win32'?"echo 'PLUGIN_HOT_STILL_ALIVE'\r":"printf 'PLUGIN_HOT_STILL_ALIVE\\n'\n"))
  await until(()=>output.join('').includes('PLUGIN_HOT_STILL_ALIVE'))
  socket.close();await once(socket,'close');assert.equal(ctx.sessions.size,1)
  assert.equal((await manager.state()).pending[0].kind,'waiting')
  ctx.sessions.closeOwned(owner,active.sessionId);await until(()=>ctx.sessions.size===0)
  for(let i=0;i<100&&manager.pending.size;i++)await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(manager.runningProviders['service:terminalHistory'],manifest.id);assert.equal(ctx.transport.epoch,transport)
})

test('restart-only declaration queues changes and a subsequent boot applies them',async t=>{
  const {root,path,ctx,manager,config}=await runningFixture(t)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,reload:'restart',reloadReason:'测试进程级组件需要重启'}));await commit(path);await install(manager)
  assert.equal(manager.running.size,0);assert.equal((await manager.state()).pending[0].kind,'restart')
  await manager.change({id:manifest.id,action:'select',expectedRevision:manager.registry.revision});assert.equal(manager.running.size,0)
  await ctx.stop();const restarted=await createApp(config);disposers.set(root,()=>restarted.stop())
  assert.equal(restarted.terminalThemes.snapshot().defaultId,'midnight');assert.equal((await restarted.plugins.manager.state()).restartRequired,false)
})

test('Cordis service cleanup is awaited and failed plugin cleanup keeps the restart notice',async t=>{
  const {ctx,manager,path}=await runningFixture(t),scope=new PluginScope(ctx)
  let cleaned=false
  scope.ctx.inject(['storage'],child=>child.on('dispose',async()=>{await new Promise(resolve=>setTimeout(resolve,30));cleaned=true}))
  await scope.dispose();assert.equal(cleaned,true);await scope.dispose()
  await writeFile(join(path,'backend.mjs'),`export function activate(api){api.registerService('terminalThemes',{snapshot(){return api.shared.defaultTerminalThemes()},subscribe(){return ()=>{}},save(){}});api.onDispose(()=>{throw new Error('synthetic cleanup failure')})}`)
  await commit(path);await install(manager)
  await manager.change({id:manifest.id,action:'disable',expectedRevision:manager.registry.revision})
  assert.equal(manager.running.size,0);assert.equal((await manager.state()).pending[0].kind,'restart')
  await ctx.plugins.reconcile();assert.equal((await manager.state()).restartRequired,true)
})

test('one restart-only plugin does not block hot installation of an independent plugin',async t=>{
  const {manager,path}=await runningFixture(t)
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,reload:'restart'}));await commit(path);await install(manager)
  const independent='example.independent'
  await writeFile(join(path,'webnav.plugin.json'),JSON.stringify({...manifest,id:independent,frontend:undefined,capabilities:[{id:'connector:example.independent',version:1}]}))
  await writeFile(join(path,'backend.mjs'),`export function activate(api){api.registerConnector('example.independent',()=>({active:true}))}`)
  await commit(path);await install(manager)
  assert.equal(manager.running.has(independent),true);assert.equal(manager.running.has(manifest.id),false)
  const pending=(await manager.state()).pending;assert.equal(pending.length,1);assert.equal(pending[0].id,manifest.id)
})

