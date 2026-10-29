import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { once } from 'node:events'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { MessageChannel } from 'node:worker_threads'
import { WorkerRpc } from '../src/plugin-system/worker-rpc.ts'
import { updatePreview } from '../src/plugin-system/update-preview.ts'
import { activateDedicated } from '../src/plugin-system/worker-host.ts'
import { startService } from '../src/plugin-system/service-host.ts'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { parsePluginManifest } from '@webnav/shared'
import { startApplication } from '../src/app-host.ts'

const manifest = {
  schemaVersion: 1, id: 'example.worker', name: '线程测试', version: '1.0.0', description: 'Isolated test', author: 'test', license: 'MIT',
  category: 'development', secondaryCategories: [], apiVersion: 1, webnav: '^0.1.1', node: '>=22.12.0',
  platforms: [{ os: process.platform, arch: process.arch }], capabilities: [{ id: 'extension:worker', version: 1 }],
  dataVersion: 1, icon: 'icon.svg', backend: 'backend.mjs',
}
const identityCode = `import {isMainThread,threadId} from 'node:worker_threads';
globalThis.__webnavPluginWorkerOnly=true;
export function activate(api){
 api.registerRpc('identity',{mutate:false,handler:()=>({isMainThread,threadId})});
 api.registerRpc('echo',{mutate:false,handler:(_owner,params)=>params});
 api.registerRpc('sdk',{mutate:false,handler:()=>({services:'services' in api,syncLease:'acquireResource' in api})});
 api.registerRpc('block',{mutate:false,handler:(_owner,p)=>{const end=Date.now()+p.ms;while(Date.now()<end){};return {threadId}}});
 api.registerRpc('hang',{mutate:false,handler:()=>{while(true){}}});
 api.registerRpc('exit',{mutate:false,handler:()=>process.exit(7)});
 let release;
 api.registerRpc('hold',{mutate:true,handler:async()=>{release??=await api.host.acquireResource();return true}});
 api.registerRpc('release',{mutate:true,maintenance:'finish',handler:()=>{release?.();release=undefined;return true}});
}`
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value }
async function until(check, milliseconds = 20000) { const end = Date.now() + milliseconds; while (!await check()) { if (Date.now() > end) throw Error('Condition timeout'); await new Promise(r => setTimeout(r, 30)) } }
async function fixture(t, packages) {
  const root = await mkdtemp(join(tmpdir(), 'webnav-worker-test-')), bundles = join(root, 'bundles'), ui = join(root, 'ui')
  await mkdir(bundles); await mkdir(ui); await writeFile(join(ui, 'index.html'), '<html>isolated worker test</html>')
  for (const p of packages) {
    const folder = join(bundles, p.id); await mkdir(folder)
    if (p.source) await cp(p.source, folder, { recursive: true })
    const original = p.source ? JSON.parse(await readFile(join(folder, 'webnav.plugin.json'), 'utf8')) : manifest
    await writeFile(join(folder, 'webnav.plugin.json'), JSON.stringify({ ...original, id: p.id, ...(!p.source ? { capabilities: [{ id: 'extension:' + p.id, version: 1 }] } : {}), ...(p.dedicated ? { execution: { backend: 'dedicated' } } : {}), ...p.manifest }))
    if (!p.source) { await writeFile(join(folder, 'backend.mjs'), p.code ?? identityCode); await writeFile(join(folder, 'README.md'), 'Fixture only'); await writeFile(join(folder, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>') }
  }
  const listen = await port(), origin = `http://127.0.0.1:${listen}`, sockets = new Set()
  const app = await startApplication({ directory: join(root, 'data'), port: listen, frontendRoot: ui, bundledPluginsDirectory: bundles, rdpEnabled: false })
  t.after(async () => { for (const socket of sockets) socket.terminate(); await app.stop().catch(() => {}); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }) })
  const response = await fetch(origin), cookie = response.headers.get('set-cookie').split(';')[0]
  await response.arrayBuffer()
  async function page() {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }); sockets.add(ws)
    const pending = new Map(); let hello
    ws.on('message', raw => { const p = JSON.parse(raw.toString()); if (p.type === 'hello') hello = p; const task = pending.get(p.id); if (task) { pending.delete(p.id); clearTimeout(task.timer); p.ok ? task.resolve(p.result) : task.reject(Object.assign(Error(p.error.message), { code: p.error.code })) } })
    ws.on('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('socket closed')) }; pending.clear() })
    await once(ws, 'open'); await until(() => hello)
    const rpc = (method, params = {}, mutate = false, timeout = 25000) => new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + method)) }, timeout)
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ v: 1, type: 'request', id, epoch: hello.epoch, method, params, ...(mutate ? { operationId: randomUUID() } : {}) }))
    })
    return { ws, rpc }
  }
  const p = await page()
  await until(async () => (await p.rpc('plugins.state')).installed.every(item => item.running || item.error))
  return { app, origin, cookie, ...p, page, root }
}

