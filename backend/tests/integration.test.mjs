import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import ssh2 from 'ssh2'
import { createApp } from '../src/app.ts'
import { parseSshConfig } from '../src/plugins/ssh-import.ts'
import { TextTranscript } from '../src/plugins/terminal-history.ts'
import { credentialKey } from '../src/plugins/storage.ts'
import { rdpArguments, rdpFile } from '../src/plugins/rdp-local.ts'
import { rdpCredentialPayload } from '../src/plugins/rdp-credentials.ts'

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
async function freePort() { const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port }
async function fixture(t, overrides = {}) {
  const directory=await mkdtemp(join(tmpdir(),'webnav-test-')), port=await freePort(), frontendRoot=join(directory,'ui')
  await mkdir(frontendRoot);await writeFile(join(frontendRoot,'index.html'),'<html>test</html>')
  const config={directory,port,frontendRoot,...overrides},ctx=await createApp(config)
  const state={ctx,config,origin:`http://127.0.0.1:${port}`}
  t.after(async()=>{await state.ctx.stop();await rm(directory,{recursive:true,force:true})})
  return state
}
async function browser(origin, existingCookie) {
  const cookie=existingCookie??(await fetch(origin+'/')).headers.get('set-cookie').split(';')[0]
  const ws=new WebSocket(origin.replace('http','ws')+'/ws',{origin,headers:{cookie}})
  let epoch='',counter=0;const waiting=new Map(),events=[]
  const hello=new Promise(resolve=>ws.on('message',raw=>{
    const message=JSON.parse(raw.toString())
    if(message.type==='hello'){epoch=message.epoch;resolve(message)}
    else if(message.type==='event')events.push(message)
    else {const pending=waiting.get(message.id);if(pending){waiting.delete(message.id);clearTimeout(pending.timer);message.ok?pending.resolve(message.result):pending.reject(Object.assign(new Error(message.error.message),message.error))}}
  }))
  await hello
  return {ws,cookie,events,rpc(method,params={},operationId=randomUUID()) {return new Promise((resolve,reject)=>{const id=String(++counter),timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`Timeout: ${method}`))},5000);waiting.set(id,{resolve,reject,timer});ws.send(JSON.stringify({v:1,type:'request',epoch,id,method,params,operationId}))})}}
}
function catalog(port=22) {return {schemaVersion:1,groups:[],servers:[{id:'test-server',name:'Test server',host:'127.0.0.1',groupId:'',tags:[],note:'',favorite:false,connections:[{id:'ssh',name:'SSH',type:'ssh',port,username:'tester',saveHistory:true}]}]}}
async function authorized(t,f){const page=await browser(f.origin);t.after(()=>page.ws.terminate());assert.equal((await page.rpc('auth.status')).authorized,true);return page}
const waitUntil=async(fn,timeout=5000)=>{const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw new Error('Condition timed out');await new Promise(resolve=>setTimeout(resolve,10))}}

test('SSH config: aliases merge, wildcard defaults, distinct identities and no invented RDP',()=>{
  const result=parseSshConfig('Host dev alias\n HostName 192.0.2.10\n User Administrator\n IdentityFile ~/.ssh/key\n Port 2200\nHost second\n HostName 192.0.2.10\n IdentityFile ~/.ssh/other\n Port 2200\nHost *\n User Administrator',tmpdir())
  assert.equal(result.aliases,3);assert.equal(result.catalog.servers.length,2);assert.equal(result.references.length,2)
  assert.equal(result.catalog.servers[0].connections[0].port,2200);assert.equal(result.catalog.servers[0].connections.length,1)
  assert.notEqual(result.catalog.servers[0].id,result.catalog.servers[1].id)
  assert.throws(()=>parseSshConfig('Include private.conf',tmpdir()),{code:'IMPORT_UNSUPPORTED'})
  assert.equal(parseSshConfig('Host jump\n ProxyCommand something',tmpdir()).catalog.servers.length,0)
})

