import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { GuacamoleDecoder, guacamoleInstruction } from '@webnav/shared'
import { prepareRdpRuntime } from '../src/plugins/rdp/runtime.ts'
import { launchFreeRdp, connectionRecord } from '../src/plugins/rdp/native-session.ts'
import { NativeDecoder, nativeRecord, numbers } from '../src/plugins/rdp/protocol.ts'

const windows = process.platform === 'win32' && process.arch === 'x64'
const root = fileURLToPath(new URL('../../', import.meta.url))
const peerExe = join(root, 'backend/native/rdp/build/Release/webnav-rdp-test-peer.exe')
const openssl = process.env.WEBNAV_TEST_OPENSSL ?? join(root, '.native-deps/openssl-install/bin/openssl.exe')
const exists = path => access(path).then(() => true, () => false)
const integration = windows && await exists(peerExe) && await exists(openssl)
const wait = async predicate => { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('Native RDP test timed out'); await new Promise(resolve => setTimeout(resolve, 15)) } }
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value }
async function stop(child) { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill(); await exited }
async function peer(port, cert, key) {
  const child = spawn(peerExe, [String(port), cert, key], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }), events = []
  child.stdout.on('data', bytes => events.push(bytes.toString()))
  await wait(() => events.join('').includes('listening'))
  return { child, events }
}
// WIC emits RGBA PNG. The first pixel has no left/up neighbour for any PNG filter.
function firstPixel(png) {
  assert.equal(png[24], 8); assert.equal(png[25], 6)
  const idat = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length))
    at += length + 12
  }
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 4)]
}
function assertWholeFrame(rows, width, height) {
  const pixels = new Uint8Array(width * height)
  for (const { type, data } of rows) if (type === 2 || type === 9) {
    const [x, y, w, h] = [0, 4, 8, 12].map(at => data.readUInt32LE(at))
    assert.ok(w > 0 && h > 0 && (type === 9 || (w <= 256 && h <= 256)) && x + w <= width && y + h <= height)
    for (let row = y; row < y + h; row++) pixels.fill(1, row * width + x, row * width + x + w)
  }
  assert.ok(pixels.every(value => value === 1), 'Every pixel must be included before the frame sync')
}

test('bundled RDP helper validates framing and exits on parent pipe EOF', { skip: !windows, timeout: 15000 }, async () => {
  const executable = await prepareRdpRuntime()
  for (const bytes of [numbers(1, 1024 * 1024 + 1), nativeRecord(1, numbers(99)), Buffer.alloc(0)]) {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }), output = []
    child.stdout.on('data', data => output.push(data)); const exited = once(child, 'exit'); child.stdin.end(bytes)
    const [code] = await exited; assert.equal(code, 1)
    const records = []; new NativeDecoder().push(Buffer.concat(output), (type, payload) => records.push({ type, length: payload.length }))
    assert.deepEqual(records, [{ type: 6, length: 12 }])
  }
})

test('native RDP requires its own saved credentials for automatic/NLA authentication before connecting', { skip: !windows, timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-native-credentials-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const security of ['any', 'nla']) for (const missing of ['username', 'password']) {
    const options = { host: '127.0.0.1', directory, width: 960, height: 540, password: missing === 'password' ? undefined : 'synthetic-only', signal: new AbortController().signal,
      connection: { id: 'rdp', name: 'Test', type: 'rdp', port: 1, username: missing === 'username' ? '' : 'test', rdpOptions: { security } } }
    await assert.rejects(launchFreeRdp(options), { code: 'RDP_CONNECT_FAILED', message: /未保存完整账号密码/ })
  }
})