test('execution declarations default to shared and permit service plugins in dedicated Workers', () => {
  assert.equal(parsePluginManifest(manifest).execution, undefined)
  assert.equal(parsePluginManifest({ ...manifest, execution: { backend: 'dedicated' } }).execution.backend, 'dedicated')
  for (const execution of [{ backend: 'host' }, { backend: 'worker' }, { backend: 'shared', other: true }, true]) assert.throws(() => parsePluginManifest({ ...manifest, execution }))
  assert.throws(() => parsePluginManifest({ ...manifest, backend: undefined, frontend: 'ui/main.js', execution: { backend: 'dedicated' } }))
  assert.equal(parsePluginManifest({ ...manifest, capabilities: [{ id: 'service:taskManager', version: 1 }], execution: { backend: 'dedicated' } }).execution.backend, 'dedicated')
  assert.ok(updatePreview({ ...manifest, execution: { backend: 'dedicated' } }, 'b'.repeat(40), { manifest, commit: 'a'.repeat(40) }).changes.includes('后端改为独占插件线程。'))
})

test('real gateway runs default plugins together off main, dedicated plugin separately, preserves auth and streams', { timeout: 40000 }, async t => {
  const f = await fixture(t, [{ id: 'example.one' }, { id: 'example.two' }, { id: 'example.solo', dedicated: true }])
  const a = await f.rpc('plugin.example.one.identity'), b = await f.rpc('plugin.example.two.identity'), c = await f.rpc('plugin.example.solo.identity')
  assert.equal(a.isMainThread, false); assert.equal(b.isMainThread, false); assert.equal(c.isMainThread, false)
  assert.equal(a.threadId, b.threadId); assert.equal(a.threadId, f.app.status().threadId); assert.notEqual(c.threadId, a.threadId)
  assert.equal(globalThis.__webnavPluginWorkerOnly, undefined)
  assert.deepEqual(await f.rpc('plugin.example.one.sdk'), { services: false, syncLease: false })
  assert.deepEqual(await f.rpc('plugin.example.solo.sdk'), { services: false, syncLease: false })
  assert.deepEqual(await f.rpc('plugin.example.solo.echo', { signalId: 'business-value', signal: 'plain-json' }), { signalId: 'business-value', signal: 'plain-json' })
  const tick = new Promise(resolve => setTimeout(() => resolve(Date.now()), 50)), started = Date.now()
  const blocking = f.rpc('plugin.example.one.block', { ms: 700 })
  assert.ok(await tick - started < 500, 'host event loop must keep scheduling during plugin CPU work')
  await blocking
  const invalid = await new Promise((resolve, reject) => { const req = request(f.origin, { headers: { host: 'invalid.example' } }, response => { response.resume(); resolve(response.statusCode) }); req.on('error', reject); req.end() }); assert.equal(invalid, 403)
  const catalog = await f.rpc('catalog.watch'); assert.equal(catalog.snapshot.servers.length, 0)
  await f.rpc('plugin.example.solo.hold', {}, true)
  let state = await f.rpc('plugins.state')
  await f.rpc('plugins.change', { id: 'example.solo', action: 'disable', expectedRevision: state.revision }, true)
  state = await f.rpc('plugins.state'); assert.equal(state.pending.find(p => p.id === 'example.solo').kind, 'waiting')
  await f.rpc('plugin.example.solo.release', {}, true)
  await until(async () => !(await f.rpc('plugins.state')).installed.find(p => p.manifest.id === 'example.solo').running)
  assert.equal((await f.rpc('plugin.example.one.identity')).threadId, a.threadId)
})

