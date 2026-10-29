import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ssh2 from 'ssh2'
import { Context } from 'cordis'
import { TaskManagerService } from '../src/plugins/task-manager/coordinator.ts'
import { CollectorPeer } from '../src/plugins/task-manager/protocol.ts'
import { COLLECTOR_VERSION, collectorPackage, marker, validMarker } from '../src/plugins/task-manager/packages.ts'
import { detectPlatform, installDirectory, launchCommand, remoteHome, shQuote, psQuote } from '../src/plugins/task-manager/remote.ts'
import { installedLocal, installLocal, localDirectory } from '../src/plugins/task-manager/local.ts'
import { writableSftp, seedRemoteFiles } from './writable-sftp-fixture.mjs'
import { spawnWithSshStdin } from './task-manager-windows-pipe-fixture.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'webnav-task-backend-')); t.after(async () => { assert.match(relative(tmpdir(), root), /^webnav-task-backend-[\w-]+$/); await rm(root, { recursive: true, force: true }) }); return root }
async function packageFixture(t, platform = 'linux', arch = 'x64') {
  const root = await temporary(t), directory = join(root, 'packages'), file = `${platform}-${arch}/webnav-collector${platform === 'win32' ? '.exe' : ''}`, bytes = Buffer.alloc(96 * 1024 + 177, 79)
  await mkdir(join(directory, `${platform}-${arch}`), { recursive: true }); await writeFile(join(directory, file), bytes)
  const manifest = { schemaVersion: 1, version: COLLECTOR_VERSION, protocol: 1, artifacts: [{ platform, arch, file, sha256: digest(bytes), size: bytes.length }] }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { root, directory, manifest, bytes, pkg: await collectorPackage(directory, platform, arch) }
}
async function waitFor(check, timeout = 12_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }; assert.fail('condition timed out') }
function protocolFixture() {
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough(); let closed = 0
  const peer = new CollectorPeer({ input, output, stderr, close: () => { closed++; input.destroy(); output.destroy(); stderr.destroy() } })
  return { peer, input, output, stderr, closed: () => closed }
}

test('collector protocol preserves fragmented UTF-8, bounds lines and never retries timed-out requests', async () => {
  const f = protocolFixture(); let requests = 0
  f.input.on('data', bytes => { requests++; const request = JSON.parse(bytes); const response = Buffer.from(JSON.stringify({ v: 1, id: request.id, ok: true, result: { text: '中文进程' } }) + '\n'); for (const byte of response) f.output.write(Buffer.from([byte])) })
  assert.deepEqual(await f.peer.request('hello'), { text: '中文进程' }); assert.equal(requests, 1); f.peer.close(); f.peer.close(); assert.equal(f.closed(), 1)
  const slow = protocolFixture(); slow.input.on('data', () => requests++)
  await assert.rejects(slow.peer.request('terminate', { pid: 3 }, 15), { code: 'COLLECTOR_TIMEOUT' }); assert.equal(requests, 2); assert.equal(slow.closed(), 1)
  const large = protocolFixture(), pending = large.peer.request('snapshot')
  large.output.write(Buffer.alloc(2 * 1024 * 1024 + 1, 32)); await assert.rejects(pending, { code: 'COLLECTOR_OUTPUT_LIMIT' }); assert.equal(large.closed(), 1)
})