test('RDP parameters are separate arguments and reject command text',()=>{
  assert.deepEqual(rdpArguments('2001:db8::1',3389),['/v:[2001:db8::1]:3389'])
  for(const host of ['host & calc','/admin','host\r\noption','-host'])assert.throws(()=>rdpArguments(host,3389))
  assert.throws(()=>rdpArguments('host',0))
  assert.match(rdpFile('2001:db8::1',3390,'DOMAIN\\tester'),/full address:s:\[2001:db8::1\]:3390/)
  assert.throws(()=>rdpFile('host',3389,'user\r\nredirectclipboard:i:1'))
  const password = 'synthetic & ` $(do-not-execute) " 密码'
  assert.equal(rdpCredentialPayload('host','DOMAIN\\tester',password).password,password)
  assert.equal(rdpCredentialPayload('[2001:db8::1]','tester',password).target,'TERMSRV/2001:db8::1')
  assert.throws(()=>rdpCredentialPayload('host','user','a'.repeat(1281)))
  assert.throws(()=>rdpCredentialPayload('host','user','nul\0password'))
})

test('RDP passwords save atomically with new entries, stay out of snapshots, and follow vault mode',async t=>{
  const f=await fixture(t),page=await authorized(t,f),doc=catalog()
  doc.servers[0].connections.push({id:'rdp',name:'RDP',type:'rdp',port:3390,username:'DOMAIN\\tester'})
  const update={serverId:'test-server',connectionId:'rdp',secret:'synthetic-rdp & 密码'}
  assert.equal((await page.rpc('vault.status')).mode,'local')
  const operation=randomUUID(),params={catalog:doc,expectedRevision:0,rdpPasswords:[update]}
  f.ctx.storage.db.exec("CREATE TEMP TRIGGER reject_test_credential BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
  await assert.rejects(page.rpc('catalog.replace',params),{code:'INTERNAL'})
  assert.equal(f.ctx.storage.snapshot().revision,0)
  assert.equal(f.ctx.storage.snapshot().snapshot.servers.length,0)
  f.ctx.storage.db.exec('DROP TRIGGER reject_test_credential')
  const result=await page.rpc('catalog.replace',params,operation)
  assert.deepEqual(await page.rpc('catalog.replace',params,operation),result)
  assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),update.secret)
  const description=await page.rpc('credentials.describe',update)
  assert.equal(description.kind,'password');assert.equal(description.hasSecret,true)
  assert.equal(JSON.stringify(description).includes(update.secret),false)
  assert.equal(JSON.stringify(result).includes(update.secret),false)
  assert.equal((await page.rpc('exports.config')).text.includes('secret'),false)
  const row=()=>f.ctx.storage.db.prepare('SELECT secret FROM credentials WHERE id=?').get(credentialKey('test-server','rdp')).secret
  assert.equal(Buffer.from(row(),'base64').toString(),update.secret)
  await page.rpc('catalog.replace',{catalog:doc,expectedRevision:1})
  assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),update.secret)
  for (const invalid of [
    {...update,connectionId:'ssh'}, {...update,connectionId:'missing'}, {...update,secret:''}, {...update,secret:'x'.repeat(1281)},
  ]) {
    await assert.rejects(page.rpc('catalog.replace',{catalog:doc,expectedRevision:2,rdpPasswords:[invalid]}),{code:'INVALID_ARGUMENT'})
    assert.equal(f.ctx.storage.snapshot().revision,2)
    assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),update.secret)
  }
  await assert.rejects(page.rpc('catalog.replace',{catalog:doc,expectedRevision:0,rdpPasswords:[{...update,secret:'replacement'}]}),{code:'REVISION_CONFLICT'})
  assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),update.secret)
  await page.rpc('vault.changeMode',{mode:'master',password:'synthetic-master'})
  assert.equal(row().split('.').length,3)
  await page.rpc('vault.lock')
  await assert.rejects(page.rpc('catalog.replace',{catalog:doc,expectedRevision:2,rdpPasswords:[update]}),{code:'VAULT_LOCKED'})
  assert.equal(f.ctx.storage.snapshot().revision,2)
  page.ws.terminate();await f.ctx.stop();f.ctx=await createApp(f.config)
  assert.throws(()=>f.ctx.credentials.rdpPassword('test-server','rdp'),{code:'VAULT_LOCKED'})
  await f.ctx.credentials.unlock('synthetic-master')
  assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),update.secret)
  const restored=await authorized(t,f)
  await restored.rpc('catalog.replace',{catalog:doc,expectedRevision:2,rdpPasswords:[{...update,secret:null}]})
  assert.equal((await restored.rpc('credentials.describe',update)).hasSecret,false)
})