test('task manager and system optimizer own two different Workers; other shipped plugins use the shared Worker', { skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 20000 }, async t => {
  const f = await fixture(t, [
    { id: 'webnav.system-optimizer', source: resolve('../plugins/system-optimizer') },
    { id: 'example.collaboration-source', source: resolve('../examples/plugins/collaboration-source') },
    { id: 'example.collaboration-client', source: resolve('../examples/plugins/collaboration-client') },
  ])
  const state = await f.rpc('plugins.state'), shared = f.app.status().threadId
  const task = state.builtins.find(p => p.id === 'builtin.taskManager'), optimizer = state.installed.find(p => p.manifest.id === 'webnav.system-optimizer')
  assert.equal(task.runtime.backend, 'dedicated'); assert.equal(optimizer.runtime.backend, 'dedicated')
  assert.equal(new Set([shared, task.runtime.threadId, optimizer.runtime.threadId]).size, 3)
  for (const plugin of state.builtins.filter(p => p.runtime && p.id !== task.id)) assert.deepEqual(plugin.runtime, { backend: 'shared', threadId: shared })
  for (const plugin of state.installed.filter(p => p.manifest.id !== 'webnav.system-optimizer')) assert.deepEqual(plugin.runtime, { backend: 'shared', threadId: shared })
  assert.equal((await f.rpc('plugin.example.collaboration-client.add', { amount: 1, operationId: 'default-shared' }, true)).value, 1)
})

test('service scheduler uses the declared execution mode and contains a hung dedicated service', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'webnav-service-worker-')), file = join(root, 'service.mjs'), actors = []
  await writeFile(file, `import {threadId} from 'node:worker_threads';export async function createService(){return {methods:{identity:()=>threadId,hang:()=>{while(true){}}},dispose:async()=>{}}}`)
  t.after(async () => { await Promise.all(actors.map(a => a.stop().catch(() => {}))); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }) })
  let failure
  const shared = startService(pathToFileURL(file), {}, 'shared', () => {}, () => {}), dedicated = startService(pathToFileURL(file), {}, 'dedicated', () => {}, error => { failure = error })
  actors.push(shared, dedicated); await Promise.all(actors.map(a => a.ready))
  assert.equal(await shared.call('identity', []), 0); assert.notEqual(await dedicated.call('identity', []), 0)
  const hung = assert.rejects(dedicated.call('hang', []), { code: 'PLUGIN_UNRESPONSIVE' })
  assert.equal(await shared.call('identity', []), 0)
  await hung; assert.equal(failure.code, 'PLUGIN_UNRESPONSIVE'); assert.equal(await shared.call('identity', []), 0)
})

test('application shutdown awaits shared and dedicated plugin cleanup before terminating the runtime', { timeout: 15000 }, async t => {
  const code = `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';export function activate(api){api.onDispose(async()=>{await new Promise(r=>setTimeout(r,150));await writeFile(join(api.dataDirectory,'closed.txt'),'cleaned')})}`
  const f = await fixture(t, [{ id: 'example.clean-shared', code }, { id: 'example.clean-dedicated', code, dedicated: true }])
  await f.app.stop()
  for (const id of ['example.clean-shared', 'example.clean-dedicated']) assert.equal(await readFile(join(f.root, 'data/plugins/data', id, 'closed.txt'), 'utf8'), 'cleaned')
})

test('cross-Worker interop preserves owner, validation, subscriptions and hot replacement', { timeout: 40000 }, async t => {
  const f = await fixture(t, [
    { id: 'example.collaboration-source', source: resolve('../examples/plugins/collaboration-source') },
    { id: 'example.collaboration-client', source: resolve('../examples/plugins/collaboration-client'), dedicated: true },
  ])
  const method = 'plugin.example.collaboration-client.'
  assert.deepEqual(await f.rpc(method + 'add', { amount: 2, operationId: 'once' }, true), { value: 2 })
  assert.deepEqual(await f.rpc(method + 'add', { amount: 2, operationId: 'once' }, true), { value: 2 })
  await until(async () => (await f.rpc(method + 'state')).value?.value === 2)
  await assert.rejects(f.rpc(method + 'add', { amount: 11, operationId: 'bad' }, true), { code: 'INVALID_PARAMS' })
  const state = await f.rpc('plugins.state')
  await f.rpc('plugins.change', { id: 'example.collaboration-source', action: 'disable', expectedRevision: state.revision }, true)
  await until(async () => (await f.rpc(method + 'state')).available === false)
})

test('dedicated Worker crash is contained and does not replay or restart plugin', { timeout: 30000 }, async t => {
  const f = await fixture(t, [{ id: 'example.shared' }, { id: 'example.crash', dedicated: true }])
  await assert.rejects(f.rpc('plugin.example.crash.exit'))
  await until(async () => (await f.rpc('plugins.state')).installed.find(p => p.manifest.id === 'example.crash').error)
  assert.equal((await f.rpc('plugin.example.shared.identity')).isMainThread, false)
  assert.equal(f.app.status().state, 'ready')
  await assert.rejects(f.rpc('plugin.example.crash.identity'), { code: 'NOT_FOUND' })
})

