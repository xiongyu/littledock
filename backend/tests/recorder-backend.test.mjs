import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from 'cordis'
import ssh2 from 'ssh2'
import { TaskManagerService } from '../src/plugins/task-manager/coordinator.ts'
import { COLLECTOR_VERSION } from '../src/plugins/task-manager/packages.ts'
import { launchCommand } from '../src/plugins/task-manager/remote.ts'
import { writableSftp, seedRemoteFiles } from './writable-sftp-fixture.mjs'

const defaults = { enabled: false, intervalSeconds: 5, retentionDays: 7, maxMiB: 256 }
async function waitFor(check, timeout = 10_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)) } assert.fail('condition timed out') }

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'webnav-recorder-backend-')), packages = join(root, 'packages'), file = 'linux-x64/webnav-collector', bytes = Buffer.alloc(8192, 17)
  await mkdir(join(packages, 'linux-x64'), { recursive: true }); await writeFile(join(packages, file), bytes)
  await writeFile(join(packages, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: COLLECTOR_VERSION, protocol: 1, artifacts: [{ platform: 'linux', arch: 'x64', file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }] }))
  const home = await seedRemoteFiles(root), recordingDirectory = join(home, '.webnav', 'tools', 'task-manager', 'recording-v1'), configFile = join(recordingDirectory, 'fixture-config.json')
  const hostkeys = new Map(), peers = new Set(), requests = [], watches = new Set(), keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  let locked = false, authorized = true, draining = false, writes = 0, sequence = 0
  let state = { ...defaults, revision: 0, state: 'disabled', running: false, directory: '/home/fixture/.webnav/tools/task-manager/recording-v1', storedBytes: 0 }
  const liveRow = { pid: 42, ppid: 1, startedAt: 1000, name: 'current-process', cpuPercent: 0, memoryBytes: 100 }
  const historical = { id: 'prior-instance:1', sequence: 1, sampledAt: 100_000, bootId: 'previous-boot', cpuPercent: 99, cpuCount: 2, memory: { total: 1000, used: 950 }, processCount: 30, disk: null, gpu: null }
  const hello = { version: COLLECTOR_VERSION, protocol: 1, platform: 'linux', arch: 'x64', hostname: 'fixture', username: 'fixture', home: '/home/fixture', bootId: 'current-boot', capabilities: ['processes', 'terminate-force', ...(options.oldCapabilities ? [] : ['recording', 'history'])] }
  const server = new ssh2.Server({ hostKeys: [keys.privateKey] }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer)); peer.on('authentication', request => request.accept())
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept(); writableSftp(session, root); session.on('pty', () => assert.fail('recorder bridge must not allocate PTY'))
      session.on('exec', (accept, _reject, info) => {
        const channel = accept(); channel.on('error', () => {})
        if (info.command.includes('uname -s')) { channel.write('WEBNAV-TASK-MANAGER\nLinux\nx86_64\nfixture\n/home/fixture\nfixture\n'); channel.exit(0); channel.end(); return }
        assert.equal(info.command, launchCommand({ os: 'linux' }, `/home/fixture/.webnav/tools/task-manager/${COLLECTOR_VERSION}/linux-x64/webnav-collector`))
        const send = async request => {
          requests.push(request)
          let result = {}, error
          if (request.method === 'hello') result = hello
          if (request.method === 'snapshot') result = { sequence: ++sequence, sampledAt: Date.now(), bootId: hello.bootId, hostname: 'fixture', platform: 'linux', arch: 'x64', cpuPercent: 0, cpuCount: 2, uptimeSeconds: 100, memory: { total: 1000, used: 500 }, processes: [liveRow], truncated: false, capabilities: hello.capabilities }
          if (request.method === 'recording.status') { if (options.delayStatus) await options.delayStatus; result = { ...state, ...(options.statusPatch ?? {}) } }
          if (request.method === 'recording.configure') {
            const { expectedRevision, operationId, ...config } = request.params
            assert.equal(typeof operationId, 'string')
            if (expectedRevision !== state.revision) error = { code: 'REVISION_CONFLICT', message: 'private native diagnostic' }
            else {
              writes++; state = { ...state, ...config, revision: state.revision + 1, state: config.enabled ? 'recording' : 'disabled', running: config.enabled, ...(config.enabled ? { instanceId: 'fixture-instance' } : {}) }
              await mkdir(recordingDirectory, { recursive: true }); await writeFile(configFile, JSON.stringify(state))
              if (options.loseConfigure) { channel.close(); return }
              result = state
            }
          }
          if (request.method === 'history.query') result = { from: request.params.from, to: request.params.to, points: [historical], totalSamples: 1, truncated: false, gaps: [], ...(options.pagePatch ?? {}) }
          if (request.method === 'history.point') result = { ...historical, intervalSeconds: 5, processes: [{ ...liveRow, pid: 55, startedAt: 500, name: 'exited-process', cpuPercent: 99 }], truncated: false, ...(options.pointPatch ?? {}) }
          if (!channel.destroyed) channel.write(JSON.stringify({ v: 1, id: request.id, ok: !error, ...(error ? { error } : { result }) }) + '\n')
        }
        let buffer = ''
        channel.on('data', data => { buffer += data.toString(); let end; while ((end = buffer.indexOf('\n')) >= 0) { const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); void send(request).catch(error => { assert.fail(error); channel.close() }) } })
        channel.on('end', () => { channel.exit(0); channel.end() })
      })
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const ctx = new Context(), connection = { id: 'ssh', type: 'ssh', username: 'fixture', port: server.address().port }, target = { kind: 'ssh', serverId: 'server', connectionId: 'ssh' }
  ctx.set('storage', { connection(serverId, connectionId) { assert.equal(serverId, 'server'); assert.equal(connectionId, 'ssh'); return { server: { host: '127.0.0.1', name: 'Recorder fixture' }, connection } }, db: { prepare() { return { get: key => hostkeys.has(key) ? { fingerprint: hostkeys.get(key) } : undefined, run: (key, value) => hostkeys.set(key, value) } } } })
  ctx.set('auth', { authorized: owner => authorized && owner === 'owner' })
  ctx.set('credentials', { requireUnlocked() { if (locked) throw Object.assign(new Error('locked'), { code: 'LOCKED' }) }, resolve: async () => ({ password: 'isolated-fixture-only' }), subscribe(callback) { watches.add(callback); return () => watches.delete(callback) } })
  ctx.set('maintenance', { requireAvailable() { if (draining) throw Object.assign(new Error('maintenance'), { code: 'UPDATE_WAITING' }) } })
  ctx.plugin(TaskManagerService, { execution: 'dedicated', directory: root, packageDirectory: packages }); await ctx.start()
  t.after(async () => { await ctx.stop(); for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); assert.match(relative(tmpdir(), root), /^webnav-recorder-backend-[\w-]+$/); await rm(root, { recursive: true, force: true }) })
  const connect = async () => {
    const state = await ctx.taskManager.start('owner', target)
    await waitFor(async () => { const status = (await ctx.taskManager.status('owner', state.id)); if (status.phase === 'host-key') await ctx.taskManager.hostKeyDecision('owner', state.id, true); if (status.phase === 'not-installed') await ctx.taskManager.install('owner', state.id); if (status.phase === 'error') assert.fail(status.message); return status.phase === 'ready' })
    return state.id
  }
  return { ctx, service: ctx.taskManager, connect, requests, configFile, target, state: () => state, writes: () => writes, draining: value => { draining = value }, revoke() { authorized = false }, lock() { locked = true; for (const callback of watches) callback({ unlocked: false }) } }
}