test('collector protocol rejects malformed errors, unknown responses and excessive in-flight requests', async () => {
  const f = protocolFixture(); f.input.once('data', bytes => f.output.write(JSON.stringify({ v: 1, id: JSON.parse(bytes).id, ok: false, error: null }) + '\n'))
  await assert.rejects(f.peer.request('details'), { code: 'COLLECTOR_PROTOCOL' })
  const unknown = protocolFixture(), pending = unknown.peer.request('snapshot'); unknown.output.write('{"v":1,"id":"other","ok":true,"result":{}}\n'); await assert.rejects(pending, { code: 'COLLECTOR_PROTOCOL' })
  const busy = protocolFixture(), active = Array.from({ length: 4 }, () => busy.peer.request('ping').catch(error => error.code)); await assert.rejects(busy.peer.request('ping'), { code: 'BUSY' }); busy.peer.close(); assert.deepEqual(await Promise.all(active), Array(4).fill('CANCELLED'))
  const localized = protocolFixture(); localized.input.once('data', bytes => localized.output.write(JSON.stringify({ v: 1, id: JSON.parse(bytes).id, ok: false, error: { code: 'PERMISSION_DENIED', message: 'raw remote diagnostic must stay private' } }) + '\n'))
  await assert.rejects(localized.peer.request('terminate'), { code: 'PERMISSION_DENIED', message: '当前目标用户没有执行此进程操作的权限。' }); localized.peer.close()
})

test('fixed package manifest, hash, path and size are checked before installation; local user path is explicit', async t => {
  const f = await packageFixture(t), home = join(f.root, "用户 home ' quote $()")
  await mkdir(home)
  assert.equal(await localDirectory(home, f.pkg, false), undefined)
  assert.equal(await lstat(join(home, '.webnav')).catch(() => undefined), undefined, 'checking does not create directories')
  const destination = await localDirectory(home, f.pkg, true); assert.ok(destination.startsWith(join(home, '.webnav', 'tools', 'task-manager')))
  await installLocal(destination, f.pkg, new AbortController().signal); assert.equal(await installedLocal(destination, f.pkg), true)
  assert.equal(validMarker(marker(f.pkg), f.pkg), true)
  await writeFile(join(destination, 'webnav-collector'), 'corrupt'); assert.equal(await installedLocal(destination, f.pkg), false)
  await writeFile(join(f.directory, f.pkg.file), 'corrupt'); await assert.rejects(collectorPackage(f.directory, 'linux', 'x64'), { code: 'PACKAGE_INVALID' })
  f.manifest.artifacts[0].file = '../escape'; await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest)); await assert.rejects(collectorPackage(f.directory, 'linux', 'x64'), { code: 'PACKAGE_INVALID' })
  await assert.rejects(collectorPackage(join(f.root, 'absent'), 'linux', 'x64'), { code: 'PACKAGE_UNAVAILABLE' })
})

test('Windows/macOS probes, home paths and launch quoting use literal paths and raw stdio', async () => {
  const windowsHome = "C:\\Users\\中文 a'b $()"
  assert.equal(remoteHome(windowsHome, true), "C:/Users/中文 a'b $()")
  for (const bad of ['C:/', '../home', '/C:/Users/../outside', 'C:/Users/u\ncommand']) assert.throws(() => remoteHome(bad, true))
  const windows = launchCommand({ os: 'win32' }, "/C:/Users/中文 a'b $()/.webnav/tools/task-manager/0.1.0/win32-x64/webnav-collector.exe")
  const script = Buffer.from(windows.split(' ').at(-1), 'base64').toString('utf16le')
  assert.ok(script.includes("C:\\Users\\中文 a''b $()")); assert.match(script, /StandardInput\.BaseStream\.Flush\(\)/); assert.match(script, /RedirectStandardOutput=\$true/)
  assert.equal(shQuote("/a'b$()"), "'/a'\\''b$()'"); assert.equal(psQuote("a'b"), "'a''b'")
  assert.equal(launchCommand({ os: 'darwin' }, "/Users/a'b/collector"), "exec '/Users/a'\\''b/collector'")
  function probe(system) { return { exec(command, callback) { const channel = new EventEmitter(); channel.close = () => {}; channel.stderr = new PassThrough(); callback(null, channel); setImmediate(() => { if (command.includes('uname -s')) { if (system === 'darwin') { channel.emit('data', Buffer.from("WEBNAV-TASK-MANAGER\nDarwin\narm64\nmac-fixture\n/Users/中文 a'b\nfixture\n")); channel.emit('close', 0) } else channel.emit('close', 1) } else { channel.emit('data', Buffer.from(JSON.stringify({ os: 'win32', arch: 'AMD64', hostname: 'win-fixture', home: windowsHome, username: 'fixture' }))); channel.emit('close', 0) } }) } } }
  assert.equal((await detectPlatform(probe('darwin'), new AbortController().signal)).arch, 'arm64')
  const win = await detectPlatform(probe('win32'), new AbortController().signal); assert.equal(win.home, "C:/Users/中文 a'b $()"); assert.equal(win.os, 'win32')
  const linked = { stat: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }) }
  await assert.rejects(installDirectory(linked, '/home/test', { version: '0.1.0', platform: 'linux', arch: 'x64' }, true), { code: 'UNSAFE_PATH' })
})

