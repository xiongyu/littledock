import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/app.ts'

async function waitFor(check) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 15)) } assert.fail('condition timed out') }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-recorder-host-')), frontendRoot = join(directory, 'ui'), homeDirectory = join(directory, 'home')
  await mkdir(frontendRoot); await mkdir(homeDirectory); await writeFile(join(frontendRoot, 'index.html'), '<html>isolated recorder fixture</html>')
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const ctx = await createApp({ directory, frontendRoot, port, taskManagerConfig: { homeDirectory } })
  t.after(async () => { await ctx.stop(); assert.match(relative(tmpdir(), directory), /^webnav-recorder-host-[\w-]+$/); await rm(directory, { recursive: true, force: true }) })
  return { ctx, origin: `http://127.0.0.1:${port}` }
}
async function page(t, origin, existingCookie) {
  const cookie = existingCookie ?? (await fetch(origin)).headers.get('set-cookie').split(';')[0], ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }), waiting = new Map()
  let epoch, serial = 0
  await new Promise(resolve => ws.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'hello') { epoch = message.epoch; resolve(); return } const pending = waiting.get(message.id); if (!pending) return; waiting.delete(message.id); clearTimeout(pending.timer); message.ok ? pending.resolve(message.result) : pending.reject(Object.assign(new Error(message.error.message), message.error)) }))
  t.after(() => ws.terminate())
  return { ws, cookie, rpc(method, params, operationId = randomUUID()) { return new Promise((resolve, reject) => { const id = String(++serial), timer = setTimeout(() => { waiting.delete(id); reject(new Error('RPC timeout: ' + method)) }, 10_000); waiting.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, operationId })) }) } }
}

test('recording WS forwards stable operation IDs, scopes history to each page, and leaves target state on detach', async t => {
  const f = await fixture(t), monitors = new Map(), calls = [], closed = []
  let status = { enabled: false, intervalSeconds: 5, retentionDays: 7, maxMiB: 256, revision: 0, state: 'disabled', running: false, directory: '/fixture/recording-v1', storedBytes: 0 }
  const fake = {
    get size() { return monitors.size }, sizeRemote: 0, hasResources() { return !!monitors.size },
    start(owner, target) { const state = { id: randomUUID(), target, label: 'Fixture', phase: 'ready' }; monitors.set(state.id, state); return state },
    close(_owner, id) { closed.push(id); monitors.delete(id); return {} },
    recordingStatus() { return { ...status } },
    configureRecording(owner, id, input) { calls.push({ owner, id, input }); status = { ...status, ...input.config, revision: status.revision + 1, state: input.config.enabled ? 'recording' : 'disabled', running: input.config.enabled }; return { ...status } },
    queryHistory(_owner, _id, query) { return { from: query.from, to: query.to, points: [], totalSamples: 0, truncated: false, gaps: [] } },
    historyPoint(_owner, _id, id) { return { id } },
  }
  f.ctx.plugins.slots.get('taskManager').bridge.swap(fake)
  const a = await page(t, f.origin), b = await page(t, f.origin, a.cookie), monitor = await a.rpc('taskManager.start', { target: { kind: 'local' } })
  const config = { enabled: true, intervalSeconds: 5, retentionDays: 7, maxMiB: 256 }, params = { monitorId: monitor.id, config, expectedRevision: 0 }, operationId = randomUUID()
  const enabled = await a.rpc('taskManager.configureRecording', params, operationId)
  assert.equal(enabled.running, true); assert.equal(calls.length, 1); assert.equal(calls[0].input.operationId, operationId)
  assert.deepEqual(await a.rpc('taskManager.configureRecording', params, operationId), enabled); assert.equal(calls.length, 1)
  await assert.rejects(a.rpc('taskManager.configureRecording', { ...params, config: { ...config, enabled: false } }, operationId), { code: 'OPERATION_CONFLICT' })
  await assert.rejects(b.rpc('taskManager.recordingStatus', { monitorId: monitor.id }), { code: 'NOT_FOUND' })
  await assert.rejects(b.rpc('taskManager.queryHistory', { monitorId: monitor.id, query: { from: 0, to: 1 } }), { code: 'NOT_FOUND' })
  assert.deepEqual(await a.rpc('taskManager.historyPoint', { monitorId: monitor.id, id: 'sample:1' }), { id: 'sample:1' })
  f.ctx.maintenance.draining = true
  assert.equal((await a.rpc('taskManager.recordingStatus', { monitorId: monitor.id })).running, true)
  assert.deepEqual((await a.rpc('taskManager.queryHistory', { monitorId: monitor.id, query: { from: 0, to: 1 } })).points, [])
  await assert.rejects(a.rpc('taskManager.configureRecording', { ...params, expectedRevision: 1 }), { code: 'UPDATE_WAITING' }); assert.equal(calls.length, 1)
  f.ctx.maintenance.draining = false
  a.ws.close(); await waitFor(() => closed.includes(monitor.id)); assert.equal(status.enabled, true); assert.equal(calls.length, 1)
  const fresh = await b.rpc('taskManager.start', { target: { kind: 'local' } })
  assert.equal((await b.rpc('taskManager.recordingStatus', { monitorId: fresh.id })).running, true)
  await assert.rejects(b.rpc('taskManager.configureRecording', { monitorId: fresh.id, config, expectedRevision: 1 }, null), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 1)
})