test('recorder settings persist across isolated SSH close/reconnect and only explicit disable stops recording', async t => {
  const f = await fixture(t), id = await f.connect(), config = { ...defaults, enabled: true }, operationId = randomUUID()
  assert.equal((await f.service.recordingStatus('owner', id)).state, 'disabled')
  const input = { config, expectedRevision: 0, operationId }
  const [first, duplicate] = await Promise.all([f.service.configureRecording('owner', id, input), f.service.configureRecording('owner', id, input)])
  assert.deepEqual(first, duplicate); assert.equal(f.writes(), 1); assert.equal(first.running, true)
  await f.service.close('owner', id); await waitFor(async () => !f.service.hasResources())
  assert.equal(f.state().running, true); assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).enabled, true)
  assert.equal(f.requests.some(request => request.method === 'stop'), false)
  const second = await f.connect(), status = await f.service.recordingStatus('owner', second)
  assert.equal(status.revision, 1); assert.equal(status.running, true); assert.equal(f.writes(), 1)
  const disabled = await f.service.configureRecording('owner', second, { config: defaults, expectedRevision: status.revision, operationId: randomUUID() })
  assert.equal(disabled.running, false); assert.equal(f.writes(), 2)
})

test('recorder validates config/history boundaries, keeps prior-boot processes read-only, and honors maintenance', async t => {
  const f = await fixture(t), id = await f.connect(), operationId = randomUUID(), config = { ...defaults, enabled: true }
  await assert.rejects(f.service.configureRecording('owner', id, { config: { ...config, command: 'bad' }, expectedRevision: 0, operationId }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(f.service.configureRecording('owner', id, { config: { ...config, intervalSeconds: 3 }, expectedRevision: 0, operationId }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(f.service.queryHistory('owner', id, { from: 0, to: 100_001, maxPoints: 301 }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(f.service.recordingStatus('other', id), { code: 'UNAUTHORIZED' })
  f.draining(true); await assert.rejects(f.service.configureRecording('owner', id, { config, expectedRevision: 0, operationId }), { code: 'UPDATE_WAITING' })
  assert.equal((await f.service.recordingStatus('owner', id)).revision, 0); f.draining(false)
  await f.service.configureRecording('owner', id, { config, expectedRevision: 0, operationId })
  await assert.rejects(f.service.configureRecording('owner', id, { config: defaults, expectedRevision: 0, operationId }), { code: 'OPERATION_CONFLICT' })
  await assert.rejects(f.service.configureRecording('owner', id, { config: defaults, expectedRevision: 0, operationId: randomUUID() }), { code: 'REVISION_CONFLICT', message: '持续记录设置已经变化，请刷新实际状态后再保存。' })
  const page = await f.service.queryHistory('owner', id, { from: 0, to: 100_001 }), point = await f.service.historyPoint('owner', id, page.points[0].id)
  assert.equal(point.bootId, 'previous-boot'); assert.equal(point.processes[0].name, 'exited-process')
  await assert.rejects(async () => await f.service.prepareAction('owner', id, { pid: 55, startedAt: 500, force: true }), { code: 'PROCESS_CHANGED' })
  assert.equal((await f.service.snapshot('owner', id)).bootId, 'current-boot')
})

test('lost recorder mutation replies remain unknown without replay and reconnect reads the committed state', async t => {
  const f = await fixture(t, { loseConfigure: true }), id = await f.connect(), input = { config: { ...defaults, enabled: true }, expectedRevision: 0, operationId: randomUUID() }
  await assert.rejects(f.service.configureRecording('owner', id, input), { code: 'RECORDING_UNKNOWN' }); assert.equal(f.writes(), 1)
  await assert.rejects(f.service.configureRecording('owner', id, input)); assert.equal(f.writes(), 1)
  await waitFor(async () => !f.service.hasResources())
  const fresh = await f.connect(); assert.equal((await f.service.recordingStatus('owner', fresh)).enabled, true); assert.equal(f.writes(), 1)
})

test('recorder old capabilities, mismatched history point identity and malformed status never produce trusted data', async t => {
  const old = await fixture(t, { oldCapabilities: true }), oldId = await old.connect()
  await assert.rejects(old.service.recordingStatus('owner', oldId), { code: 'UNSUPPORTED' }); assert.equal(old.requests.some(r => r.method === 'recording.status'), false)
  const wrong = await fixture(t, { pointPatch: { id: 'different-target:1' } }), wrongId = await wrong.connect()
  await assert.rejects(wrong.service.historyPoint('owner', wrongId, 'prior-instance:1'), { code: 'COLLECTOR_PROTOCOL' }); await waitFor(async () => !wrong.service.hasResources())
  const bad = await fixture(t, { statusPatch: { storedBytes: -1 } }), badId = await bad.connect()
  await assert.rejects(bad.service.recordingStatus('owner', badId), { code: 'COLLECTOR_PROTOCOL' }); await waitFor(async () => !bad.service.hasResources())
})

test('late recorder reads recheck authorization and locking releases only the foreground bridge', async t => {
  let release; const delayStatus = new Promise(resolve => { release = resolve }), options = { delayStatus }, f = await fixture(t, options), id = await f.connect()
  const pending = f.service.recordingStatus('owner', id)
  await waitFor(async () => f.requests.some(r => r.method === 'recording.status')); f.revoke(); release()
  await assert.rejects(pending, { code: 'UNAUTHORIZED' })
  const locked = await fixture(t), lockedId = await locked.connect()
  await locked.service.configureRecording('owner', lockedId, { config: { ...defaults, enabled: true }, expectedRevision: 0, operationId: randomUUID() })
  locked.lock(); await waitFor(async () => !locked.service.hasResources()); assert.equal(locked.state().running, true); assert.equal(locked.writes(), 1)
})