test('native Windows collector survives PowerShell SSH launcher raw stdio and quoted user path', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t), home = join(root, "中文 a'b $()"), binary = join(home, 'webnav-collector.exe')
  await mkdir(home); await copyFile(new URL('../native/task-manager/package/win32-x64/webnav-collector.exe', import.meta.url), binary)
  const command = launchCommand({ os: 'win32' }, binary), args = command.split(' '), child = spawn(args.shift(), args, { stdio: 'pipe', windowsHide: true })
  let diagnostic = ''; child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2048) })
  const peer = new CollectorPeer({ input: child.stdin, output: child.stdout, stderr: child.stderr, close: () => child.stdin.end() })
  t.after(() => { peer.close(); if (child.exitCode === null && child.signalCode === null) child.kill() })
  try {
    const hello = await peer.request('hello'); assert.equal(hello.platform, 'win32'); assert.equal(hello.version, COLLECTOR_VERSION)
    const snapshot = await peer.request('snapshot'); assert.ok(snapshot.processes.some(process => process.pid === child.pid)); assert.ok(snapshot.memory.total > 0)
    const exited = once(child, 'close'); peer.close(); await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('PowerShell launcher did not exit')), 5000); timer.unref() })]); assert.equal(child.exitCode, 0)
  } catch (error) { throw new Error(error.message + '\n' + diagnostic) }
})

test('Windows SSH overlapped stdin handles consecutive requests, idle reads and EOF', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await temporary(t), home = join(root, "用户 a'b $()"), binary = join(home, 'webnav-collector.exe')
  await mkdir(home); await copyFile(new URL('../native/task-manager/package/win32-x64/webnav-collector.exe', import.meta.url), binary)
  const child = spawnWithSshStdin(launchCommand({ os: 'win32' }, binary), { ...process.env, HOME: home, USERPROFILE: home })
  let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2048) })
  const exited = once(child, 'close'), peer = new CollectorPeer({ input: child.stdin, output: child.stdout, stderr: child.stderr, close: () => child.stdin.end() })
  t.after(async () => { peer.close(); await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 6500); timer.unref() })]) })
  try {
    const hello = await peer.request('hello', {}, 5000); assert.equal(hello.platform, 'win32'); assert.equal(hello.home, home)
    // Let the next read begin before sending more bytes. Pre-buffered input can
    // hide the ConsoleStream/OVERLAPPED incompatibility.
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.ok((await peer.request('ping', {}, 2000)).time > 0)
    }
    assert.ok((await peer.request('snapshot', {}, 5000)).memory.total > 0)
    peer.close(); await exited; assert.equal(child.exitCode, 0)
  } catch (error) { throw new Error(error.message + '\n' + diagnostic) }
})