test('RDP hands credentials to Windows before launching and cleans files without ending the client',async t=>{
  const calls=[]
  let credentialFailure=false, launchFailure=false
  const f=await fixture(t,{rdpLauncher:{
    async writeCredential(host,username,password){calls.push({host,username,password});if(credentialFailure)throw new Error('synthetic failure')},
    async launch(args){if(launchFailure)throw new Error('synthetic failure');calls.push({args,text:await readFile(args[0],'utf16le')})},
  }}),page=await authorized(t,f),doc=catalog()
  doc.servers[0].connections=[{id:'rdp',type:'rdp',name:'RDP',port:3390,username:'DOMAIN\\tester'}]
  await page.rpc('vault.configure',{mode:'local'})
  await page.rpc('catalog.replace',{catalog:doc,expectedRevision:0,rdpPasswords:[{serverId:'test-server',connectionId:'rdp',secret:'synthetic-rdp-password'}]})
  const result=await page.rpc('connections.open',{serverId:'test-server',connectionId:'rdp'})
  assert.equal(result.state,'client-started')
  assert.equal(calls[0].password,'synthetic-rdp-password')
  assert.equal(calls[0].username,'DOMAIN\\tester')
  assert.equal(calls[1].args.length,1)
  assert.match(calls[1].text,/full address:s:127.0.0.1:3390/)
  assert.match(calls[1].text,/username:s:DOMAIN\\tester/)
  assert.equal(calls[1].text.includes('synthetic-rdp-password'),false)
  credentialFailure=true
  await assert.rejects(page.rpc('connections.open',{serverId:'test-server',connectionId:'rdp'}))
  assert.equal(calls.filter(call=>call.args).length,1)
  credentialFailure=false;launchFailure=true
  await assert.rejects(page.rpc('connections.open',{serverId:'test-server',connectionId:'rdp'}))
  assert.equal((await readdir(join(f.config.directory,'rdp'))).length,1)
  await f.ctx.stop()
  assert.equal((await readdir(join(f.config.directory,'rdp'))).length,0)
})

test('local page connects without pairing; import transaction, deduplication, subscription and persisted catalog',async t=>{
  const f=await fixture(t),page=await browser(f.origin);t.after(()=>page.ws.terminate())
  const first=await page.rpc('catalog.watch');assert.equal(first.revision,0)
  const doc=catalog(),preview=await page.rpc('imports.preview',{catalog:doc}),operation=randomUUID()
  const result=await page.rpc('imports.apply',{token:preview.token},operation)
  assert.equal(result.snapshot.servers.length,1)
  assert.deepEqual(await page.rpc('imports.apply',{token:preview.token},operation),result)
  await assert.rejects(page.rpc('imports.apply',{token:'different'},operation),{code:'OPERATION_CONFLICT'})
  await assert.rejects(page.rpc('catalog.replace',{catalog:doc,expectedRevision:0}),{code:'REVISION_CONFLICT'})
  await assert.rejects(page.rpc('imports.preview',{catalog:{...doc,servers:[{...doc.servers[0],password:'forbidden'}]}}),{code:'INVALID_ARGUMENT'})
  assert.equal(f.ctx.storage.snapshot().revision,1)
  await waitUntil(()=>page.events.length>0);assert.equal(page.events[0].revision,1)
  const exported=await page.rpc('exports.config');assert.deepEqual(JSON.parse(exported.text),doc)
  page.ws.terminate();await f.ctx.stop()
  const restored=await createApp(f.config);f.ctx=restored;assert.deepEqual(restored.storage.snapshot().snapshot,doc)
})

