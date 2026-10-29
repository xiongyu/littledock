import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { GuacamoleDecoder, guacamoleInstruction as instruction, parseCatalogImport } from '@webnav/shared'
import { createApp } from '../src/app.ts'
import { authenticateVnc, vncChallengeResponse } from '../src/plugins/vnc-auth.ts'
import { DesktopSocketReader } from '../src/plugins/desktop-socket.ts'
import { mockVnc, mockRdp } from './desktop-fixtures.mjs'
import { FreeRdpPlugin } from '../src/plugins/rdp/index.ts'

const wait = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)) } }
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port }
async function fixture(t, embeddedRdpLauncher) {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-desktop-')), port = await freePort(), frontendRoot = join(directory, 'ui')
  await mkdir(frontendRoot); await writeFile(join(frontendRoot, 'index.html'), 'test')
  const launches = [], config = { directory, port, frontendRoot, embeddedRdpLauncher, rdpLauncher: { writeCredential: async () => {}, launch: async args => { launches.push(args) } } }
  const state = { ctx: await createApp(config), config, origin: `http://127.0.0.1:${port}`, launches }
  t.after(async () => { await state.ctx.stop(); await rm(directory, { recursive: true, force: true }) })
  return state
}
async function page(t, origin, existingCookie) {
  const cookie = existingCookie ?? (await fetch(origin, { headers: { connection: 'close' } })).headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }), pending = new Map()
  let epoch, sequence = 0
  ws.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.type === 'hello') epoch = message.epoch; else { const callback = pending.get(message.id); if (callback) { pending.delete(message.id); message.ok ? callback.resolve(message.result) : callback.reject(Object.assign(new Error(message.error.message), message.error)) } } })
  t.after(() => ws.terminate()); await wait(() => epoch)
  return { ws, cookie, rpc(method, params = {}, operationId = randomUUID()) { return new Promise((resolve, reject) => { const id = String(++sequence); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ v: 1, type: 'request', id, epoch, method, params, operationId })) }) } }
}
const catalog = connections => ({ schemaVersion: 1, groups: [], servers: [{ id: 'desktop', name: 'Synthetic desktop', host: '127.0.0.1', groupId: '', tags: [], note: '', favorite: true, connections }] })
async function attach(t, f, p, opened) {
  const ws = new WebSocket(f.origin.replace('http', 'ws') + '/ws/desktop', { origin: f.origin, headers: { cookie: p.cookie } })
  const messages = [], binary = []
  ws.on('message', (data, isBinary) => isBinary ? binary.push(Buffer.from(data)) : messages.push(JSON.parse(data.toString())))
  t.after(() => ws.terminate()); await once(ws, 'open'); ws.send(JSON.stringify({ type: 'desktop.attach', ...opened, width: 960, height: 540 }))
  await wait(() => messages.length); return { ws, messages, binary }
}

test('Guacamole handles fragmented instructions and Unicode, rejects malformed/unbounded input', () => {
  const results = [], parser = new GuacamoleDecoder(), text = instruction('clipboard', '', '中文😀') + instruction('sync', 8)
  for (const char of text) parser.push(char, row => results.push(row))
  assert.deepEqual(results, [['clipboard', '', '中文😀'], ['sync', '8']])
  for (const value of ['x.test;', '99999999.', '1.a!', '000000000.']) assert.throws(() => new GuacamoleDecoder(64).push(value, () => {}))
})

test('desktop websocket rejects missing sessions and a foreign Origin before any connection', async t => {
  const f = await fixture(t), p = await page(t, f.origin)
  for (const options of [{ origin: f.origin }, { origin: 'http://foreign.invalid', headers: { cookie: p.cookie } }]) {
    const ws = new WebSocket(f.origin.replace('http', 'ws') + '/ws/desktop', options); t.after(() => ws.terminate())
    await assert.rejects(once(ws, 'open'), /403/)
  }
})

test('VNC backend authenticates 3.3/3.7/3.8 independently against noVNC DES and preserves ServerInit', async t => {
  for (const version of ['003', '007', '008']) for (const password of [undefined, 'vnc-test']) {
    const peer = await mockVnc({ password, version }); t.after(() => peer.close())
    const socket = createConnection({ host: '127.0.0.1', port: peer.port }); t.after(() => socket.destroy()); await once(socket, 'connect'); socket.pause()
    await authenticateVnc(socket, password)
    const reader = new DesktopSocketReader(socket); socket.write(Buffer.from([1])); const init = await reader.read(24); reader.release()
    assert.equal(init.readUInt16BE(0), 640); assert.equal(init.readUInt16BE(2), 360)
    if (password) assert.deepEqual(peer.events.find(row => row[0] === 'authentication'), ['authentication', true])
    socket.destroy()
  }
  assert.throws(() => vncChallengeResponse('test', Buffer.alloc(8)))
})