async function sshFixture(t, options = {}) {
  const f = await packageFixture(t), home = await seedRemoteFiles(f.root), keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const peers = new Set(), commands = [], watchers = new Set(), hostkeys = new Map(); let locked = false, launched = 0, terminated = 0, sequence = 0
  const row = { pid: 424242, ppid: 1, startedAt: 123456, name: 'fixture-process', cpuPercent: 0, memoryBytes: 100, username: 'fixture' }
  const hello = { version: COLLECTOR_VERSION, protocol: 1, platform: 'linux', arch: 'x64', hostname: 'fixture', username: 'fixture', home: '/home/fixture', bootId: 'fixture-boot', capabilities: ['processes', 'terminate-force', 'terminate-graceful', 'command-line'] }
  const snapshot = () => ({ sequence: ++sequence, sampledAt: Date.now(), bootId: options.badBoot ? 'wrong' : hello.bootId, hostname: 'fixture', platform: 'linux', arch: 'x64', cpuPercent: 0, cpuCount: 2, uptimeSeconds: 100, memory: { total: 1000, used: 500 }, processes: [row], truncated: false, capabilities: hello.capabilities, ...(options.badPerformance ? { performance: { sampledAt: Date.now(), cpuLogical: [{ id: 0, usagePercent: 101 }], disks: [], gpus: [], unavailable: [] } } : {}) })
  const server = new ssh2.Server({ hostKeys: [keys.privateKey] }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer)); peer.on('authentication', request => request.accept())
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept(); writableSftp(session, f.root, { maxWriteSize: 32 * 1024 }); session.on('pty', () => assert.fail('task collector must not allocate PTY'))
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command); const channel = accept(); channel.on('error', () => {})
        if (info.command.includes('uname -s')) { channel.write('WEBNAV-TASK-MANAGER\nLinux\nx86_64\nfixture\n/home/fixture\nfixture\n'); channel.exit(0); channel.end(); return }
        assert.equal(info.command, launchCommand({os:'linux'}, `/home/fixture/.webnav/tools/task-manager/${COLLECTOR_VERSION}/linux-x64/webnav-collector`)); launched++
        let buffer = ''
        channel.on('data', bytes => {
          buffer += bytes.toString(); let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
            let result = {}
            if (request.method === 'hello') result = hello
            if (request.method === 'snapshot') result = snapshot()
            if (request.method === 'details') result = { process: row, files: [], connections: [], modules: [], threads: [], unavailable: [] }
            if (request.method === 'commandLine') {
              assert.deepEqual(request.params, { pid: row.pid, startedAt: row.startedAt })
              result = { pid: row.pid, startedAt: row.startedAt, commandLine: "fixture-process --title='two words 中文'", truncated: false }
            }
            if (request.method === 'terminate') { terminated++; if (options.loseAction) { channel.close(); continue }; result = { status: 'exited', pid: request.params.pid, startedAt: request.params.startedAt } }
            channel.write(JSON.stringify({ v: 1, id: request.id, ok: true, result }) + '\n')
          }
        })
        channel.on('end', () => { channel.exit(0); channel.end() })
      })
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const ctx = new Context(), connection = { id: 'ssh-fixture', type: 'ssh', username: 'fixture', port: server.address().port }, target = { kind: 'ssh', serverId: 'server-fixture', connectionId: connection.id }
  ctx.set('storage', { connection(serverId, connectionId) { assert.equal(serverId, target.serverId); assert.equal(connectionId, target.connectionId); return { server: { name: 'Fixture', host: '127.0.0.1' }, connection } }, db: { prepare() { return { get(endpoint) { return hostkeys.has(endpoint) ? { fingerprint: hostkeys.get(endpoint) } : undefined }, run(endpoint, fingerprint) { hostkeys.set(endpoint, fingerprint) } } } } })
  ctx.set('auth', { authorized: owner => owner === 'owner' })
  ctx.set('credentials', { requireUnlocked() { if (locked) throw new Error('locked') }, resolve: async () => ({ password: 'only-test-fixture' }), subscribe(callback) { watchers.add(callback); return () => watchers.delete(callback) } })
  ctx.plugin(TaskManagerService, { execution: 'dedicated', directory: f.root, packageDirectory: f.directory }); await ctx.start()
  t.after(async () => { await ctx.stop(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)) })
  return { ...f, home, ctx, service: ctx.taskManager, target, commands, hostkeys, stats: () => ({ launched, terminated, connections: peers.size }), lock() { locked = true; for (const callback of watchers) callback({ unlocked: false }) } }
}

