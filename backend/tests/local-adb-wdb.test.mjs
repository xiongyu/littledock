import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { createApp } from '../src/app.ts'
import { adbProvider, parseAdbDevices } from '../src/plugins/adb/index.ts'
import { connectWdb, wdbInput } from '../src/plugins/wdb/index.ts'
import { parseCatalogImport } from '@webnav/shared'

const until=async(fn,ms=10000)=>{const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw new Error('Timed out');await new Promise(r=>setTimeout(r,15))}}
const catalog=(connections)=>({schemaVersion:1,groups:[],servers:[{id:'machine',name:'Synthetic machine',host:'127.0.0.1',groupId:'',note:'',tags:[],favorite:false,connections}]})
const local={id:'local',type:'local',name:'Local',port:1,saveHistory:false,pluginSettings:{shell:'auto'}}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'webnav-devices-')),front=join(directory,'ui');await mkdir(front);await writeFile(join(front,'index.html'),'test')
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r))
  const ctx=await createApp({directory,port,frontendRoot:front,rdpEnabled:false}),origin=`http://127.0.0.1:${port}`
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0],owner=ctx.auth.session(cookie).id
  t.after(async()=>{await ctx.stop();await rm(directory,{recursive:true,force:true})})
  return {ctx,origin,cookie,owner}
}
test('builtin connection schemas roundtrip and reject executable/secret injection',()=>{
  const input=catalog([local,{id:'adb',type:'adb',name:'ADB',port:5555,pluginSettings:{transport:'usb',serial:'synthetic-device',fps:2}},{id:'wdb',type:'wdb',name:'WDB',port:27880,username:'test',pluginSettings:{https:false}}])
  assert.deepEqual(parseCatalogImport(input),input)
  for(const settings of [{shell:'cmd /c evil'},{shell:'auto',password:'secret'},{cwd:'x\nfoo'}])assert.throws(()=>parseCatalogImport(catalog([{...local,pluginSettings:settings}])))
  for(const settings of [{serial:'-H bad'},{fps:100},{transport:'shell'}])assert.throws(()=>parseCatalogImport(catalog([{id:'a',name:'a',type:'adb',port:5555,pluginSettings:settings}])))
})
test('local PTY binds once, streams Unicode, resizes and releases on close',async t=>{
  const f=await fixture(t);f.ctx.storage.replace(catalog([local]),0)
  const ticket=f.ctx.connectors.open('local',f.owner,'machine','local')
  const socket=new WebSocket(f.origin.replace('http','ws')+'/ws/terminal',{origin:f.origin,headers:{cookie:f.cookie}})
  t.after(()=>socket.terminate());const messages=[],output=[];let bytes=0
  socket.on('message',(raw,binary)=>{if(binary){output.push(raw.toString('utf8'));bytes+=raw.length;socket.send(JSON.stringify({type:'terminal.ack',parsedBytes:bytes}))}else messages.push(JSON.parse(raw.toString()))})
  await once(socket,'open');socket.send(JSON.stringify({type:'terminal.attach',...ticket,cols:92,rows:27}))
  await until(()=>messages.some(m=>m.type==='terminal.ready'))
  socket.send(JSON.stringify({type:'terminal.resize',cols:110,rows:33}))
  socket.send(Buffer.from(process.platform==='win32'?"echo 'WEBNAV_LOCAL_测试'\r":"printf 'WEBNAV_LOCAL_测试\\n'\n"))
  await until(()=>output.join('').includes('WEBNAV_LOCAL_测试'))
  const intruder=(await fetch(f.origin)).headers.get('set-cookie').split(';')[0]
  assert.throws(()=>f.ctx.sessions.closeOwned(f.ctx.auth.session(intruder).id,ticket.sessionId),{code:'NOT_FOUND'})
  const duplicate=new WebSocket(f.origin.replace('http','ws')+'/ws/terminal',{origin:f.origin,headers:{cookie:f.cookie}})
  await once(duplicate,'open');duplicate.send(JSON.stringify({type:'terminal.attach',...ticket}));await once(duplicate,'close')
  // Replaying a ticket must not close the healthy owner channel.
  assert.equal(socket.readyState,WebSocket.OPEN)
  socket.close();await once(socket,'close');assert.equal(f.ctx.sessions.size,1)
  f.ctx.sessions.closeOwned(f.owner,ticket.sessionId);await until(()=>f.ctx.sessions.size===0)
})
test('ADB provider selects a device, bounds captures, requires control and quotes text',async()=>{
  const calls=[],messages=[],abort=new AbortController(),frame=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(frame);frame.writeUInt32BE(720,16);frame.writeUInt32BE(1280,20)
  let screenshots=0
  const run=async(args)=>{calls.push(args);if(args[0]==='devices')return Buffer.from('List of devices attached\nusb-one\tdevice model:Test_Phone\n');if(args.at(-1)==='get-state')return Buffer.from('device\n');if(args.includes('screencap')){screenshots++;return frame}return Buffer.from('')}
  const provider=await adbProvider(run)({host:'127.0.0.1',connection:{id:'a',name:'a',type:'adb',port:5555},signal:abort.signal,send:m=>{messages.push(m);return false},fail:message=>{throw new Error(message)}})
  await until(()=>screenshots===1)
  await new Promise(r=>setTimeout(r,1100));assert.equal(screenshots,1,'no unbounded screenshots while previous frame is blocked')
  await assert.rejects(provider.input({type:'adb.tap',x:0,y:0}),{code:'VIEW_ONLY'})
  await provider.input({type:'device.control',enabled:true});await provider.input({type:'adb.tap',x:719,y:1279})
  await assert.rejects(provider.input({type:'adb.tap',x:720,y:0}))
  await provider.input({type:'adb.text',text:"hello';$(touch x)"})
  assert.deepEqual(calls.at(-1),['-s','usb-one','shell','input','text',"'hello'\\'';$(touch%sx)'"])
  assert.equal(parseAdbDevices(Buffer.from('List of devices attached\na\tunauthorized\nb\toffline\n')).length,2)
  provider.close();const count=calls.length;await new Promise(r=>setTimeout(r,550));assert.equal(calls.length,count)
})
test('WDB authenticates server-side, forwards bounded video and releases input',async t=>{
  const cookie='wdb_session=synthetic-cookie',csrf='synthetic_csrf_123456789',received=[],sockets=[]
  const http=createServer(async(req,res)=>{if(req.url==='/api/status'){assert.equal(req.headers.cookie,cookie);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({runtime:{agent_mode:'full'}}));return}let body='';for await(const chunk of req)body+=chunk;assert.equal(req.url,'/api/login');assert.deepEqual(JSON.parse(body),{username:'admin',password:'synthetic-password'});res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',cookie+'; HttpOnly');res.end(JSON.stringify({ok:true,csrf_token:csrf}))})
  const wss=new WebSocketServer({noServer:true})
  http.on('upgrade',(req,socket,head)=>{assert.equal(req.headers.cookie,cookie);assert.ok(req.url.endsWith('?csrf='+csrf));wss.handleUpgrade(req,socket,head,ws=>{sockets.push(ws);ws.on('message',raw=>received.push(JSON.parse(raw.toString())));ws.send(JSON.stringify({type:'ready',channel:req.url.includes('control')?'control':'video'}));if(req.url.includes('video')){const packet=Buffer.alloc(16);packet.writeUInt32BE(4,8);ws.send(packet)}})})
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(async()=>{for(const ws of sockets)ws.terminate();wss.close();await new Promise(r=>http.close(r))})
  const output=[],abort=new AbortController(),stream=await connectWdb({host:'127.0.0.1',connection:{id:'w',name:'w',type:'wdb',port:http.address().port,username:'admin'},password:'synthetic-password',signal:abort.signal,send:m=>{output.push(m);return true},fail:()=>{}})
  await until(()=>output.some(Buffer.isBuffer));assert.equal(JSON.stringify(output).includes('synthetic-cookie'),false)
  assert.throws(()=>stream.input({type:'key',scan_code:30,extended:false,down:true}),{code:'VIEW_ONLY'})
  stream.input({type:'device.control',enabled:true});sockets[0].send(JSON.stringify({type:'control_state',enabled:true}));await until(()=>output.some(m=>m.type==='device.control'&&m.enabled))
  stream.input({type:'key',scan_code:30,extended:false,down:true});stream.input({type:'release_all'});await until(()=>received.some(m=>m.type==='release_all'))
  assert.throws(()=>wdbInput({type:'key',scan_code:66,extended:false,down:true}),{code:'RESERVED_KEY'})
  assert.throws(()=>wdbInput({type:'mouse_move',x:NaN,y:0}));assert.throws(()=>wdbInput({type:'exec',command:'anything'}))
  stream.close();await until(()=>sockets.every(ws=>ws.readyState===WebSocket.CLOSED))
})

test('device tickets isolate owners and replays, enforce ACK credit and close after a vault lock',async t=>{
  const f=await fixture(t),protocol='plugin:test.device'
  f.ctx.storage.replace(catalog([{id:'device',name:'Device',type:protocol,port:1}]),0)
  let output,closed=0
  const unregister=f.ctx.deviceSessions.register(protocol,async({send})=>{output=send;return {input:()=>{},close:()=>{closed++}}});t.after(unregister)
  const ticket=f.ctx.deviceSessions.create(f.owner,'machine','device')
  const foreign=(await fetch(f.origin)).headers.get('set-cookie').split(';')[0]
  const bind=async(cookie)=>{const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/device',{origin:f.origin,headers:{cookie}});const messages=[];ws.on('message',(b,binary)=>messages.push(binary?b:JSON.parse(b.toString())));await once(ws,'open');ws.send(JSON.stringify({type:'device.attach',...ticket}));return {ws,messages}}
  const wrong=await bind(foreign);await once(wrong.ws,'close');assert.equal(f.ctx.deviceSessions.size,1)
  const good=await bind(f.cookie);t.after(()=>good.ws.terminate());await until(()=>good.messages.some(m=>m.type==='device.ready'))
  const replay=await bind(f.cookie);await once(replay.ws,'close');assert.equal(good.ws.readyState,WebSocket.OPEN)
  assert.equal(output(Buffer.from('one')),true);assert.equal(output(Buffer.from('two')),true);assert.equal(output(Buffer.from('blocked')),false)
  await until(()=>good.messages.filter(Buffer.isBuffer).length===2)
  good.ws.send(JSON.stringify({type:'device.ack',sequence:2}));await new Promise(r=>setTimeout(r,50));assert.equal(output(Buffer.from('three')),true)
  // An impossible cumulative ACK cannot free credit and must release this owner only.
  good.ws.send(JSON.stringify({type:'device.ack',sequence:10}));await once(good.ws,'close');assert.equal(f.ctx.deviceSessions.size,0);assert.equal(closed,1)
  await f.ctx.credentials.changeMode('master','test-device-vault-password',10)
  const lockedTicket=f.ctx.deviceSessions.create(f.owner,'machine','device')
  f.ctx.credentials.lock();await until(()=>f.ctx.deviceSessions.size===0,2500)
  assert.throws(()=>f.ctx.deviceSessions.create(f.owner,'machine','device'),{code:'VAULT_LOCKED'});assert.equal(f.ctx.deviceSessions.closeOwned(f.owner,lockedTicket.sessionId).closed,true)
})

test('WDB reports management-only mode before creating media or control sockets',async t=>{
  const http=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/login'){res.setHeader('Set-Cookie','wdb_session=mode-test');res.end(JSON.stringify({csrf_token:'mode_test_123456789'}))}else res.end(JSON.stringify({runtime:{agent_mode:'management-only'}}))})
  http.on('upgrade',()=>assert.fail('Management-only mode must not open a socket'));http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise(r=>http.close(r)))
  await assert.rejects(connectWdb({host:'127.0.0.1',connection:{id:'w',name:'w',type:'wdb',port:http.address().port,username:'admin'},password:'test-password',signal:AbortSignal.timeout(5000),send:()=>true,fail:()=>{}}),{code:'WDB_MODE'})
})
