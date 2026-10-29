import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/app.ts'
import { CollectorPeer } from '../src/plugins/task-manager/protocol.ts'
import { COLLECTOR_VERSION, defaultPackageDirectory, packageName } from '../src/plugins/task-manager/packages.ts'
import { parseTaskManagerRecordingStatus, parseTaskManagerHistoryPage, parseTaskManagerHistoryPoint } from '@webnav/shared'

const settings = { enabled: true, intervalSeconds: 1, retentionDays: 7, maxMiB: 64 }
async function waitFor(check, timeout = 25_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) } assert.fail('condition timed out') }
function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true } catch { return false } }
async function page(origin, pages) {
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0], ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } }), waiting = new Map()
  pages.add(ws); let epoch, serial = 0
  await new Promise((resolve, reject) => { ws.once('error', reject); ws.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'hello') { epoch = message.epoch; resolve(); return } const pending = waiting.get(message.id); if (!pending) return; waiting.delete(message.id); clearTimeout(pending.timer); message.ok ? pending.resolve(message.result) : pending.reject(Object.assign(new Error(message.error.message), message.error)) }) })
  ws.on('close', () => { pages.delete(ws); for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('test page closed')) } waiting.clear() })
  return { ws, rpc(method, params = {}, operationId = randomUUID()) { return new Promise((resolve, reject) => { const id = String(++serial), timer = setTimeout(() => { waiting.delete(id); reject(new Error('RPC timeout: ' + method)) }, 30_000); waiting.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, operationId })) }) } }
}
async function monitor(view) {
  const state = await view.rpc('taskManager.start', { target: { kind: 'local' } })
  return waitFor(async () => { const current = await view.rpc('taskManager.status', { monitorId: state.id }); if (current.phase === 'error') assert.fail(current.message); if (current.phase === 'not-installed') await view.rpc('taskManager.install', { monitorId: state.id }); return current.phase === 'ready' && current })
}

// Last-resort test cleanup still uses the verified foreground collector's fixed
// protocol, never PID termination or direct mutation of recorder configuration.
async function stopThroughForeground(binary, homeDirectory, expectedDirectory) {
  const child = spawn(binary, [], { windowsHide: true, stdio: 'pipe', env: { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory } })
  const exited = once(child, 'close'), peer = new CollectorPeer({ input: child.stdin, output: child.stdout, stderr: child.stderr, close: () => child.stdin.end() })
  try {
    const hello = await peer.request('hello'); assert.equal(resolve(hello.home), resolve(homeDirectory))
    let status = parseTaskManagerRecordingStatus(await peer.request('recording.status'))
    assert.equal(resolve(status.directory), resolve(expectedDirectory))
    if (status.enabled) status = parseTaskManagerRecordingStatus(await peer.request('recording.configure', { enabled: false, intervalSeconds: status.intervalSeconds, retentionDays: status.retentionDays, maxMiB: status.maxMiB, expectedRevision: status.revision, operationId: randomUUID() }))
    await waitFor(async () => { const current = parseTaskManagerRecordingStatus(await peer.request('recording.status')); return !current.enabled && !current.running }, 15_000)
  } finally {
    peer.close()
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 3000)
    try { await exited } finally { clearTimeout(timer) }
  }
}