async function connectedMissing(f) {
  const started = await f.service.start('owner', f.target)
  await waitFor(async () => (await f.service.status('owner', started.id)).phase === 'host-key')
  assert.equal(f.service.sizeRemote, 1); assert.equal((await f.service.status('owner', started.id)).hostKey.changed, false)
  await f.service.hostKeyDecision('owner', started.id, true)
  const status = await waitFor(async () => { const current = (await f.service.status('owner', started.id)); if (current.phase === 'error') assert.fail(current.message); return current.phase === 'not-installed' && current })
  return status
}

test('isolated SSH uses explicit fingerprint and install, verifies SFTP upload, reuses install, binds actions and releases on lock', async t => {
  const f = await sshFixture(t), state = await connectedMissing(f)
  assert.equal(await lstat(join(f.home, '.webnav')).catch(() => undefined), undefined)
  assert.equal(f.stats().launched, 0)
  await assert.rejects(f.service.snapshot('other', state.id), { code: 'UNAUTHORIZED' })
  await f.service.install('owner', state.id)
  await waitFor(async () => { const current = (await f.service.status('owner', state.id)); if (current.phase === 'error') assert.fail(current.message); return current.phase === 'ready' })
  const destination = join(f.home, '.webnav', 'tools', 'task-manager', COLLECTOR_VERSION, 'linux-x64')
  assert.equal(digest(await readFile(join(destination, 'webnav-collector'))), f.pkg.sha256)
  assert.deepEqual((await readdir(destination)).sort(), ['install.json', 'webnav-collector'])
  const snapshot = await f.service.snapshot('owner', state.id), process = snapshot.processes[0]
  assert.equal((await f.service.details('owner', state.id, process)).process.pid, process.pid)
  assert.deepEqual(await f.service.commandLine('owner', state.id, process), { pid: process.pid, startedAt: process.startedAt, commandLine: "fixture-process --title='two words 中文'", truncated: false })
  await assert.rejects(f.service.commandLine('other', state.id, process), { code: 'UNAUTHORIZED' })
  await assert.rejects(async () => await f.service.prepareAction('owner', state.id, { ...process, startedAt: process.startedAt + 1 }), { code: 'PROCESS_CHANGED' })
  const plan = await f.service.prepareAction('owner', state.id, { ...process, force: true })
  const results = await Promise.all([f.service.applyAction('owner', state.id, plan.id), f.service.applyAction('owner', state.id, plan.id)])
  assert.deepEqual(results[0], results[1]); assert.equal(f.stats().terminated, 1)
  await f.service.close('owner', state.id); await waitFor(async () => !f.service.hasResources()); assert.equal(f.service.sizeRemote, 0)
  const second = await f.service.start('owner', f.target)
  await waitFor(async () => { const current = (await f.service.status('owner', second.id)); if (current.phase === 'error') assert.fail(current.message); return current.phase === 'ready' })
  assert.equal(f.stats().launched, 2); assert.equal(f.commands.some(command => command.includes('only-test-fixture')), false)
  f.lock(); await waitFor(async () => !f.service.hasResources()); assert.equal(f.service.sizeRemote, 0)
})

test('SSH action result loss remains unknown without replay, and mismatched first snapshot never becomes ready', async t => {
  const f = await sshFixture(t, { loseAction: true }), state = await connectedMissing(f)
  await f.service.install('owner', state.id); await waitFor(async () => (await f.service.status('owner', state.id)).phase === 'ready')
  const process = (await f.service.snapshot('owner', state.id)).processes[0], plan = await f.service.prepareAction('owner', state.id, { ...process, force: true })
  await assert.rejects(f.service.applyAction('owner', state.id, plan.id), { code: 'ACTION_UNKNOWN' }); assert.equal(f.stats().terminated, 1)
  await assert.rejects(f.service.applyAction('owner', state.id, plan.id)); assert.equal(f.stats().terminated, 1)
  const bad = await sshFixture(t, { badBoot: true }), missing = await connectedMissing(bad)
  await bad.service.install('owner', missing.id); await waitFor(async () => (await bad.service.status('owner', missing.id)).phase === 'error'); assert.equal((await bad.service.status('owner', missing.id)).phase, 'error')
  await waitFor(async () => !bad.service.hasResources())
})