test('VNC rejects invalid passwords and unsupported security before any desktop stream is bound', async t => {
  for (const options of [{ password: 'correct' }, { unsupported: true }]) {
    const peer = await mockVnc(options); t.after(() => peer.close()); const f = await fixture(t), p = await page(t, f.origin)
    await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog([{ id: 'vnc', name: 'VNC', type: 'vnc', port: peer.port }]), desktopPasswords: [{ serverId: 'desktop', connectionId: 'vnc', secret: 'incorrect' }] })
    const opened = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'vnc' }), desktop = await attach(t, f, p, opened)
    assert.equal(desktop.messages[0].type, 'desktop.error'); assert.equal(desktop.binary.length, 0)
    assert.match(desktop.messages[0].message, options.unsupported ? /认证/ : /密码认证失败/)
    await wait(() => peer.sockets.size === 0)
  }
})

test('desktop ticket ownership, replay protection, VNC binary traffic and socket disposal', async t => {
  const peer = await mockVnc({ password: 'vnc-test' }); t.after(() => peer.close()); const f = await fixture(t), p = await page(t, f.origin)
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog([{ id: 'vnc', name: 'VNC', type: 'vnc', port: peer.port }]), desktopPasswords: [{ serverId: 'desktop', connectionId: 'vnc', secret: 'vnc-test' }] })
  const args = { serverId: 'desktop', connectionId: 'vnc' }, op = randomUUID(), opened = await p.rpc('connections.open', args, op)
  assert.deepEqual(await p.rpc('connections.open', args, op), opened)
  const other = await page(t, f.origin), foreign = await attach(t, f, other, opened)
  assert.equal(foreign.messages[0].code, 'NOT_FOUND'); assert.equal(peer.events.length, 0)
  const desktop = await attach(t, f, p, opened); assert.equal(desktop.messages[0].type, 'desktop.bound')
  const replay = await attach(t, f, p, opened); assert.equal(replay.messages[0].code, 'UNAUTHORIZED'); assert.equal(desktop.ws.readyState, WebSocket.OPEN)
  await wait(() => desktop.binary.length); assert.equal(desktop.binary[0].toString(), 'RFB 003.008\n')
  desktop.ws.send(Buffer.from('RFB 003.008\n')); await wait(() => desktop.binary.length >= 2)
  assert.deepEqual(desktop.binary[1], Buffer.from([1, 1])); desktop.ws.send(Buffer.from([1])); await wait(() => desktop.binary.length >= 3)
  desktop.ws.send(Buffer.from([1])); await wait(() => desktop.binary.length >= 4); assert.equal(desktop.binary[3].readUInt16BE(), 640)
  assert.equal(JSON.stringify(desktop.messages).includes('vnc-test'), false)
  p.ws.close(); await once(p.ws, 'close'); assert.equal(desktop.ws.readyState, WebSocket.OPEN)
  desktop.ws.close(); await once(desktop.ws, 'close'); assert.equal(peer.sockets.size,1)
  const restored=await page(t,f.origin,p.cookie)
  assert.equal((await restored.rpc('workspace.snapshot')).sessions[0].sessionId,opened.sessionId)
  const next=await attach(t,f,restored,await restored.rpc('desktops.attachTicket',{sessionId:opened.sessionId}))
  assert.equal(next.messages[0].type,'desktop.bound');assert.equal(peer.events.filter(row=>row[0]==='connection').length,1)
  await restored.rpc('desktops.close',{sessionId:opened.sessionId});await wait(()=>peer.sockets.size===0)
})

test('RDP plugin receives saved options/secrets, preserves first drawing and restricts browser commands', async t => {
  const peer = mockRdp(); t.after(() => peer.close()); const f = await fixture(t, peer.launch), p = await page(t, f.origin)
  const connection = { id: 'rdp', name: 'RDP', type: 'rdp', port: 3389, username: 'tester', rdpClient: 'browser', rdpDisplay: { mode: 'windowed', width: 1280, height: 720 }, rdpOptions: { domain: 'LAB', security: 'nla', certificate: 'tofu' } }
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog([connection]), desktopPasswords: [{ serverId: 'desktop', connectionId: 'rdp', secret: 'synthetic-secret' }] })
  const opened = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' }), desktop = await attach(t, f, p, opened)
  assert.equal(desktop.messages[0].type, 'desktop.bound'); await wait(() => desktop.binary.length > 0)
  const params = peer.connections[0]; assert.equal(params.password, 'synthetic-secret'); assert.equal(params.connection.username, 'tester'); assert.equal(params.connection.rdpOptions.domain, 'LAB'); assert.equal(params.width, 1280); assert.equal(params.connection.rdpDisplay.mode, 'windowed'); assert.equal(params.connection.rdpOptions.certificate, 'tofu')
  assert.match(Buffer.concat(desktop.binary).toString(), /^4.size/); assert.equal(Buffer.concat(desktop.binary).includes(Buffer.from('synthetic-secret')), false)
  desktop.ws.send(Buffer.from(instruction('key', 65, 1))); await wait(() => peer.events.some(row => row[0] === 'key'))
  desktop.ws.send(Buffer.from(instruction('select', 'ssh'))); await wait(() => desktop.ws.readyState === WebSocket.CLOSED); assert.equal(peer.events.filter(row => row[0] === 'select').length, 0)
  await wait(() => peer.sockets.size === 0)
})