test('native recorder survives all viewer disconnects, returns prior samples on a new page, and stops explicitly', { timeout: 90_000 }, async t => {
  let manifest
  try { manifest = JSON.parse(await readFile(join(defaultPackageDirectory, 'manifest.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (manifest?.version !== COLLECTOR_VERSION || !manifest.artifacts.some(item => item.platform === process.platform && item.arch === (process.arch === 'x64' ? 'x64' : process.arch))) { t.skip('Build the matching 0.3 collector package before native recording integration'); return }
  const temporaryRoot = await realpath(tmpdir()), directory = await mkdtemp(join(temporaryRoot, 'webnav-recorder-native-')), homeDirectory = join(directory, '独立 user home'), frontendRoot = join(directory, 'ui'), recordingDirectory = join(homeDirectory, '.webnav', 'tools', 'task-manager', 'recording-v1')
  await mkdir(homeDirectory); await mkdir(frontendRoot); await writeFile(join(frontendRoot, 'index.html'), '<html>isolated native recording test</html>')
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const ctx = await createApp({ directory, frontendRoot, port, taskManagerConfig: { homeDirectory } }), origin = `http://127.0.0.1:${port}`, pages = new Set()
  let binary, mayBeRecording = false, daemonPid, cleanupError
  try {
    const first = await page(origin, pages), state = await monitor(first), monitorId = state.id
    binary = join(state.installPath, packageName(process.platform))
    assert.ok(resolve(binary).startsWith(resolve(homeDirectory) + '\\') || resolve(binary).startsWith(resolve(homeDirectory) + '/'))
    const initial = parseTaskManagerRecordingStatus(await first.rpc('taskManager.recordingStatus', { monitorId }))
    // This assertion precedes the first persistent side effect.
    assert.equal(resolve(initial.directory), resolve(recordingDirectory)); assert.equal(initial.enabled, false)
    const from = Date.now(); mayBeRecording = true
    await first.rpc('taskManager.configureRecording', { monitorId, config: settings, expectedRevision: initial.revision })
    await waitFor(async () => { const status = await first.rpc('taskManager.recordingStatus', { monitorId }); return status.running && status.state === 'recording' && status.lastSampleAt })
    daemonPid = JSON.parse(await readFile(join(recordingDirectory, 'status.json'), 'utf8')).pid
    assert.ok(alive(daemonPid))
    first.ws.close(); await waitFor(() => pages.size === 0 && !ctx.taskManager.hasResources())
    const detachedAt = Date.now(), observed = new Set()
    // Observe only the isolated target's metadata while no viewing bridge exists.
    await waitFor(async () => { const runtime = JSON.parse(await readFile(join(recordingDirectory, 'status.json'), 'utf8')); if (runtime.lastSampleAt > detachedAt) observed.add(runtime.lastSampleAt); return observed.size >= 3 })
    assert.equal(ctx.taskManager.size, 0); assert.ok(alive(daemonPid))
    const to = Date.now(), second = await page(origin, pages), current = await monitor(second), secondId = current.id
    const status = parseTaskManagerRecordingStatus(await second.rpc('taskManager.recordingStatus', { monitorId: secondId }))
    assert.equal(status.enabled, true); assert.equal(status.running, true); assert.ok(status.storedBytes > 0)
    const history = parseTaskManagerHistoryPage(await second.rpc('taskManager.queryHistory', { monitorId: secondId, query: { from, to, maxPoints: 300 } }))
    assert.ok(history.points.filter(point => point.sampledAt > detachedAt).length >= 3)
    assert.ok(history.points.every(point => point.sampledAt <= to))
    const recorded = history.points.at(-1), point = parseTaskManagerHistoryPoint(await second.rpc('taskManager.historyPoint', { monitorId: secondId, id: recorded.id })), live = await second.rpc('taskManager.snapshot', { monitorId: secondId })
    assert.equal(point.id, recorded.id); assert.equal(point.bootId, live.bootId); assert.ok(point.processes.length > 0 && point.processes.length <= 40); assert.ok(point.processes.every(row => row.startedAt > 0))
    await second.rpc('taskManager.configureRecording', { monitorId: secondId, config: { ...settings, enabled: false }, expectedRevision: status.revision })
    await waitFor(async () => { const current = await second.rpc('taskManager.recordingStatus', { monitorId: secondId }); return !current.enabled && !current.running })
    await waitFor(() => !alive(daemonPid), 10_000); mayBeRecording = false
    assert.equal((await second.rpc('taskManager.queryHistory', { monitorId: secondId, query: { from, to, maxPoints: 300 } })).points.length, history.points.length)
    await second.rpc('taskManager.close', { monitorId: secondId })
  } finally {
    if (mayBeRecording && binary) {
      try {
        if (!daemonPid) { const runtime = JSON.parse(await readFile(join(recordingDirectory, 'status.json'), 'utf8').catch(() => '{}')); if (Number.isInteger(runtime.pid) && runtime.pid > 0) daemonPid = runtime.pid }
        await stopThroughForeground(binary, homeDirectory, recordingDirectory)
        if (daemonPid) await waitFor(() => !alive(daemonPid), 10_000)
        mayBeRecording = false
      }
      catch (error) { cleanupError = error }
    }
    for (const ws of pages) ws.terminate()
    await ctx.stop()
    // Retain evidence if cleanup could not prove the recorder stopped.
    if (!mayBeRecording) { assert.match(relative(temporaryRoot, directory), /^webnav-recorder-native-[\w-]+$/); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    if (cleanupError) throw cleanupError
  }
})
