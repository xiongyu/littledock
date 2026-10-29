import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {WebSocket} from 'ws'
import {automationFixture,waitFor} from './automation-fixture.mjs'
import {parseWorkspaceView} from '@webnav/shared'
import {parseSessionCounts,sessionSummary} from '../src/desktop/session-status.ts'

async function business(f,cookie=f.cookie){
  const ws=new WebSocket(f.origin.replace('http','ws')+'/ws',{origin:f.origin,headers:{cookie}}),pending=new Map();let epoch
  ws.on('message',raw=>{const p=JSON.parse(String(raw));if(p.type==='hello')epoch=p.epoch;else if(p.type==='response'){const done=pending.get(p.id);if(done){pending.delete(p.id);p.ok?done.resolve(p.result):done.reject(Object.assign(new Error(p.error.message),p.error))}}})
  await waitFor(()=>epoch)
  return {ws,rpc(method,params={}){return new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});ws.send(JSON.stringify({v:1,type:'request',id,epoch,method,params,operationId:randomUUID()}))})}}
}
async function terminal(f,ticket){
  const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/terminal',{origin:f.origin,headers:{cookie:f.cookie}}),messages=[],chunks=[];let parsed=0
  ws.on('message',(raw,binary)=>{if(binary){chunks.push(raw.toString());parsed+=raw.length;ws.send(JSON.stringify({type:'terminal.ack',parsedBytes:parsed}))}else messages.push(JSON.parse(raw.toString()))})
  await once(ws,'open');ws.send(JSON.stringify({type:'terminal.attach',...ticket,cols:100,rows:30}))
  return {ws,messages,chunks}
}

test('ordinary SSH is backend owned: detach, bounded output, snapshot, fencing, same PTY and explicit close',{timeout:30000},async t=>{
  const f=await automationFixture();t.after(()=>f.close());const p=await business(f);t.after(()=>p.ws.terminate())
  const opened=await p.rpc('connections.open',{serverId:'alpha',connectionId:'ssh'}),first=await terminal(f,opened);t.after(()=>first.ws.terminate())
  await waitFor(()=>first.messages.some(m=>m.type==='terminal.ready'))
  const original=f.ctx.sessions.owned(f.owner,opened.sessionId),shell=[...f.streams][0]
  first.ws.close();await once(first.ws,'close');await waitFor(()=>!original.ws)
  assert.equal(f.ctx.sessions.size,1);assert.deepEqual(f.ctx.sessions.counts(),{ssh:1,local:0})
  const rows=Array.from({length:5000},(_,i)=>`detached-${i}\r\n`).join('')
  shell.write(Buffer.from(rows));shell.write(Buffer.from('\x1b[?1049h\x1b[2J\x1b[H后台屏幕😀'))
  await waitFor(()=>original.terminal.terminal.buffer.active.getLine(0)?.translateToString().includes('后台屏幕'))
  assert.ok(original.terminal.terminal.buffer.normal.length<=2030)
  const snapshot=await p.rpc('workspace.snapshot');assert.equal(snapshot.sessions[0].sessionId,opened.sessionId)
  const second=await terminal(f,await p.rpc('sessions.attachTicket',{sessionId:opened.sessionId}));t.after(()=>second.ws.terminate())
  await waitFor(()=>second.messages.some(m=>m.type==='terminal.ready'))
  assert.ok(second.chunks.join('').includes('后台屏幕😀'));assert.ok(second.chunks.join('').includes('\x1b[?1049h'))
  assert.equal(f.stats.connections,1);assert.equal(f.stats.shells,1);assert.equal(f.ctx.sessions.owned(f.owner,opened.sessionId),original)
  const third=await terminal(f,await p.rpc('sessions.attachTicket',{sessionId:opened.sessionId}));t.after(()=>third.ws.terminate())
  await waitFor(()=>third.messages.some(m=>m.type==='terminal.ready'));await waitFor(()=>second.ws.readyState===WebSocket.CLOSED)
  assert.throws(()=>f.ctx.sessions.input(f.owner,opened.sessionId,Buffer.from('stale'),second.ws),{code:'READ_ONLY'})
  third.ws.send(Buffer.from('current'));await waitFor(()=>f.stats.inputs.includes('current'))
  await p.rpc('sessions.close',{sessionId:opened.sessionId});await waitFor(()=>f.ctx.sessions.size===0&&f.streams.size===0)
  assert.deepEqual(f.ctx.sessions.counts(),{ssh:0,local:0})
})