test('dedicated module import and handler deadlocks are stopped by coordinator watchdog', { timeout: 45000 }, async t => {
  const f = await fixture(t, [
    { id: 'example.bad-import', dedicated: true, code: 'while(true){};export function activate(){}' },
    { id: 'example.healthy' }, { id: 'example.solo', dedicated: true },
  ])
  const state = await f.rpc('plugins.state')
  assert.ok(state.installed.find(p => p.manifest.id === 'example.bad-import').error)
  assert.equal((await f.rpc('plugin.example.healthy.identity')).isMainThread, false)
  const stalled = f.rpc('plugin.example.solo.hang'); const rejected = assert.rejects(stalled)
  assert.equal((await f.rpc('plugin.example.healthy.identity')).isMainThread, false)
  await rejected
  await until(async () => !!(await f.rpc('plugins.state')).installed.find(p => p.manifest.id === 'example.solo').error)
  assert.equal((await f.rpc('plugin.example.healthy.identity')).isMainThread, false)
})

test('dedicated hot replacement commits a new thread, failed activation keeps old instance, disable disposes once', { timeout: 30000 }, async t => {
  const code = `import {threadId} from 'node:worker_threads';import {appendFile} from 'node:fs/promises';import {join} from 'node:path';
  export function activate(api){if(api.config.fail)throw Error('synthetic start failure');api.registerRpc('identity',{mutate:false,handler:()=>({threadId})});api.onDispose(()=>appendFile(join(api.dataDirectory,'disposed.txt'),threadId+'\\n'));}`
  const f = await fixture(t, [{ id: 'example.update', dedicated: true, code, manifest: { configFields: [{ key: 'fail', label: 'Fail', type: 'boolean' }, { key: 'revision', label: 'Revision', type: 'number' }] } }])
  const change = async config => { const state = await f.rpc('plugins.state'); await f.rpc('plugins.change', { id: 'example.update', action: 'configure', config, expectedRevision: state.revision }, true) }
  const first = await f.rpc('plugin.example.update.identity')
  await change({ fail: false, revision: 1 })
  const second = await f.rpc('plugin.example.update.identity'); assert.notEqual(second.threadId, first.threadId)
  await change({ fail: true, revision: 2 })
  assert.deepEqual(await f.rpc('plugin.example.update.identity'), second)
  const state = await f.rpc('plugins.state')
  assert.equal(state.installed[0].runtime.threadId, second.threadId)
  await f.rpc('plugins.change', { id: 'example.update', action: 'disable', expectedRevision: state.revision }, true)
  const closed = (await readFile(join(f.root, 'data/plugins/data/example.update/disposed.txt'), 'utf8')).trim().split('\n').map(Number)
  assert.deepEqual(closed, [first.threadId, second.threadId])
})

test('shared synchronous hang leaves main responsive, fails gateway promptly, and shutdown is bounded', { timeout: 35000 }, async t => {
  const f = await fixture(t, [{ id: 'example.hang' }])
  const hang = f.rpc('plugin.example.hang.hang').catch(() => {})
  await until(() => f.app.status().state === 'unresponsive', 12000)
  const started = Date.now(), response = await fetch(f.origin)
  assert.equal(response.status, 503); await response.arrayBuffer(); assert.ok(Date.now() - started < 1500)
  await assert.rejects(f.app.prepareUpdate(), /无响应/)
  await f.app.stop().catch(() => {}); await hang
  assert.equal(f.app.status().state, 'stopped')
})

test('Worker RPC bounds payloads and concurrent calls, propagates cancellation and rejects pending work on close', async () => {
  const { port1, port2 } = new MessageChannel(), a = new WorkerRpc(port1), b = new WorkerRpc(port2)
  try {
    b.handler = async (_method, _args, _context, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))
    await assert.rejects(a.call('large', ['x'.repeat(2 * 1024 * 1024)]), { code: 'LIMIT_EXCEEDED' })
    const controller = new AbortController(), cancelled = a.call('cancel', [], undefined, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); assert.equal(await cancelled, 'cancelled')
    const pending = Array.from({ length: 64 }, () => a.call('pending').catch(error => error.code))
    await assert.rejects(a.call('overflow'), { code: 'BUSY' })
    a.close(); assert.ok((await Promise.all(pending)).every(code => code === 'PLUGIN_UNAVAILABLE'))
  } finally { a.close(); b.close(); port1.close(); port2.close() }
})