test('legacy RDP opens an embedded session after restart without rewriting its configuration or credentials', async t => {
  const peer = mockRdp(); t.after(() => peer.close()); const f = await fixture(t, peer.launch)
  let p = await page(t, f.origin)
  const connection = { id: 'rdp', name: 'RDP', type: 'rdp', port: 3389, username: 'tester', rdpDisplay: { mode: 'windowed', width: 1366, height: 768 } }
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog([connection]), desktopPasswords: [{ serverId: 'desktop', connectionId: 'rdp', secret: 'legacy-secret' }] })
  p.ws.terminate(); await f.ctx.stop(); f.ctx = await createApp(f.config); p = await page(t, f.origin)
  const opened = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' })
  assert.equal(opened.protocol, 'rdp'); assert.equal(typeof opened.sessionId, 'string'); assert.equal(typeof opened.attachToken, 'string')
  const desktop = await attach(t, f, p, opened)
  assert.equal(desktop.messages[0].type, 'desktop.bound'); await wait(() => desktop.binary.length > 0)
  assert.equal(f.launches.length, 0)
  assert.deepEqual(peer.connections[0].connection, connection); assert.equal(peer.connections[0].password, 'legacy-secret'); assert.equal(peer.connections[0].width, 1366)
  assert.deepEqual(f.ctx.storage.snapshot().snapshot, catalog([connection]))
  await p.rpc('desktops.close', { sessionId: opened.sessionId }); await wait(() => peer.sockets.size === 0)
})

test('changed RDP certificate waits for its bound page, survives refresh, and explicit close releases it', async t => {
  const peer = mockRdp(); t.after(() => peer.close())
  const certificate = { previousFingerprint: 'aa:'.repeat(31) + 'aa', fingerprint: 'bb:'.repeat(31) + 'bb' }, decisions = []
  const f = await fixture(t, async options => {
    const accepted = await options.confirmCertificate(certificate); decisions.push(accepted)
    if (!accepted) throw new Error('Certificate declined')
    return peer.launch(options)
  }), p = await page(t, f.origin)
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog([{ id: 'rdp', name: 'RDP', type: 'rdp', port: 3389 }]) })
  for (const action of ['accept', 'cancel', 'invalid', 'close']) {
    const opened = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' }), desktop = await attach(t, f, p, opened)
    const challenge = desktop.messages[0]
    assert.equal(challenge.type, 'desktop.certificate'); assert.equal(challenge.host, '127.0.0.1'); assert.equal(challenge.port, 3389)
    assert.equal(challenge.fingerprint, certificate.fingerprint); assert.equal(desktop.binary.length, 0)
    if (action === 'close') desktop.ws.close()
    else desktop.ws.send(JSON.stringify({ type: 'desktop.certificateDecision', requestId: action === 'invalid' ? 'stale-request' : challenge.requestId, accept: action === 'accept' }))
    if (action === 'accept') {
      await wait(() => desktop.messages.some(message => message.type === 'desktop.bound')); await wait(() => desktop.binary.length > 0)
      desktop.ws.close()
    }
    await wait(() => desktop.ws.readyState === WebSocket.CLOSED)
    if(action==='invalid'||action==='close'){
      assert.equal(decisions.length,['accept','cancel','invalid','close'].indexOf(action))
      const resumed=await attach(t,f,p,await p.rpc('desktops.attachTicket',{sessionId:opened.sessionId}))
      assert.equal(resumed.messages[0].requestId,challenge.requestId,'refresh preserves the pending certificate decision')
      await p.rpc('desktops.close',{sessionId:opened.sessionId})
    }
    await wait(() => decisions.length === ['accept', 'cancel', 'invalid', 'close'].indexOf(action) + 1)
  }
  assert.deepEqual(decisions, [true, false, false, false]); assert.equal(peer.connections.length, 1)
})