test('Origin/Host guard rejects foreign browser and terminal without a local session',async t=>{
  const f=await fixture(t)
  const status=await new Promise((resolve,reject)=>{httpGet(f.origin+'/',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)}).on('error',reject)});assert.equal(status,403)
  const cookie=(await fetch(f.origin+'/')).headers.get('set-cookie').split(';')[0]
  for(const [path,origin,headers] of [['/ws','http://evil.example',{cookie}],['/ws/terminal',f.origin,{}]]){
    const ws=new WebSocket(f.origin.replace('http','ws')+path,{origin,headers})
    await new Promise((resolve,reject)=>{ws.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,403);res.resume();ws.terminate();resolve()});ws.on('error',()=>{});ws.on('open',()=>{ws.terminate();reject(new Error('Unexpected upgrade'))})})
  }
})

test('credentials persist: reversible local, master encryption, wrong password and mode migration',async t=>{
  const f=await fixture(t),page=await authorized(t,f),doc=catalog()
  await page.rpc('catalog.replace',{catalog:doc,expectedRevision:0})
  await page.rpc('vault.configure',{mode:'local'})
  await page.rpc('credentials.save',{serverId:'test-server',connectionId:'ssh',kind:'password',secret:'synthetic-test-password'})
  const descriptor=await page.rpc('credentials.describe',{serverId:'test-server',connectionId:'ssh'})
  assert.equal(descriptor.hasSecret,true);assert.equal('secret' in descriptor,false)
  const row=()=>f.ctx.storage.db.prepare('SELECT secret FROM credentials').get().secret
  assert.equal(Buffer.from(row(),'base64').toString(),'synthetic-test-password')
  await page.rpc('vault.changeMode',{mode:'master',password:'test-master-123'})
  assert.equal(row().includes('synthetic'),false);assert.equal(row().split('.').length,3)
  assert.equal((await f.ctx.credentials.resolve('test-server','ssh')).password,'synthetic-test-password')
  await page.rpc('vault.lock');await assert.rejects(f.ctx.credentials.resolve('test-server','ssh'),{code:'VAULT_LOCKED'})
  await assert.rejects(page.rpc('vault.unlock',{password:'incorrect'}),{code:'WRONG_PASSWORD'})
  // A restart also verifies no master key is persisted, and resets the failed-attempt backoff.
  page.ws.terminate();await f.ctx.stop();const restored=await createApp(f.config);f.ctx=restored
  assert.equal(restored.credentials.status().unlocked,false)
  await restored.credentials.unlock('test-master-123')
  assert.equal((await restored.credentials.resolve('test-server','ssh')).password,'synthetic-test-password')
  await restored.credentials.changeMode('local','');assert.equal(restored.credentials.status().mode,'local')
  assert.equal((await restored.credentials.resolve('test-server','ssh')).password,'synthetic-test-password')
})