test('concurrent calls of the same dedicated automation tool have separate cancellation identities', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-worker-cancel-')), entry = join(directory, 'backend.mjs'), cleanups = [], handlers = new Map()
  await writeFile(entry, `export function activate(api){api.registerAutomationTool('wait',(input,call)=>new Promise(resolve=>{if(call.signal.aborted)resolve(input);else call.signal.addEventListener('abort',()=>resolve(input),{once:true})}))}`)
  const scope = { requireActive() {}, resources: 0, onDispose(fn) { cleanups.push(fn) } }
  const api = { manifest, config: {}, dataDirectory: directory, registerAutomationTool(name, handler) { handlers.set(name, handler) } }
  const interop = { capture() {}, withContext(_context, callback) { return callback() } }
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }) })
  await activateDedicated(entry, api, scope, interop, () => {})
  const a = new AbortController(), b = new AbortController(), handler = handlers.get('wait')
  const first = handler({ id: 'first' }, { clientId: 'one', signal: a.signal }), second = handler({ id: 'second' }, { clientId: 'two', signal: b.signal })
  await new Promise(resolve => setTimeout(resolve, 30)); a.abort()
  assert.deepEqual(await first, { id: 'first' })
  assert.equal(await Promise.race([second.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('pending'), 40))]), 'pending')
  b.abort(); assert.deepEqual(await second, { id: 'second' })
})

test('real gateway preserves SSH host verification, binary output, browser reattachment and explicit close', { timeout: 30000 }, async t => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const peers = new Set(); let shells = 0
  const ssh = new ssh2.Server({ hostKeys: [keys.privateKey] }, client => {
    peers.add(client); client.on('error', () => {}); client.on('close', () => peers.delete(client)); client.on('authentication', auth => auth.accept())
    client.on('ready', () => client.on('session', accept => { const session = accept(); session.on('pty', accept => accept()); session.on('shell', accept => { shells++; const channel = accept(); channel.write('worker-shell-ready\r\n'); channel.on('data', bytes => channel.write(bytes)) }) }))
  })
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening')
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => ssh.close(resolve)) })
  const f = await fixture(t, [])
  await f.rpc('catalog.replace', { expectedRevision: 0, catalog: { schemaVersion: 1, groups: [], servers: [{ id: 'test', name: 'Loopback', host: '127.0.0.1', groupId: '', tags: [], note: '', favorite: false, connections: [{ id: 'ssh', name: 'SSH', type: 'ssh', port: ssh.address().port, username: 'fixture' }] }] } }, true)
  await f.rpc('credentials.save', { serverId: 'test', connectionId: 'ssh', kind: 'password', secret: 'isolated-test-only' }, true)
  const ticket = await f.rpc('connections.open', { serverId: 'test', connectionId: 'ssh' }, true)
  async function attach(ticket) {
    const ws = new WebSocket(f.origin.replace('http', 'ws') + '/ws/terminal', { origin: f.origin, headers: { cookie: f.cookie } }), messages = [], output = []; let bytes = 0
    t.after(() => ws.terminate())
    ws.on('message', (raw, binary) => { if (binary) { output.push(raw.toString()); bytes += raw.length; ws.send(JSON.stringify({ type: 'terminal.ack', parsedBytes: bytes })) } else messages.push(JSON.parse(raw.toString())) })
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'terminal.attach', ...ticket, cols: 80, rows: 24 })); return { ws, messages, output }
  }
  const first = await attach(ticket)
  await until(() => first.messages.some(p => p.type === 'terminal.hostkey'))
  await f.rpc('sessions.hostKeyDecision', { sessionId: ticket.sessionId, accept: true, fingerprint: first.messages.find(p => p.type === 'terminal.hostkey').fingerprint }, true)
  await until(() => first.output.join('').includes('worker-shell-ready'))
  first.ws.close(); await once(first.ws, 'close')
  const second = await attach(await f.rpc('sessions.attachTicket', { sessionId: ticket.sessionId }))
  await until(() => second.messages.some(p => p.type === 'terminal.ready')); second.ws.send(Buffer.from('worker-echo'))
  await until(() => second.output.join('').includes('worker-echo')); assert.equal(shells, 1)
  await f.rpc('sessions.close', { sessionId: ticket.sessionId }, true)
  await until(async () => (await f.rpc('workspace.snapshot')).sessions.length === 0)
})