test('changed SSH fingerprints require a fresh decision and early cancellation releases reservations without installation', async t => {
  const f = await sshFixture(t)
  f.hostkeys.set(JSON.stringify(['127.0.0.1', f.ctx.storage.connection('server-fixture', 'ssh-fixture').connection.port]), 'SHA256:previous')
  const state = await f.service.start('owner', f.target)
  await waitFor(async () => (await f.service.status('owner', state.id)).phase === 'host-key')
  assert.equal((await f.service.status('owner', state.id)).hostKey.changed, true); assert.equal(f.stats().launched, 0)
  await f.service.hostKeyDecision('owner', state.id, false); await waitFor(async () => !f.service.hasResources()); assert.equal(f.service.sizeRemote, 0)
  const cancelled = await f.service.start('owner', f.target); await f.service.close('owner', cancelled.id); await waitFor(async () => !f.service.hasResources()); assert.equal(f.stats().launched, 0)
  assert.equal(await lstat(join(f.home, '.webnav')).catch(() => undefined), undefined)
})

test('invalid performance counters after readiness stop monitoring and release the SSH reservation', async t => {
  const options = {}, f = await sshFixture(t, options), state = await connectedMissing(f)
  await f.service.install('owner', state.id); await waitFor(async () => (await f.service.status('owner', state.id)).phase === 'ready')
  options.badPerformance = true
  await waitFor(async () => {
    try { await f.service.snapshot('owner', state.id); return false }
    catch (error) { assert.equal(error.code, 'COLLECTOR_PROTOCOL'); return true }
  })
  assert.equal((await f.service.status('owner', state.id)).phase, 'error')
  await waitFor(async () => !f.service.hasResources()); assert.equal(f.service.sizeRemote, 0)
})

test('direct service calls honor maintenance while allowing cleanup and already-completed action results', async t => {
  const f = await sshFixture(t); let draining = true
  f.ctx.set('maintenance', { requireAvailable() { if (draining) throw Object.assign(new Error('maintenance'), { code: 'UPDATE_WAITING' }) } })
  await assert.rejects(f.service.start('owner', f.target), { code: 'UPDATE_WAITING' }); assert.equal(f.service.size, 0)
  draining = false; const missing = await connectedMissing(f)
  draining = true; await assert.rejects(f.service.install('owner', missing.id), { code: 'UPDATE_WAITING' }); assert.equal(f.stats().launched, 0)
  draining = false; await f.service.install('owner', missing.id); await waitFor(async () => (await f.service.status('owner', missing.id)).phase === 'ready')
  const row = (await f.service.snapshot('owner', missing.id)).processes[0]
  draining = true; await assert.rejects(async () => await f.service.prepareAction('owner', missing.id, { ...row, force: true }), { code: 'UPDATE_WAITING' })
  draining = false; const plan = await f.service.prepareAction('owner', missing.id, { ...row, force: true })
  draining = true; await assert.rejects(f.service.applyAction('owner', missing.id, plan.id), { code: 'UPDATE_WAITING' }); assert.equal(f.stats().terminated, 0)
  draining = false; const result = await f.service.applyAction('owner', missing.id, plan.id)
  draining = true; assert.deepEqual(await f.service.applyAction('owner', missing.id, plan.id), result); assert.equal(f.stats().terminated, 1)
  await f.service.close('owner', missing.id); await waitFor(async () => !f.service.hasResources())
})
