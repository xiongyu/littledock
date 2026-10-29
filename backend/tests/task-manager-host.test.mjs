import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { parseTaskManagerTarget, parseTaskManagerSnapshot, parseTaskManagerPerformance } from '@webnav/shared'
import { createApp } from '../src/app.ts'
import { connectionCount, requireConnectionCapacity } from '../src/core/connection-budget.ts'
import { defaultPackageDirectory } from '../src/plugins/task-manager/packages.ts'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-task-host-')), homeDirectory = join(directory, '用户 home'), frontendRoot = join(directory, 'ui')
  await mkdir(homeDirectory); await mkdir(frontendRoot); await writeFile(join(frontendRoot, 'index.html'), '<html>isolated test</html>')
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const ctx = await createApp({ directory, frontendRoot, port, taskManagerConfig: { homeDirectory } })
  t.after(async () => { await ctx.stop(); assert.match(relative(tmpdir(), directory), /^webnav-task-host-[\w-]+$/); await rm(directory, { recursive: true, force: true }) })
  return { ctx, directory, homeDirectory, origin: `http://127.0.0.1:${port}` }
}
async function page(t, origin, existingCookie) {
  const cookie = existingCookie ?? (await fetch(origin)).headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }), waiting = new Map()
  let epoch, next = 0
  await new Promise(resolve => ws.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'hello') { epoch = message.epoch; resolve(); return }
    const p = waiting.get(message.id); if (!p) return
    waiting.delete(message.id); clearTimeout(p.timer)
    message.ok ? p.resolve(message.result) : p.reject(Object.assign(new Error(message.error.message), message.error))
  }))
  t.after(() => ws.terminate())
  return { ws, cookie, rpc(method, params = {}, operationId = randomUUID()) {
    return new Promise((resolve, reject) => {
      const id = String(++next), timer = setTimeout(() => { waiting.delete(id); reject(new Error('RPC timeout: ' + method)) }, 30_000)
      waiting.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, operationId }))
    })
  } }
}
async function waitFor(check, timeout = 20_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)) }
  assert.fail('condition timed out')
}
const example = () => ({ sequence: 1, sampledAt: Date.now(), bootId: 'boot', hostname: 'fixture', platform: 'win32', arch: 'x64', cpuPercent: null, cpuCount: 4, uptimeSeconds: 10, memory: { total: 1000, used: 500 }, processes: [{ pid: 42, ppid: 1, startedAt: 123456, name: 'fixture', cpuPercent: null, memoryBytes: 200 }], truncated: false, capabilities: ['processes'] })

test('task-manager contract rejects injection targets, invalid metrics, duplicate identities and unbounded lists', () => {
  assert.deepEqual(parseTaskManagerTarget({ kind: 'local' }), { kind: 'local' })
  for (const value of [{ kind: 'local', home: '/tmp' }, { kind: 'ssh', serverId: 's', connectionId: 'c', command: 'arbitrary' }, { kind: 'ssh', serverId: 's\0', connectionId: 'c' }]) assert.throws(() => parseTaskManagerTarget(value))
  const snapshot = example(); assert.equal(parseTaskManagerSnapshot(snapshot).cpuPercent, null)
  assert.throws(() => parseTaskManagerSnapshot({ ...snapshot, cpuPercent: NaN }))
  assert.throws(() => parseTaskManagerSnapshot({ ...snapshot, memory: { total: 10, used: 11 } }))
  assert.throws(() => parseTaskManagerSnapshot({ ...snapshot, processes: [snapshot.processes[0], snapshot.processes[0]] }))
  assert.throws(() => parseTaskManagerSnapshot({ ...snapshot, processes: Array(10_001).fill(snapshot.processes[0]) }))
})