test('global settings migrate every password and key passphrase atomically, including rotation and removal',async t=>{
  const f=await fixture(t),page=await authorized(t,f),doc=catalog()
  doc.servers[0].connections.push({id:'rdp',name:'RDP',type:'rdp',port:3389,username:'tester'},{id:'key',name:'Key',type:'ssh',port:22,username:'tester'})
  await page.rpc('catalog.replace',{catalog:doc,expectedRevision:0,rdpPasswords:[{serverId:'test-server',connectionId:'rdp',secret:'synthetic-rdp'}]})
  await page.rpc('credentials.save',{serverId:'test-server',connectionId:'ssh',kind:'password',secret:'synthetic-ssh'})
  const identity=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'synthetic-phrase'},publicKeyEncoding:{type:'spki',format:'pem'}})
  const path=join(f.config.directory,'encrypted-test-key');await writeFile(path,identity.privateKey)
  await page.rpc('credentials.save',{serverId:'test-server',connectionId:'key',kind:'key',path,secret:'synthetic-phrase'})
  const rows=()=>f.ctx.storage.db.prepare('SELECT id,secret FROM credentials ORDER BY id').all()
  const encoded=rows();assert.equal(encoded.length,3)
  assert.deepEqual(new Set(encoded.map(row=>Buffer.from(row.secret,'base64').toString())),new Set(['synthetic-rdp','synthetic-ssh','synthetic-phrase']))
  // Abort after one update to verify both secrets and settings are rolled back.
  f.ctx.storage.db.exec(`CREATE TEMP TRIGGER reject_migration BEFORE UPDATE ON credentials WHEN OLD.id='${credentialKey('test-server','rdp')}' BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END`)
  await assert.rejects(page.rpc('vault.update',{mode:'master',password:'synthetic-master',unlockMinutes:60}),{code:'INTERNAL'})
  assert.deepEqual(rows(),encoded);assert.equal((await page.rpc('vault.status')).mode,'local')
  f.ctx.storage.db.exec('DROP TRIGGER reject_migration')
  await page.rpc('vault.update',{mode:'master',password:'synthetic-master',unlockMinutes:60})
  assert.ok(rows().every(row=>row.secret.split('.').length===3))
  const verify=async()=>{
    assert.equal(f.ctx.credentials.rdpPassword('test-server','rdp'),'synthetic-rdp')
    assert.equal((await f.ctx.credentials.resolve('test-server','ssh')).password,'synthetic-ssh')
    const resolved=await f.ctx.credentials.resolve('test-server','key')
    assert.equal(resolved.passphrase,'synthetic-phrase');resolved.privateKey.fill(0)
  }
  await verify()
  const encrypted=rows()
  await page.rpc('vault.update',{mode:'master',password:'synthetic-rotated',unlockMinutes:1440})
  assert.notDeepEqual(rows(),encrypted);await verify()
  await page.rpc('vault.lock')
  await assert.rejects(page.rpc('vault.unlock',{password:'synthetic-master'}),{code:'WRONG_PASSWORD'})
  page.ws.terminate();await f.ctx.stop();f.ctx=await createApp(f.config)
  await f.ctx.credentials.unlock('synthetic-rotated');await verify()
  const restored=await authorized(t,f)
  await restored.rpc('vault.update',{mode:'local',unlockMinutes:0})
  assert.deepEqual(rows(),encoded);await verify()
  await f.ctx.stop();f.ctx=await createApp(f.config)
  assert.equal(f.ctx.credentials.status().unlocked,true);await verify()
})

test('global unlock lifetime is shared by tabs, fixed in minutes, pushed on expiry, and never survives a restart',async t=>{
  let now=Date.now()
  const f=await fixture(t,{credentialClock:()=>now}),page=await authorized(t,f)
  const initial=await page.rpc('vault.watch')
  assert.deepEqual(initial,{configured:true,mode:'local',unlocked:true,unlockMinutes:0,expiresAt:null})
  await page.rpc('vault.update',{mode:'master',password:'synthetic-master',unlockMinutes:1})
  const expires=now+60_000
  assert.equal((await page.rpc('vault.status')).expiresAt,expires)
  const another=await browser(f.origin,page.cookie);t.after(()=>another.ws.terminate())
  assert.equal((await another.rpc('vault.watch')).unlocked,true)
  now+=59_999
  assert.equal((await another.rpc('vault.status')).expiresAt,expires)
  await another.rpc('catalog.watch')
  now++
  assert.equal((await page.rpc('vault.status')).unlocked,false)
  await waitUntil(()=>[page,another].every(client=>client.events.some(event=>event.event==='vault.changed'&&!event.status.unlocked)))
  for(const client of [page,another]){
    await assert.rejects(client.rpc('catalog.watch'),{code:'VAULT_LOCKED'})
    await assert.rejects(client.rpc('vault.update',{mode:'local',unlockMinutes:0}),{code:'VAULT_LOCKED'})
  }
  await page.rpc('vault.unlock',{password:'synthetic-master'})
  assert.equal((await another.rpc('vault.status')).expiresAt,now+60_000)
  for(const unlockMinutes of [-1,1.5,'60',525601]) await assert.rejects(page.rpc('vault.update',{mode:'master',unlockMinutes}),{code:'INVALID_ARGUMENT'})
  await page.rpc('vault.update',{mode:'master',unlockMinutes:1440})
  assert.equal((await page.rpc('vault.status')).expiresAt,now+1440*60_000)
  await page.rpc('vault.update',{mode:'master',unlockMinutes:0})
  now+=365*86400_000
  assert.equal((await another.rpc('vault.status')).unlocked,true)
  assert.equal((await another.rpc('vault.status')).expiresAt,null)
  page.ws.terminate();another.ws.terminate();await f.ctx.stop();f.ctx=await createApp(f.config)
  const refreshed=await browser(f.origin,page.cookie);t.after(()=>refreshed.ws.terminate())
  assert.equal((await refreshed.rpc('vault.watch')).unlocked,false)
  await assert.rejects(refreshed.rpc('catalog.watch'),{code:'VAULT_LOCKED'})
  await refreshed.rpc('vault.unlock',{password:'synthetic-master'})
  assert.equal((await refreshed.rpc('vault.status')).expiresAt,null)
  await refreshed.rpc('catalog.watch')
})

