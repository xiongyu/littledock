import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {PROTOCOL_VERSION_META_KEY,CLIENT_INFO_META_KEY,CLIENT_CAPABILITIES_META_KEY} from '@modelcontextprotocol/server'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {WebSocket} from 'ws'
import {parsePluginManifest} from '@webnav/shared'
import {AutomationAuthority} from '../src/core/automation/authority.ts'
import {automationFixture,waitFor} from './automation-fixture.mjs'
import {createApp} from '../src/app.ts'

const call=(f,id,name,p={})=>f.ctx.automation.call(id,name,p).then(r=>r.data)
async function open(f,id){const plan=await call(f,id,'ssh_open',{serverId:'alpha',connectionId:'ssh',name:'模拟工作'});const result=await call(f,id,'workbench_apply',planArgs(plan));await waitFor(()=>f.ctx.automation.watch().tasks.find(t=>t.id===result.result.taskId)?.connected);return {...result.result,operation:plan}}
const planArgs=p=>({operationId:p.operationId,ticket:p.ticket})
async function viewer(f,sessionId){
  const token=await f.ctx.automation.manage(f.owner,'automation.attach',{sessionId})
  const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/automation-terminal',{origin:f.origin,headers:{cookie:f.cookie}}),messages=[];let parsed=0
  ws.on('message',(raw,binary)=>{if(binary){parsed+=raw.length;ws.send(JSON.stringify({type:'terminal.ack',parsedBytes:parsed}))}else messages.push(JSON.parse(raw.toString()))})
  await once(ws,'open');ws.send(JSON.stringify({sessionId,...token}));await waitFor(()=>messages.some(m=>m.type==='terminal.control'))
  return {ws,messages,send(p){ws.send(JSON.stringify(p))},state(){return messages.filter(m=>m.type==='terminal.control').at(-1)}}
}
test('optional automation preserves old plugins, rejects unsafe declarations and static executable themes',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../plugins/builtin.sessions/webnav.plugin.json',import.meta.url),'utf8'))
  assert.equal(parsePluginManifest(manifest,true).automation.tools.length,2)
  const old={...manifest};delete old.automation;assert.equal(parsePluginManifest(old,true).automation,undefined)
  assert.equal(parsePluginManifest({...manifest,automation:{version:1,description:'没有工具',tools:[]}},true).automation.tools.length,0)
  const t=manifest.automation.tools[0]
  for(const tools of [[t,t],[{...t,inputSchema:{type:'object',$ref:'https://example.invalid/schema'}}],[{...t,binding:{kind:'service',capability:'service:auth'}}]])assert.throws(()=>parsePluginManifest({...manifest,automation:{...manifest.automation,tools}},true))
})
test('AI SSH works without viewers, input deduplicates, task finish drains and releases automatically',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),b=f.enroll('Other AI')
  assert.equal((await call(f,a.id,'catalog_list')).servers.length,1)
  await assert.rejects(call(f,a.id,'ssh_open',{serverId:'beta',connectionId:'ssh',name:'forbidden'}),{code:'FORBIDDEN'})
  const job=await open(f,a.id);assert.equal(f.ctx.sessions.size,1)
  await assert.rejects(call(f,b.id,'task_status',{taskId:job.taskId}),{code:'NOT_FOUND'})
  const input={taskId:job.taskId,controlEpoch:1,seq:1,text:'echo fixture\r'}
  await call(f,a.id,'ssh_input',input);await call(f,a.id,'ssh_input',input)
  await waitFor(()=>f.stats.inputs.includes(input.text));assert.equal(f.stats.inputs.filter(s=>s===input.text).length,1)
  await assert.rejects(call(f,a.id,'ssh_input',{...input,text:'changed'}),{code:'UNKNOWN'})
  const output=await call(f,a.id,'task_status',{taskId:job.taskId});assert.match(output.output.text,/AI loopback fixture/)
  const done=await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'})
  assert.equal(done.state,'succeeded');assert.equal(done.connected,false);assert.equal(f.ctx.sessions.size,0)
  assert.equal((await call(f,a.id,'workbench_apply',planArgs(job.operation))).result.taskId,job.taskId)
  assert.equal(f.stats.connections,1)
})
test('viewers are readonly; takeover fences AI input, survives finish, closes on return; refresh reattaches the same PTY',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),job=await open(f,a.id),v=await viewer(f,job.sessionId)
  t.after(()=>v.ws.terminate());assert.equal(v.state().writable,false)
  v.send({type:'terminal.input',controlEpoch:1,seq:1,text:'blocked'});await waitFor(()=>v.messages.some(m=>m.code==='READ_ONLY'));assert.equal(f.stats.inputs.includes('blocked'),false)
  v.ws.close();await once(v.ws,'close');assert.equal(f.ctx.sessions.size,1)
  const human=await viewer(f,job.sessionId),other=await viewer(f,job.sessionId);t.after(()=>{human.ws.terminate();other.ws.terminate()})
  human.send({type:'terminal.takeover'});await waitFor(()=>human.state().writable)
  other.send({type:'terminal.takeover'});await waitFor(()=>other.messages.some(m=>m.code==='BUSY'))
  await assert.rejects(call(f,a.id,'ssh_input',{taskId:job.taskId,controlEpoch:1,seq:1,text:'late'}),{code:'CONTROL_CHANGED'})
  human.send({type:'terminal.input',controlEpoch:human.state().controlEpoch,seq:1,text:'human\r'});await waitFor(()=>f.stats.inputs.includes('human\r'))
  const result=await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'});assert.equal(result.connected,true);assert.match(result.message,/人工仍在使用/)
  human.send({type:'terminal.input',controlEpoch:human.state().controlEpoch,seq:2,text:'still human\r'});await waitFor(()=>f.stats.inputs.includes('still human\r'))
  human.send({type:'terminal.release'});await waitFor(()=>f.ctx.sessions.size===0);assert.equal(f.stats.connections,1)
  const saved=(await call(f,a.id,'history_list')).tasks[0];assert.equal(saved.connected,false);assert.match(saved.message,/连接已释放/)
})
test('manual observer disconnect revokes control without silently returning input to AI',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),job=await open(f,a.id),v=await viewer(f,job.sessionId)
  v.send({type:'terminal.takeover'});await waitFor(()=>v.state().writable);v.ws.close();await once(v.ws,'close')
  await waitFor(()=>f.ctx.automation.watch().tasks[0].controller==='none')
  await assert.rejects(call(f,a.id,'ssh_input',{taskId:job.taskId,controlEpoch:3,seq:1,text:'unexpected'}),{code:'CONTROL_CHANGED'})
  await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'cancelled'});assert.equal(f.ctx.sessions.size,0)
})
test('SFTP preview/apply checks version, scope, operation ownership and unknown writes without replay',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),b=f.enroll(),job=await open(f,a.id),path='/home/fixture/README.md'
  const before=await call(f,a.id,'files_read',{taskId:job.taskId,path})
  const prepare=()=>call(f,a.id,'files_save',{taskId:job.taskId,...before,text:'MCP 修改\n'})
  const stale=await prepare();assert.match(stale.preview.after,/MCP/)
  await assert.rejects(call(f,b.id,'workbench_apply',planArgs(stale)),{code:'UNKNOWN'})
  await writeFile(join(f.home,'README.md'),'external change')
  await assert.rejects(call(f,a.id,'workbench_apply',planArgs(stale)),{code:'CONFLICT'})
  assert.equal((await call(f,a.id,'operation_status',{operationId:stale.operationId})).state,'unknown')
  assert.equal((await call(f,a.id,'workbench_apply',planArgs(stale))).state,'unknown')
  const fresh=await call(f,a.id,'files_read',{taskId:job.taskId,path}),plan=await call(f,a.id,'files_save',{taskId:job.taskId,...fresh,text:'done\n'})
  await call(f,a.id,'workbench_apply',planArgs(plan));assert.equal(await readFile(join(f.home,'README.md'),'utf8'),'done\n')
  await assert.rejects(call(f,a.id,'files_read',{taskId:job.taskId,path:'/home/fixture/../outside'}),{code:'FORBIDDEN'})
  const saved=f.ctx.automation.authority.db.prepare('SELECT * FROM operations').all();assert.equal(JSON.stringify(saved).includes('external change'),false)
  await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'})
})
test('revocation, target changes and vault locking release AI resources and invalidate pending plans',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),job=await open(f,a.id)
  await f.ctx.automation.manage(f.owner,'automation.revoke',{id:a.id});await waitFor(()=>f.ctx.sessions.size===0)
  await assert.rejects(call(f,a.id,'task_status',{taskId:job.taskId}),{code:'UNAUTHORIZED'})
  const b=f.enroll(),plan=await call(f,b.id,'ssh_open',{serverId:'alpha',connectionId:'ssh',name:'stale target'})
  const snapshot=f.ctx.storage.snapshot();snapshot.snapshot.servers[0].connections[0].username='changed';f.ctx.storage.replace(snapshot.snapshot,snapshot.revision)
  await assert.rejects(call(f,b.id,'workbench_apply',planArgs(plan)),{code:'CONFLICT'})
  const next=await open(f,b.id)
  await f.ctx.credentials.configure('master','test-only-master-passphrase')
  f.ctx.credentials.lock();await waitFor(()=>f.ctx.sessions.size===0)
  await assert.rejects(call(f,b.id,'task_status',{taskId:next.taskId}),{code:'VAULT_LOCKED'})
})
test('terminal parses fragmented UTF-8 and ANSI with finite history, slow viewers cannot stop the backend task',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),job=await open(f,a.id)
  const token=await f.ctx.automation.manage(f.owner,'automation.attach',{sessionId:job.sessionId})
  const slow=new WebSocket(f.origin.replace('http','ws')+'/ws/automation-terminal',{origin:f.origin,headers:{cookie:f.cookie}})
  slow.on('error',()=>{});await once(slow,'open');slow.send(JSON.stringify({sessionId:job.sessionId,...token}));t.after(()=>slow.terminate())
  const stream=[...f.streams][0]
  const bytes=Buffer.from('\x1b[31m中文跨帧\x1b[0m\r\n')
  for(const byte of bytes)await new Promise((r,j)=>stream.write(Buffer.from([byte]),e=>e?j(e):r()))
  const line='x'.repeat(100)+'\r\n'
  for(let n=0;n<160;n++)await new Promise((r,j)=>stream.write(line.repeat(200),e=>e?j(e):r()))
  await waitFor(()=>slow.readyState===WebSocket.CLOSED,20000)
  assert.equal(f.ctx.sessions.size,1)
  const current=f.ctx.automation.tasks.get(job.taskId).terminal
  assert.ok(current.terminal.buffer.normal.length<=2030)
  const status=await call(f,a.id,'task_status',{taskId:job.taskId});assert.ok(Buffer.byteLength(JSON.stringify(status))<200000)
  const refreshed=await viewer(f,job.sessionId);t.after(()=>refreshed.ws.terminate());assert.equal(refreshed.state().connected,true)
  await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'});assert.equal(f.ctx.sessions.size,0)
})
test('real third-party registration uses optional declarations, output schema and runtime revision fencing',async t=>{
  const f=await automationFixture({disablePlugins:false});t.after(()=>f.close());const a=f.enroll(),base=JSON.parse(await readFile(new URL('../plugins/builtin.sessions/webnav.plugin.json',import.meta.url),'utf8'))
  const definition={id:'read',version:1,title:'Read test',description:'Synthetic test tool',inputSchema:{type:'object',properties:{},additionalProperties:false},outputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false},access:'read',scopes:['catalog.read'],execution:'request',binding:{kind:'plugin'}}
  const manifest={...base,i18n:undefined,id:'test.automation',backend:'index.mjs',capabilities:[{id:'extension:fixture',version:1}],automation:{version:1,description:'Test',tools:[definition,{...definition,id:'missing'},{...definition,id:'bad'},{...definition,id:'job',execution:'job'}]}}
  const installed={manifest,commit:'b'.repeat(40),repository:'https://example.invalid/test.git',ref:'main',enabled:true,installedAt:Date.now(),config:{}}
  const path=f.ctx.plugins.manager.path(installed);await mkdir(path,{recursive:true});await writeFile(join(path,'index.mjs'),"export function activate(api){api.registerAutomationTool('read',()=>({value:42}));api.registerAutomationTool('bad',()=>({value:'bad'}));api.registerAutomationTool('job',()=>({value:1}));}")
  f.ctx.plugins.manager.registry.installed.push(installed);await f.ctx.plugins.reconcile()
  const tools=f.ctx.automation.list(a.id)
  assert.ok(tools.some(t=>t.name==='plugin.test.automation.read'));assert.ok(!tools.some(t=>t.name==='plugin.test.automation.missing'))
  assert.ok(!tools.some(t=>t.name==='plugin.test.automation.job'))
  assert.equal((await call(f,a.id,'plugin.test.automation.read')).value,42)
  await assert.rejects(call(f,a.id,'plugin.test.automation.bad'),{code:'INVALID_RESULT'})
  installed.enabled=false;f.ctx.plugins.manager.registry.revision++;await f.ctx.plugins.reconcile()
  assert.ok(!f.ctx.automation.list(a.id).some(t=>t.name==='plugin.test.automation.read'))
})
test('durable operation records survive restart as unknown and expired records cannot execute again',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll(),directory=join(f.directory,'authority-test');await mkdir(directory)
  let authority=new AutomationAuthority(directory)
  const plan=authority.prepare(a.id,'write',{text:'NEVER_STORE_BODY'},{target:'synthetic'})
  authority.db.prepare("UPDATE operations SET state='running' WHERE id=?").run(plan.operationId);authority.close();authority=new AutomationAuthority(directory)
  try{assert.equal(authority.operation(plan.operationId,a.id).state,'unknown');assert.doesNotMatch(JSON.stringify(authority.db.prepare('SELECT * FROM operations').all()),/NEVER_STORE_BODY/);authority.db.prepare('DELETE FROM operations').run();assert.throws(()=>authority.operation(plan.operationId,a.id),{code:'UNKNOWN'})}finally{authority.close()}
})
test('history remains principal-bound and fixed-range across service restart; Shell is not restored',async t=>{
  const f=await automationFixture();let restarted;t.after(async()=>{await restarted?.stop();await f.close()});const a=f.enroll(),job=await open(f,a.id)
  await call(f,a.id,'ssh_input',{taskId:job.taskId,controlEpoch:1,seq:1,text:'history-before\r'})
  await waitFor(()=>f.stats.inputs.includes('history-before\r'))
  const first=await call(f,a.id,'history_read',{taskId:job.taskId})
  await call(f,a.id,'ssh_input',{taskId:job.taskId,controlEpoch:1,seq:2,text:'history-after\r'})
  await waitFor(()=>f.stats.inputs.includes('history-after\r'))
  const frozen=await call(f,a.id,'history_read',{taskId:job.taskId,snapshot:first.snapshot})
  assert.equal(JSON.stringify(frozen.rows).includes('history-after'),false)
  await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'});await f.ctx.stop()
  restarted=await createApp(f.config);f.ctx=restarted
  assert.equal(restarted.sessions.size,0)
  assert.equal((await call(f,a.id,'history_list')).tasks[0].id,job.taskId)
  const history=await call(f,a.id,'history_read',{taskId:job.taskId});assert.match(JSON.stringify(history.rows),/history-before/)
  await assert.rejects(call(f,a.id,'history_read',{taskId:job.taskId,snapshot:first.snapshot}),{code:'EXPIRED'})
})
test('AI waits for actual human host-key confirmation and cannot approve it through MCP',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const a=f.enroll();f.ctx.storage.db.prepare('DELETE FROM hostkeys').run()
  const plan=await call(f,a.id,'ssh_open',{serverId:'alpha',connectionId:'ssh',name:'fingerprint'}),job=(await call(f,a.id,'workbench_apply',planArgs(plan))).result
  await waitFor(()=>f.ctx.automation.watch().tasks[0].state==='waiting_user')
  assert.equal(f.ctx.automation.list(a.id).some(t=>/hostkey|fingerprint/i.test(t.name)),false)
  const v=await viewer(f,job.sessionId);t.after(()=>v.ws.terminate());await waitFor(()=>v.messages.some(m=>m.type==='terminal.hostkey'))
  const prompt=v.messages.find(m=>m.type==='terminal.hostkey');v.send({type:'terminal.hostkeyDecision',accept:true,fingerprint:prompt.fingerprint})
  await waitFor(()=>f.ctx.automation.watch().tasks[0].connected);await call(f,a.id,'task_finish',{taskId:job.taskId,outcome:'succeeded'})
})
test('stdio bridge serves the modern MCP protocol without a legacy initialize handshake',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const pairing=await f.ctx.automation.manage(f.owner,'automation.pair',{name:'Modern AI',grantId:'work'}),config=pairing.config.mcpServers.webnav
  const child=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>child.kill())
  let buffer='',stderr='';const messages=[];child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1)}})
  const meta={[PROTOCOL_VERSION_META_KEY]:'2026-07-28',[CLIENT_INFO_META_KEY]:{name:'test-modern',version:'1'},[CLIENT_CAPABILITIES_META_KEY]:{}}
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:meta}})+'\n')
  await waitFor(()=>messages.some(m=>m.id===1)||child.exitCode!==null,15000)
  assert.ok(messages.find(m=>m.id===1)?.result?.tools.some(t=>t.name==='ssh_open'),JSON.stringify(messages)+stderr)
  child.stdin.end();await once(child,'exit');assert.equal(child.exitCode,0)
})
test('internal WS requires signed identity, exact host, no browser Origin and rejects pairing replay',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64')
  const pairing=f.ctx.automation.authority.begin('WS AI','work')
  async function connect(code){
    const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/automation'),messages=[],nonce=randomUUID()
    ws.on('message',raw=>{const p=JSON.parse(raw.toString());messages.push(p);if(p.type==='challenge'){const transcript=JSON.stringify(['webnav-automation-v1',f.port,nonce,p.nonce,publicKey,p.serverKey]);ws.send(JSON.stringify({type:'proof',code,signature:sign(null,Buffer.from(transcript),keys.privateKey).toString('base64')}))}})
    await once(ws,'open');ws.send(JSON.stringify({type:'hello',publicKey,nonce}));await waitFor(()=>messages.some(p=>p.type==='ready'||p.ok===false));return {ws,messages}
  }
  const accepted=await connect(pairing.code);assert.ok(accepted.messages.some(m=>m.type==='ready'));accepted.ws.close()
  const replay=await connect(pairing.code);assert.ok(replay.messages.some(m=>m.ok===false));replay.ws.terminate()
  const denied=new WebSocket(f.origin.replace('http','ws')+'/ws/automation',{origin:f.origin});const error=await new Promise(r=>denied.once('error',r));assert.match(error.message,/403/)
})
test('real stdio bridge negotiates legacy MCP and calls tools with no stdout logging',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const pairing=await f.ctx.automation.manage(f.owner,'automation.pair',{name:'Stdio AI',grantId:'work',port:f.port}),config=pairing.config.mcpServers.webnav
  const child=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});t.after(()=>child.kill())
  let buffer='',stderr='';const messages=[];child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1)}})
  const request=async(id,method,params)=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');await waitFor(()=>messages.some(m=>m.id===id)||child.exitCode!==null,15000);const message=messages.find(m=>m.id===id);assert.ok(message,stderr);return message}
  const initialized=await request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'webnav-test',version:'1'}})
  assert.equal(initialized.result.serverInfo.name,'webnav');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
  const listed=await request(2,'tools/list',{});assert.ok(listed.result.tools.some(t=>t.name==='ssh_open'))
  const result=await request(3,'tools/call',{name:'catalog_list',arguments:{}});assert.equal(result.result.structuredContent.data.servers[0].id,'alpha')
  child.stdin.end();await once(child,'exit');assert.equal(child.exitCode,0)
})