test('performance contract preserves unknown counters and rejects malformed per-core and device metrics', () => {
  const performance = { sampledAt: Date.now(), cpuLogical: [{ id: 0, usagePercent: null }, { id: 1, usagePercent: 91.5 }], disks: [{ id: 'disk0', name: 'Disk 0', readBytesPerSecond: null, writeBytesPerSecond: 0, activePercent: null }], gpus: [{ id: 'gpu0', name: 'GPU 0', utilizationPercent: null, memoryUsedBytes: 1024, memoryTotalBytes: null, source: 'fixture', sampledAt: 123 }], unavailable: ['gpu:initial-sample'] }
  assert.deepEqual(parseTaskManagerPerformance(performance), performance)
  assert.equal(parseTaskManagerSnapshot({ ...example(), performance }).performance.cpuLogical[1].usagePercent, 91.5)
  assert.equal(parseTaskManagerSnapshot(example()).performance, undefined, 'older snapshots remain readable')
  const integrated = { ...performance.gpus[0], memoryUsedBytes: null, sharedMemoryUsedBytes: 4096, sharedMemoryTotalBytes: 8192, utilizationScope: 'visible-clients' }
  assert.deepEqual(parseTaskManagerPerformance({ ...performance, gpus: [integrated] }).gpus[0], integrated)
  for (const bad of [
    { ...performance, cpuLogical: [{ id: 0, usagePercent: 101 }] },
    { ...performance, cpuLogical: [{ id: 0, usagePercent: 1 }, { id: 0, usagePercent: 2 }] },
    { ...performance, cpuLogical: Array.from({ length: 4097 }, (_, id) => ({ id, usagePercent: null })) },
    { ...performance, disks: [{ ...performance.disks[0], readBytesPerSecond: -1 }] },
    { ...performance, disks: [{ ...performance.disks[0], readBytesPerSecond: Infinity }] },
    { ...performance, disks: [performance.disks[0], performance.disks[0]] },
    { ...performance, disks: [{ ...performance.disks[0], totalBytes: 100, usedBytes: 200 }] },
    { ...performance, gpus: [performance.gpus[0], performance.gpus[0]] },
    { ...performance, gpus: [{ ...performance.gpus[0], utilizationPercent: NaN }] },
    { ...performance, gpus: [{ ...performance.gpus[0], memoryTotalBytes: 512 }] },
    { ...performance, gpus: [{ ...integrated, sharedMemoryUsedBytes: 8193 }] },
    { ...performance, gpus: [{ ...integrated, sharedMemoryTotalBytes: -1 }] },
    { ...performance, gpus: [{ ...integrated, utilizationScope: 'guess' }] },
  ]) assert.throws(() => parseTaskManagerPerformance(bad))
})

test('task-manager host RPC scopes monitors to pages, deduplicates starts and preserves sibling page resources', async t => {
  const f = await fixture(t), active = new Map(), closed = [], calls = []
  const fake = {
    get size() { return active.size }, get sizeRemote() { return [...active.values()].filter(s => s.target.kind === 'ssh').length },
    start(owner, target) { calls.push('start'); const value = { id: randomUUID(), target, label: 'fixture', phase: 'ready' }; active.set(value.id, value); return value },
    status(_owner, id) { return active.get(id) }, close(_owner, id) { closed.push(id); active.delete(id); return {} },
    snapshot() { return example() }, hasResources() { return !!active.size }
  }
  f.ctx.plugins.slots.get('taskManager').bridge.swap(fake)
  const a = await page(t, f.origin), b = await page(t, f.origin, a.cookie), op = randomUUID()
  const first = await a.rpc('taskManager.start', { target: { kind: 'local' } }, op)
  assert.deepEqual(await a.rpc('taskManager.start', { target: { kind: 'local' } }, op), first); assert.equal(calls.length, 1)
  assert.equal((await a.rpc('taskManager.snapshot', { monitorId: first.id })).processes[0].pid, 42)
  await assert.rejects(b.rpc('taskManager.status', { monitorId: first.id }), { code: 'NOT_FOUND' })
  assert.deepEqual(await b.rpc('operations.get', { operationId: op }), { state: 'unknown' })
  const second = await b.rpc('taskManager.start', { target: { kind: 'local' } }, op)
  assert.notEqual(second.id, first.id, 'operation cache must not transfer monitors between sibling pages')
  assert.equal(calls.length, 2)
  a.ws.close(); await waitFor(() => closed.includes(first.id)); assert.ok(active.has(second.id))
  f.ctx.plugins.manager.pending.set('builtin.taskManager', { id: 'builtin.taskManager', kind: 'waiting', reason: 'fixture busy' })
  await assert.rejects(b.rpc('taskManager.start', { target: { kind: 'local' } }), { code: 'PLUGIN_WAITING' })
  f.ctx.plugins.manager.pending.delete('builtin.taskManager')
  await b.rpc('taskManager.close', { monitorId: second.id }); assert.equal(active.size, 0)
  await assert.rejects(b.rpc('taskManager.start', { target: { kind: 'ssh', serverId: 's', connectionId: 'c', command: 'bad' } }), { code: 'INVALID_ARGUMENT' })
})

test('task-manager remote reservations share the existing eight-connection budget', () => {
  const services = { sessions: { size: 3 }, desktops: { size: 2 }, deviceSessions: { size: 1 }, taskManager: { sizeRemote: 2 } }
  const ctx = { get: name => services[name] }
  assert.equal(connectionCount(ctx), 8); assert.throws(() => requireConnectionCapacity(ctx), { code: 'BUSY' })
  services.taskManager.sizeRemote = 1; assert.doesNotThrow(() => requireConnectionCapacity(ctx))
})

