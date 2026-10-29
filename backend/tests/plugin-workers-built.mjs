// Run after pnpm build. Checks emitted JS Worker entry paths without a TypeScript loader.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { startApplication } from '../dist/app-host.js'

const root = await mkdtemp(join(tmpdir(), 'webnav-built-workers-'))
let app, ws
try {
  const bundles = join(root, 'plugins'), ui = join(root, 'ui'); await mkdir(bundles); await mkdir(ui)
  await writeFile(join(ui, 'index.html'), '<html>Compiled Worker fixture</html>')
  for (const name of ['collaboration-source', 'collaboration-client']) await cp(fileURLToPath(new URL('../../examples/plugins/' + name, import.meta.url)), join(bundles, name), { recursive: true })
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(r => socket.close(r))
  app = await startApplication({ directory: join(root, 'data'), port, frontendRoot: ui, bundledPluginsDirectory: bundles, rdpEnabled: false })
  const origin = `http://127.0.0.1:${port}`, response = await fetch(origin); assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie').split(';')[0]; await response.arrayBuffer()
  ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } })
  const [message] = await once(ws, 'message'), hello = JSON.parse(message.toString()), pending = new Map()
  ws.on('message', raw => { const p = JSON.parse(raw.toString()), task = pending.get(p.id); if (task) { pending.delete(p.id); clearTimeout(task.timer); p.ok ? task.resolve(p.result) : task.reject(Error(JSON.stringify(p.error))) } })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('Compiled RPC timeout')) }, 10000)
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ v: 1, type: 'request', id, epoch: hello.epoch, method, params, operationId: randomUUID() }))
  })
  let state
  for (let i = 0; i < 100; i++) { state = await rpc('plugins.state'); if (state.installed.every(p => p.running)) break; await new Promise(r => setTimeout(r, 50)) }
  const source = state.installed.find(p => p.manifest.id === 'example.collaboration-source'), client = state.installed.find(p => p.manifest.id === 'example.collaboration-client')
  const taskManager = state.builtins.find(p => p.id === 'builtin.taskManager')
  assert.equal(source.runtime.backend, 'shared'); assert.equal(client.runtime.backend, 'shared'); assert.equal(taskManager.runtime.backend, 'dedicated')
  assert.equal(source.runtime.threadId, app.status().threadId); assert.equal(client.runtime.threadId, source.runtime.threadId); assert.notEqual(taskManager.runtime.threadId, source.runtime.threadId)
  assert.deepEqual(await rpc('plugin.example.collaboration-client.add', { amount: 3, operationId: 'compiled-once' }), { value: 3 })
  console.log('PASS: compiled main gateway, shared/dedicated JS Workers, authenticated WS and cross-thread service call. Isolated local data only.')
} finally {
  ws?.terminate(); await app?.stop()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true })
}
