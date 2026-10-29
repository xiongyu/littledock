// Manual browser verification against synthetic peers; independent data directory and ports.
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app.ts'
import { mockVnc } from './desktop-fixtures.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

const directory = await mkdtemp(join(tmpdir(), 'webnav-desktop-ui-')), vnc = await mockVnc({ password: 'vnc-test' })
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const rdpPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
const certificate = join(directory, 'test.crt'), key = join(directory, 'test.key')
execFileSync(resolve('.native-deps/openssl-install/bin/openssl.exe'), ['req', '-config', 'NUL', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost'], { windowsHide: true, stdio: 'ignore' })
const rdpEvents = []
async function startPeer() {
  const child = spawn(resolve('backend/native/rdp/build/Release/webnav-rdp-test-peer.exe'), [String(rdpPort), certificate, key], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', bytes => rdpEvents.push(...bytes.toString().trim().split('\n')))
  await once(child.stdout, 'data'); return child
}
let peer = await startPeer(), rotating = false
const ctx = await createApp({ directory, port: 3042, frontendRoot: resolve('frontend/dist') })
// Omit rdpClient deliberately: older entries must open a workspace tab without editing.
const server = (id, name, type, port) => ({ id, name, host: '127.0.0.1', groupId: '', tags: ['仅本机模拟'], note: '', favorite: true, connections: [{ id: type, name: type.toUpperCase(), type, port, ...(type === 'rdp' ? { username: 'test', rdpOptions: { security: 'tls' } } : {}) }] })
const strict = server('certificate', 'RDP 证书错误测试', 'rdp', rdpPort)
strict.connections[0].rdpOptions.certificate = 'verify'
const performanceServer = server('rdp', 'FreeRDP 本机测试', 'rdp', rdpPort)
for (const [label, width, height] of [['2K', 2560, 1440], ['4K', 3840, 2160]]) {
  performanceServer.connections.push({ ...performanceServer.connections[0], id: `rdp-${label}`, name: label, rdpDisplay: { mode: 'windowed', width, height } })
}
const catalog = { schemaVersion: 1, groups: [], servers: [server('vnc', 'VNC 模拟桌面', 'vnc', vnc.port), performanceServer, strict, server('offline', '离线桌面', 'vnc', 1)] }
ctx.storage.replace(catalog, 0)
ctx.credentials.prepareDesktopPasswords([{ serverId: 'vnc', connectionId: 'vnc', secret: 'vnc-test' }, ...performanceServer.connections.map(connection => ({ serverId: 'rdp', connectionId: connection.id, secret: 'rdp-test' }))], catalog)()
console.log(JSON.stringify({ origin: 'http://127.0.0.1:3042', directory }))
let closing = false
async function close() { if (closing) return; closing = true; clearInterval(timer); await ctx.stop(); await vnc.close(); const exited = once(peer, 'exit'); peer.kill(); await exited; await rm(directory, { recursive: true, force: true }); process.exit(0) }
const timer = setInterval(async () => {
  if (closing) return
  try { await access(join(directory, 'stop')); await close() } catch {}
  if (closing) return
  if (!rotating) {
    try {
      await access(join(directory, 'rotate')); rotating = true; await rm(join(directory, 'rotate'))
      const exited = once(peer, 'exit'); peer.kill(); await exited
      execFileSync(resolve('.native-deps/openssl-install/bin/openssl.exe'), ['req', '-config', 'NUL', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost'], { windowsHide: true, stdio: 'ignore' })
      peer = await startPeer(); rotating = false
      await writeFile(join(directory, 'rotated'), 'ready')
    } catch (error) { if (rotating) { console.error(error); await close(); return } }
  }
  const rdpConnections = rdpEvents.filter(row => row.trim() === 'activated').length
  await writeFile(join(directory, 'stats.json'), JSON.stringify({ vncActive: vnc.sockets.size, vncConnections: vnc.events.filter(row => row[0] === 'connection').length, vncInput: vnc.events.filter(row => row[0] === 'input'), rdpActive: rdpConnections - rdpEvents.filter(row => row.trim() === 'closed').length, rdpConnections, rdpInput: rdpEvents.filter(row => /^(key|mouse|unicode) /.test(row)) }))
}, 500)
process.on('SIGINT', close); process.on('SIGTERM', close)