test('native task-manager installs in isolated user HOME, reads real processes, deduplicates a dedicated child termination and releases collectors', { timeout: 60_000 }, async t => {
  try { await stat(join(defaultPackageDirectory, 'manifest.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('Run pnpm collector:build to enable native integration'); return }
  const f = await fixture(t), a = await page(t, f.origin)
  const state = await a.rpc('taskManager.start', { target: { kind: 'local' } })
  const missing = await waitFor(async () => { const s = await a.rpc('taskManager.status', { monitorId: state.id }); if (s.phase === 'error') assert.fail(s.message); return s.phase === 'not-installed' && s })
  assert.ok(missing.installPath.startsWith(join(f.homeDirectory, '.webnav', 'tools', 'task-manager')))
  const installed = await a.rpc('taskManager.install', { monitorId: state.id }); assert.equal(installed.phase, 'installing')
  await waitFor(async () => { const s = await a.rpc('taskManager.status', { monitorId: state.id }); if (s.phase === 'error') assert.fail(s.message); return s.phase === 'ready' }, 45_000)
  const marker = JSON.parse(await readFile(join(missing.installPath, 'install.json'), 'utf8')); assert.equal(marker.protocol, 1)
  const stamp = (await stat(join(missing.installPath, 'install.json'))).mtimeMs
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); await once(child, 'spawn')
  try {
  const processRow = await waitFor(async () => (await a.rpc('taskManager.snapshot', { monitorId: state.id })).processes.find(p => p.pid === child.pid))
  assert.ok(processRow.startedAt > 0)
  const metrics = await a.rpc('taskManager.snapshot', { monitorId: state.id })
  assert.ok(metrics.performance, 'installed collector must provide enhanced performance metrics')
  assert.ok(metrics.performance.cpuLogical.length > 0)
  assert.ok(metrics.performance.cpuLogical.length <= metrics.cpuCount)
  assert.ok(Array.isArray(metrics.performance.disks)); assert.ok(Array.isArray(metrics.performance.gpus))
  assert.deepEqual(parseTaskManagerSnapshot(metrics), metrics, 'native per-core and device fields satisfy the public boundary')
  assert.equal(metrics.processes.find(p => p.pid === child.pid)?.startedAt, processRow.startedAt, 'the dedicated live child keeps its creation identity between samples')
  const detail = await a.rpc('taskManager.details', { monitorId: state.id, pid: processRow.pid, startedAt: processRow.startedAt }).catch(error => { error.message = 'Dedicated child details: ' + error.message; throw error }); assert.equal(detail.process.pid, child.pid)
  const command = await a.rpc('taskManager.commandLine', { monitorId: state.id, pid: processRow.pid, startedAt: processRow.startedAt })
  assert.match(command.commandLine, /setInterval/); assert.equal(command.truncated, false)
  await assert.rejects(a.rpc('taskManager.commandLine', { monitorId: state.id, pid: processRow.pid, startedAt: processRow.startedAt + 1 }))
  const otherPage = await page(t, f.origin)
  await assert.rejects(otherPage.rpc('taskManager.commandLine', { monitorId: state.id, pid: processRow.pid, startedAt: processRow.startedAt }))
  assert.ok(metrics.processes.every(p => !Object.hasOwn(p, 'commandLine')), 'snapshot cannot contain command lines')
  await assert.rejects(a.rpc('taskManager.prepareAction', { monitorId: state.id, pid: process.pid, startedAt: 1, force: true }))
  const plan = await a.rpc('taskManager.prepareAction', { monitorId: state.id, pid: processRow.pid, startedAt: processRow.startedAt, force: true })
  const op = randomUUID(), result = await a.rpc('taskManager.applyAction', { monitorId: state.id, planId: plan.id }, op).catch(error => { error.message = 'Dedicated child termination: ' + error.message; throw error })
  assert.ok(['exited', 'pending'].includes(result.status)); assert.deepEqual(await a.rpc('taskManager.applyAction', { monitorId: state.id, planId: plan.id }, op), result)
  await waitFor(() => child.exitCode !== null || child.signalCode !== null)
  await a.rpc('taskManager.close', { monitorId: state.id }); await waitFor(() => !f.ctx.taskManager.hasResources())
  const again = await a.rpc('taskManager.start', { target: { kind: 'local' } })
  await waitFor(async () => { const s = await a.rpc('taskManager.status', { monitorId: again.id }); if (s.phase === 'error') assert.fail(s.message); return s.phase === 'ready' })
  assert.equal((await stat(join(missing.installPath, 'install.json'))).mtimeMs, stamp, 'verified installation reused without upload')
  a.ws.close(); await waitFor(() => !f.ctx.taskManager.hasResources())
  } finally {
    // Stop the exact child handle before app teardown, including assertion failures.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close'); child.kill(); await exited
    }
    a.ws.terminate()
  }
})