test('workspace metadata is bounded, version checked, principal scoped and locked reattachment is rejected',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const p=await business(f);t.after(()=>p.ws.terminate())
  const ticket=await p.rpc('connections.open',{serverId:'alpha',connectionId:'ssh'}),view={groups:[{id:'group',focusedId:ticket.sessionId,layout:{kind:'pane',sessionId:ticket.sessionId}}],active:ticket.sessionId,floating:[],minimized:[]}
  const saved=await p.rpc('workspace.save',{expectedRevision:0,view});assert.equal(saved.revision,1)
  await assert.rejects(p.rpc('workspace.save',{expectedRevision:0,view}),{code:'REVISION_CONFLICT'})
  const otherCookie=f.ctx.auth.cookieName+'='+f.ctx.auth.create(),other=await business(f,otherCookie);t.after(()=>other.ws.terminate())
  assert.deepEqual((await other.rpc('workspace.snapshot')).sessions,[])
  await assert.rejects(other.rpc('sessions.attachTicket',{sessionId:ticket.sessionId}),{code:'NOT_FOUND'})
  p.ws.close();await once(p.ws,'close');const restored=await business(f);t.after(()=>restored.ws.terminate())
  assert.deepEqual((await restored.rpc('workspace.snapshot')).view,view)
  await restored.rpc('vault.update',{mode:'master',password:'test-only-master',unlockMinutes:5});await restored.rpc('vault.lock')
  await assert.rejects(restored.rpc('sessions.attachTicket',{sessionId:ticket.sessionId}),{code:'VAULT_LOCKED'})
  await assert.rejects(restored.rpc('workspace.snapshot'),{code:'VAULT_LOCKED'})
  await restored.rpc('sessions.close',{sessionId:ticket.sessionId})
  const recursive={kind:'split',id:'b',direction:'horizontal',ratio:50,first:{kind:'pane',sessionId:'x'},second:{kind:'pane',sessionId:'x'}}
  assert.throws(()=>parseWorkspaceView({...view,groups:[{id:'g',focusedId:'x',layout:recursive}]}))
  assert.throws(()=>parseWorkspaceView({...view,floating:Array(9).fill('x')}))
})

test('device detachment releases control and keeps the same provider, with fresh ACK state on attachment',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const p=await business(f);t.after(()=>p.ws.terminate())
  const catalog=f.ctx.storage.snapshot();catalog.snapshot.servers[0].connections.push({id:'wdb',name:'WDB',type:'wdb',port:27880,username:'test'})
  f.ctx.storage.replace(catalog.snapshot,catalog.revision)
  // Replace only the isolated fixture's device provider.
  f.ctx.deviceSessions.providers.delete('wdb');let starts=0,closes=0;const inputs=[]
  f.ctx.deviceSessions.register('wdb',async({send})=>{starts++;send({type:'device.info',codec:'h264',width:640,height:360});return {viewerVersion:1,input:m=>{inputs.push(m)},close:()=>closes++}})
  const opened=await p.rpc('connections.open',{serverId:'alpha',connectionId:'wdb'})
  const attach=async ticket=>{const ws=new WebSocket(f.origin.replace('http','ws')+'/ws/device',{origin:f.origin,headers:{cookie:f.cookie}}),messages=[];ws.on('message',raw=>messages.push(JSON.parse(String(raw))));await once(ws,'open');ws.send(JSON.stringify({type:'device.attach',...ticket}));await waitFor(()=>messages.some(m=>m.type==='device.ready'));return {ws,messages}}
  const first=await attach(opened);first.ws.close();await once(first.ws,'close');await waitFor(()=>inputs.some(m=>m.type==='device.visible'&&!m.visible))
  assert.equal(closes,0);assert.equal(f.ctx.deviceSessions.size,1)
  const next=await attach(await p.rpc('devices.attachTicket',{sessionId:opened.sessionId}));t.after(()=>next.ws.terminate())
  assert.equal(next.messages[0].codec,'h264');assert.equal(starts,1)
  await p.rpc('devices.close',{sessionId:opened.sessionId});assert.equal(closes,1)
})

test('tray summaries use validated runtime counts and distinguish zero from unknown',()=>{
  const zero={ssh:0,rdp:0,vnc:0,local:0,adb:0,wdb:0}
  assert.equal(sessionSummary(zero),'暂无运行');assert.equal(sessionSummary({...zero,ssh:2,rdp:1}),'SSH 2 · RDP 1')
  assert.equal(sessionSummary(),'正在读取连接状态');assert.equal(parseSessionCounts({...zero,ssh:-1}),undefined)
  assert.equal(parseSessionCounts({...zero,ssh:8,rdp:1}),undefined);assert.deepEqual(parseSessionCounts(zero),zero)
})

test('remote exit drains the final output through browser ACK before releasing its view',async t=>{
  const f=await automationFixture();t.after(()=>f.close());const p=await business(f);t.after(()=>p.ws.terminate())
  const opened=await p.rpc('connections.open',{serverId:'alpha',connectionId:'ssh'}),viewer=await terminal(f,opened);t.after(()=>viewer.ws.terminate())
  await waitFor(()=>viewer.messages.some(m=>m.type==='terminal.ready'))
  const tail='FINAL-OUTPUT-RETAINED',payload='x'.repeat(400000)+tail
  ;[...f.streams][0].end(payload)
  await waitFor(()=>viewer.messages.some(m=>m.type==='terminal.exit'))
  assert.ok(viewer.chunks.join('').includes(payload));await waitFor(()=>f.ctx.sessions.size===0)
})