test('history consumes split UTF-8 and ANSI; frozen pages, search, cleanup and restart',async t=>{
  const parser=new TextTranscript(),bytes=Buffer.from('\x1b[31m你好\x1b[0m\r\n\x1b]0;secret-title\x07visible\n')
  let text='';for(const byte of bytes)text+=parser.feed(Buffer.from([byte]));text+=parser.flush()
  assert.equal(text,'你好\nvisible\n')
  const f=await fixture(t),h=f.ctx.terminalHistory;h.open('history-test','test-server','Test')
  for(let i=0;i<450;i++)h.append('history-test',Buffer.from(`line ${i} ${i===420?'needle':''}\n`))
  const range={sessionId:'history-test',...h.range('history-test')}
  h.append('history-test',Buffer.from('later output\n'))
  const first=h.page({search:'needle'},range);assert.equal(first.rows.length,0);assert.equal(first.done,false)
  const second=h.page({after:first.after,search:'needle'},range);assert.equal(second.rows.length,1);assert.equal(second.done,true)
  assert.equal(second.rows[0].text,'line 420 needle\n');h.close('history-test')
  await f.ctx.stop();const restored=await createApp(f.config);f.ctx=restored
  assert.equal(restored.terminalHistory.list('test-server').length,1)
  assert.ok(restored.terminalHistory.range('history-test').upper>range.upper)
  restored.terminalHistory.db.prepare('DELETE FROM chunks WHERE seq=?').run(range.lower)
  assert.throws(()=>restored.terminalHistory.page({},range),{code:'HISTORY_RANGE_EXPIRED'})
})