test('FreeRDP TLS loopback: certificates, PNG frames, ACK bounds, keyboard/mouse, clipboard and cleanup', { skip: integration ? false : 'Build with -TestPeer to run native TLS integration', timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-native-rdp-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const id of ['first', 'changed']) execFileSync(openssl, ['req', '-config', 'NUL', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, `${id}.key`), '-out', join(directory, `${id}.crt`), '-days', '1', '-subj', '/CN=localhost'], { windowsHide: true, stdio: 'ignore' })
  const endpoint = await port(); let server = await peer(endpoint, join(directory, 'first.crt'), join(directory, 'first.key'))
  t.after(() => stop(server.child))
  const options = { host: '127.0.0.1', directory, width: 960, height: 540, password: 'synthetic-only', signal: new AbortController().signal,
    connection: { id: 'rdp', name: 'Test', type: 'rdp', port: endpoint, username: 'test', rdpOptions: { security: 'tls', certificate: 'verify' } } }
  await assert.rejects(launchFreeRdp(options), { code: 'RDP_CONNECT_FAILED', message: /证书未受信任或已变化/ })
  // Existing entries with no certificate setting must accept and remember the first certificate.
  delete options.connection.rdpOptions.certificate
  const stream = await launchFreeRdp(options); t.after(() => stream.destroy())
  const instructions = [], parser = new GuacamoleDecoder(), images = new Map(), errors = [], clipStreams = new Map()
  stream.on('error', error => errors.push(error.message))
  stream.on('data', bytes => parser.push(bytes.toString(), values => {
    instructions.push(values)
    if (values[0] === 'img') images.set(values[1], [])
    if (values[0] === 'blob' && images.has(values[1])) images.get(values[1]).push(Buffer.from(values[2], 'base64'))
    if (values[0] === 'clipboard') clipStreams.set(values[1], [])
    if (values[0] === 'blob' && clipStreams.has(values[1])) clipStreams.get(values[1]).push(Buffer.from(values[2], 'base64'))
    if (values[0] === 'sync') stream.write(guacamoleInstruction('sync', values[1]))
  }))
  stream.resume()
  await wait(() => errors.length || instructions.filter(row => row[0] === 'img').length >= 12).catch(error => { throw new Error(`${error.message}; instructions=${instructions.map(row => row[0]).join(',')}; peer=${server.events.join('')}`) })
  assert.deepEqual(errors, [])
  const pngInstruction = instructions.find(row => row[0] === 'img' && row[4] === 'image/png' && row[3] === '0')
  assert.ok(pngInstruction, 'Static desktop must receive a lossless refinement')
  assert.ok(instructions.some(row => row[0] === 'img' && row[4] === 'image/jpeg'), 'Large redraw uses the fast image path')
  const image = Buffer.concat(images.get(pngInstruction[1])); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(image.readUInt32BE(16) <= 256); assert.ok(instructions.some(row => row[0] === 'size' && row[2] === '960'))
  stream.write(guacamoleInstruction('key', 0xffe3, 1) + guacamoleInstruction('key', 0xffe9, 1) + guacamoleInstruction('key', 0xffff, 1) + guacamoleInstruction('key', 0xffff, 0) + guacamoleInstruction('key', 0xffe9, 0) + guacamoleInstruction('key', 0xffe3, 0))
  stream.write(guacamoleInstruction('mouse', 100, 120, 1) + guacamoleInstruction('mouse', 100, 120, 0))
  await wait(() => server.events.join('').includes('mouse') && server.events.join('').includes('key 33024 83'))
  assert.match(server.events.join(''), /key 0 29/); assert.match(server.events.join(''), /key 0 56/); assert.match(server.events.join(''), /key 256 83/)
  await wait(() => [...clipStreams.values()].some(chunks => Buffer.concat(chunks).toString() === 'WebNav remote clipboard'))
  stream.write(guacamoleInstruction('clipboard', '91', 'text/plain') + guacamoleInstruction('blob', '91', Buffer.from('local测试').toString('base64')) + guacamoleInstruction('end', '91'))
  await wait(() => server.events.join('').includes('clipboard-ok'))
  assert.equal(stream.viewerVersion,1)
  const connectionsBefore=server.events.join('').split('activated').length
  stream.setViewer(false)
  await new Promise(resolve=>setTimeout(resolve,80))
  const detachedCount=instructions.length
  // Beyond the old 30-second display ACK deadline: the RDP connection must remain alive.
  await new Promise(resolve=>setTimeout(resolve,31_000))
  assert.equal(stream.destroyed,false);assert.equal(instructions.length,detachedCount)
  stream.setViewer(true)
  await wait(()=>instructions.slice(detachedCount).some(row=>row[0]==='sync'))
  assert.ok(instructions.slice(detachedCount).some(row=>row[0]==='size'&&row[2]==='960'))
  assert.ok(instructions.slice(detachedCount).some(row=>row[0]==='img'))
  assert.equal(server.events.join('').split('activated').length,connectionsBefore)
  const closed = once(stream, 'close'); stream.destroy(); await closed
  // At most two complete frames in flight, allowing encode and display to overlap.
  const executable = await prepareRdpRuntime(), child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); t.after(() => stop(child))
  const records = [], native = new NativeDecoder(); child.stdout.on('data', bytes => native.push(bytes, (type, data) => records.push({ type, data })))
  child.stdin.write(connectionRecord(options)); await wait(() => records.filter(row => row.type === 7).length === 2)
  const firstSync = records.findIndex(row => row.type === 7)
  assertWholeFrame(records.slice(0, firstSync), 960, 540)
  const heldCount = records.length, paintsBefore = (server.events.join('').match(/paint /g) ?? []).length
  // Keep changing the server while the browser is stalled. Only the newest pixels
  // should survive, not ten queued screenshots or starvation of the bottom tiles.
  for (let i = 0; i < 10; i++) child.stdin.write(nativeRecord(2, numbers(0xffc3, 1)))
  await wait(() => (server.events.join('').match(/paint /g) ?? []).length >= paintsBefore + 10)
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(records.length, heldCount)
  child.stdin.write(nativeRecord(6, records.filter(row => row.type === 7).at(-1).data))
  await wait(() => records.slice(heldCount).some(row => row.type === 7))
  const secondSync = records.findIndex((row, index) => index >= heldCount && row.type === 7)
  const latest = records.slice(heldCount, secondSync)
  assertWholeFrame(latest, 960, 540)
  assert.ok(latest.some(row => row.type === 9))
  child.stdin.write(nativeRecord(6, records[secondSync].data))
  const refinementStart = records.length
  await wait(() => records.slice(refinementStart).some(row => row.type === 7))
  const refined = records.slice(refinementStart)
  assertWholeFrame(refined, 960, 540)
  assert.equal(refined.filter(row => row.type === 2).length, 12)
  for (const row of refined.filter(row => row.type === 2)) assert.deepEqual(firstPixel(row.data.subarray(16)), [0x61, 0x7e, 0xd4])
  child.stdin.write(nativeRecord(6, refined.find(row => row.type === 7).data))
  // After draining, a small repaint must not resend a padded 256px tile.
  await new Promise(resolve => setTimeout(resolve, 100))
  const smallStart = records.length
  child.stdin.write(nativeRecord(2, numbers(0xffc4, 1)))
  await wait(() => records.slice(smallStart).some(row => row.type === 7))
  const small = records.slice(smallStart).filter(row => row.type === 2)
  assert.equal(small.reduce((sum, row) => sum + row.data.readUInt32LE(8) * row.data.readUInt32LE(12), 0), 400)
  assert.ok(small.every(row => row.data.readUInt32LE(0) >= 930 && row.data.readUInt32LE(4) >= 510))
  const exit = once(child, 'exit'); child.stdin.end(); await exit
  // The large-desktop encoder pool must still submit one coherent frame and exit
  // promptly with an unacknowledged desktop; all pixel reads finish before teardown.
  const large = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); t.after(() => stop(large))
  const largeRecords = [], largeParser = new NativeDecoder()
  large.stdout.on('data', bytes => largeParser.push(bytes, (type, data) => largeRecords.push({ type, data })))
  large.stdin.write(connectionRecord({ ...options, width: 3840, height: 2160 }))
  await wait(() => largeRecords.some(row => row.type === 7))
  assertWholeFrame(largeRecords.slice(0, largeRecords.findIndex(row => row.type === 7)), 3840, 2160)
  // A second frame may already have arrived before this async assertion runs.
  assert.equal(largeRecords.slice(0, largeRecords.findIndex(row => row.type === 7)).filter(row => row.type === 9).length, 4)
  const largeExit = once(large, 'exit'); large.stdin.end(); await largeExit
  await stop(server.child); server = await peer(endpoint, join(directory, 'changed.crt'), join(directory, 'changed.key'))
  const changes = []
  await assert.rejects(launchFreeRdp({ ...options, confirmCertificate: async certificate => { changes.push(certificate); return false } }), { code: 'RDP_CONNECT_FAILED', message: /已取消更新证书/ })
  assert.equal(changes.length, 1); assert.notEqual(changes[0].previousFingerprint, changes[0].fingerprint)
  // Leaving the page while a decision is pending must release the helper without waiting for timeout.
  const controller = new AbortController(); let prompted
  const pendingPrompt = new Promise(resolve => { prompted = resolve })
  const aborted = launchFreeRdp({ ...options, signal: controller.signal, confirmCertificate: () => { prompted(); return new Promise(() => {}) } })
  const stopped = assert.rejects(aborted, /已取消/)
  await pendingPrompt; controller.abort(); await stopped
  const updated = await launchFreeRdp({ ...options, confirmCertificate: async certificate => { assert.deepEqual(certificate, changes[0]); return true } })
  const updatedClosed = once(updated, 'close'); updated.destroy(); await updatedClosed
  const remembered = await launchFreeRdp({ ...options, confirmCertificate: async () => { throw new Error('Updated certificate must already be remembered') } })
  const rememberedClosed = once(remembered, 'close'); remembered.destroy(); await rememberedClosed
})