test('desktop options persist/import, explicit native mode remains, and vault migration/lock covers VNC and RDP', async t => {
  const f = await fixture(t), p = await page(t, f.origin)
  const connections = [{ id: 'rdp', name: 'Native', type: 'rdp', port: 3389, username: 'tester', rdpClient: 'native' }, { id: 'vnc', name: 'VNC', type: 'vnc', port: 5900 }]
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog(connections), desktopPasswords: connections.map(item => ({ serverId: 'desktop', connectionId: item.id, secret: 'synthetic-password' })) })
  await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' }); assert.equal(f.launches.length, 1)
  const exported = await p.rpc('exports.config'); assert.equal(exported.text.includes('synthetic-password'), false); assert.equal(parseCatalogImport(JSON.parse(exported.text)).servers[0].connections[1].type, 'vnc')
  await p.rpc('vault.update', { mode: 'master', password: 'synthetic-master', unlockMinutes: 5 }); assert.equal(f.ctx.credentials.desktopPassword('desktop', 'vnc'), 'synthetic-password')
  await p.rpc('vault.lock'); await assert.rejects(p.rpc('connections.open', { serverId: 'desktop', connectionId: 'vnc' }), { code: 'VAULT_LOCKED' })
  p.ws.terminate(); await f.ctx.stop(); f.ctx = await createApp(f.config)
  const restored = await page(t, f.origin); await restored.rpc('vault.unlock', { password: 'synthetic-master' }); assert.equal(f.ctx.credentials.desktopPassword('desktop', 'vnc'), 'synthetic-password')
  for (const bad of [{ ...connections[1], rdpClient: 'browser' }, { ...connections[0], rdpOptions: { security: 'invalid' } }, { ...connections[0], rdpOptions: { certificate: 'ignore' } }]) assert.throws(() => parseCatalogImport(catalog([bad])))
})

test('desktop resource limits, browser display restrictions, provider failure and teardown are explicit', async t => {
  const f = await fixture(t, async () => { throw new Error('RDP provider unavailable') }), p = await page(t, f.origin)
  const connection = { id: 'rdp', name: 'RDP', type: 'rdp', port: 3389, rdpClient: 'browser' }, args = { serverId: 'desktop', connectionId: 'rdp' }
  for (const [index, display] of [{ mode: 'multimon' }, { mode: 'windowed', width: 8192, height: 2160 }, undefined].entries()) {
    await p.rpc('catalog.replace', { expectedRevision: index, catalog: catalog([{ ...connection, ...(display ? { rdpDisplay: display } : {}) }]) })
    if (display) await assert.rejects(p.rpc('connections.open', args), { code: 'DISPLAY_MODE' })
  }
  const opened = []
  for (let i = 0; i < 4; i++) opened.push(await p.rpc('connections.open', args))
  await assert.rejects(p.rpc('connections.open', args), { code: 'BUSY' })
  const desktop = await attach(t, f, p, opened[0]); assert.equal(desktop.messages[0].type, 'desktop.error'); assert.equal(desktop.binary.length, 0)
  for (const item of opened.slice(1)) await p.rpc('desktops.close', { sessionId: item.sessionId })
  const next = await p.rpc('connections.open', args); await p.rpc('desktops.close', { sessionId: next.sessionId })
})

test('unloading the Cordis RDP plugin closes its desktops and preserves VNC registration', async t => {
  const peer = mockRdp(); t.after(() => peer.close()); const f = await fixture(t, peer.launch), p = await page(t, f.origin)
  const connections = [{ id: 'rdp', name: 'RDP', type: 'rdp', port: 3389, rdpClient: 'browser' }, { id: 'vnc', name: 'VNC', type: 'vnc', port: 5900 }]
  await p.rpc('catalog.replace', { expectedRevision: 0, catalog: catalog(connections) })
  const opened = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' }), desktop = await attach(t, f, p, opened)
  assert.equal(desktop.messages[0].type, 'desktop.bound')
  f.ctx.registry.get(FreeRdpPlugin).dispose()
  assert.equal(peer.connections[0].width, 1920); assert.equal(peer.connections[0].height, 1080)
  await wait(() => desktop.ws.readyState === WebSocket.CLOSED && peer.sockets.size === 0)
  await assert.rejects(p.rpc('connections.open', { serverId: 'desktop', connectionId: 'rdp' }), { code: 'NOT_IMPLEMENTED' })
  const vnc = await p.rpc('connections.open', { serverId: 'desktop', connectionId: 'vnc' }); await p.rpc('desktops.close', { sessionId: vnc.sessionId })
})