test('SSH: stored password and private key, host trust, byte ACK, input echo and cleanup',async t=>{
  const host=keyPair(),identity=keyPair(),parsedKey=ssh2.utils.parseKey(identity.privateKey),clients=new Set(),channels=[]
  let accepted=0,authentications=0
  const mock=new ssh2.Server({hostKeys:[host.privateKey]},client=>{
    clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{})
    client.on('authentication',context=>{
      authentications++
      if(context.method==='password' && context.username==='tester' && context.password==='synthetic-test-password')context.accept()
      else if(context.method==='publickey' && context.key.data.equals(parsedKey.getPublicSSH()) && (!context.signature || parsedKey.verify(context.blob,context.signature,context.hashAlgo)===true))context.accept()
      else context.reject()
    })
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>accept());session.on('window-change',accept=>accept?.());session.on('shell',accept=>{const stream=accept();channels.push(stream);accepted++;stream.on('data',bytes=>stream.write(bytes));stream.write(Buffer.from('mock-ready\r\n'))})
    }))
  })
  mock.listen(0,'127.0.0.1');await once(mock,'listening');const sshPort=mock.address().port
  t.after(async()=>{for(const client of clients)client.end();await new Promise(resolve=>mock.close(resolve))})
  const f=await fixture(t),page=await authorized(t,f);await page.rpc('catalog.replace',{catalog:catalog(sshPort),expectedRevision:0});await page.rpc('vault.configure',{mode:'local'})
  await page.rpc('credentials.save',{serverId:'test-server',connectionId:'ssh',kind:'password',secret:'synthetic-test-password'})
  const open=async()=>{
    const session=await page.rpc('connections.open',{serverId:'test-server',connectionId:'ssh'})
    const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/terminal',{origin:f.origin,headers:{cookie:page.cookie}}),messages=[],chunks=[]
    let received=0,autoAck=true
    ws.on('message',(data,binary)=>{if(binary){received+=data.length;chunks.push(data);if(autoAck)ws.send(JSON.stringify({type:'terminal.ack',parsedBytes:received}))}else messages.push(JSON.parse(data.toString()))})
    await once(ws,'open');ws.send(JSON.stringify({type:'terminal.attach',...session,cols:100,rows:30}))
    return {ws,messages,chunks,session,get received(){return received},pauseAck(){autoAck=false},resumeAck(){autoAck=true;ws.send(JSON.stringify({type:'terminal.ack',parsedBytes:received}))}}
  }
  const term=await open();t.after(()=>term.ws.terminate());await waitUntil(()=>term.messages.some(m=>m.type==='terminal.hostkey'))
  assert.equal(authentications,0)
  const fingerprint=term.messages.find(m=>m.type==='terminal.hostkey').fingerprint
  await page.rpc('sessions.hostKeyDecision',{sessionId:term.session.sessionId,accept:true,fingerprint})
  await waitUntil(()=>term.messages.some(m=>m.type==='terminal.ready'));await waitUntil(()=>term.received>0)
  term.ws.send(Buffer.from('echo-你好\n'));await waitUntil(()=>Buffer.concat(term.chunks).includes(Buffer.from('echo-你好')))
  term.pauseAck();const baseline=term.received;channels[0].write(Buffer.alloc(512*1024,65));await waitUntil(()=>term.received-baseline>=256*1024)
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(term.received-baseline,256*1024)
  term.resumeAck();await waitUntil(()=>term.received-baseline>=512*1024)
  term.ws.send(JSON.stringify({type:'terminal.ack',parsedBytes:term.received+1000}));await once(term.ws,'close')
  assert.throws(()=>f.ctx.sessions.owned('wrong-owner',term.session.sessionId),{code:'NOT_FOUND'})
  const keyPath=join(f.config.directory,'synthetic-private-key');await writeFile(keyPath,identity.privateKey)
  await page.rpc('credentials.save',{serverId:'test-server',connectionId:'ssh',kind:'key',path:keyPath})
  const keyed=await open();t.after(()=>keyed.ws.terminate());await waitUntil(()=>keyed.messages.some(m=>m.type==='terminal.ready'))
  assert.equal(keyed.messages.some(m=>m.type==='terminal.hostkey'),false);assert.equal(accepted,2)
  await page.rpc('sessions.close',{sessionId:keyed.session.sessionId});await waitUntil(()=>keyed.ws.readyState===WebSocket.CLOSED)
  // A changed stored fingerprint blocks authentication until explicit verification.
  f.ctx.storage.db.prepare('UPDATE hostkeys SET fingerprint=?').run('SHA256:previous-test-key')
  const changed=await open();t.after(()=>changed.ws.terminate());await waitUntil(()=>changed.messages.some(m=>m.type==='terminal.hostkey'))
  await assert.rejects(page.rpc('sessions.hostKeyDecision',{sessionId:changed.session.sessionId,accept:true,fingerprint}),{code:'HOSTKEY_CHANGED'})
  await page.rpc('sessions.hostKeyDecision',{sessionId:changed.session.sessionId,accept:false})
  assert.equal(accepted,2)
})
