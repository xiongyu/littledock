// Full Windows release qualification. Only synthetic data and an isolated user profile are used.
// Run after release:build: node --experimental-strip-types backend/tests/updates-installed.mjs <portable-directory>
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, mkdir, readdir, lstat, access } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { WebSocket } from 'ws'
import { chromium } from 'playwright-core'
import { atomicJson, fileHash, removeOwned } from '../src/desktop/update-files.ts'
import { configuration } from '../src/desktop/config.ts'
import { request } from '../src/desktop/control.ts'
import { windowsAction, saveLaunchConfiguration, refreshStartupConfiguration, powershell, windowsFiles } from '../src/desktop/windows.ts'

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Windows qualification requires a built portable directory.')
const source = resolve(process.argv[2]), scratch = await mkdtemp(join(tmpdir(), 'webnav-installed-'))
const install = join(scratch, 'WebNav'), data = join(scratch, 'data'), profile = join(scratch, 'profile')
const screenshots = resolve('docs/design/screenshots'), evidence = { checks: [], screenshots: [], completed: false }
const mark = message => { evidence.checks.push(message); console.log(message) }
const keys = generateKeyPairSync('ed25519')
let feed, child, browser, client, terminal, logs = '', selectedArtifact
const server = createServer((req, res) => {
  if (req.url === '/feed.json') { res.setHeader('Content-Type', 'application/json'); res.end(feed); return }
  if (req.url === '/release.zip' && selectedArtifact) { createReadStream(selectedArtifact).pipe(res); return }
  res.writeHead(404).end()
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const feedUrl = `http://127.0.0.1:${server.address().port}/feed.json`
const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port; await new Promise(r => reserve.close(r))
const origin = `http://127.0.0.1:${port}`
const env = { ...process.env, LOCALAPPDATA: profile, WEBNAV_DATA_DIR: data, WEBNAV_PORT: String(port), WEBNAV_RDP_ENABLED: '0', WEBNAV_EDITOR_ENABLED: '0' }
const config = configuration('start', { ...env, WEBNAV_INSTALL_ROOT: install })
async function until(work, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await work(); if (result) return result; await new Promise(r => setTimeout(r, 100)) }
  throw new Error('Installed update qualification timed out. ' + logs.slice(-2500))
}
async function boot() {
  logs = ''
  child = spawn(join(install, 'runtime/node.exe'), [join(install, 'launch.mjs'), '--console'], { cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000) })
  await until(async () => {
    if (child.exitCode !== null) throw new Error('Packaged startup failed: ' + logs)
    return await request(config, 'status').then(v => v.state === 'running').catch(() => false)
  })
}
async function stop() {
  client?.ws.terminate(); terminal?.terminate(); client = undefined; terminal = undefined
  if (!child || child.exitCode !== null) {
    const running = await request(config, 'status').catch(() => undefined)
    if (running) { await request(config, 'exit'); await until(async () => !await request(config, 'status').catch(() => undefined)) }
    return
  }
  const exited = once(child, 'exit')
  child.send('shutdown')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Test launcher failed to stop')) }, 30000) })]) }
  finally { clearTimeout(timer) }
}
async function connect() {
  client?.ws.terminate()
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } })
  const pending = new Map(); let epoch
  ws.on('error', () => {})
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.type === 'hello') epoch = message.epoch
    const p = pending.get(message.id)
    if (p) { clearTimeout(p.timer); pending.delete(message.id); message.ok ? p.resolve(message.result) : p.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) }
  })
  ws.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Reconnecting')) }; pending.clear() })
  await until(() => epoch, 10000)
  client = { ws, cookie, rpc(method, params = {}, operationId) {
    return new Promise((resolveDone, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)) }, 20000)
      pending.set(id, { resolve: resolveDone, reject, timer })
      ws.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, ...(operationId ? { operationId } : {}) }))
    })
  } }
  return client
}
async function state(phase) { return until(async () => { const s = await client.rpc('updates.status'); if (s.phase === 'failed' && phase !== 'failed') throw new Error(s.message); return s.phase === phase && s }) }
async function candidate(version, broken = false) {
  const base = join(install, 'releases/0.1.0'), path = join(scratch, version + '.zip')
  const zip = new ZipFile(), written = pipeline(zip.outputStream, createWriteStream(path))
  const metadata = { ...JSON.parse(await readFile(join(base, 'release.json'), 'utf8')), version }
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name), name = prefix + entry.name
      if (entry.isDirectory()) await visit(file, name + '/')
      else if (name === 'release.json') zip.addBuffer(Buffer.from(JSON.stringify(metadata)), name)
      else if (name === 'backend/node_modules/@webnav/shared/dist/plugins.js') zip.addBuffer(Buffer.from((await readFile(file, 'utf8')).replace(/export const WEBNAV_VERSION = '[^']+'/, `export const WEBNAV_VERSION = '${version}'`)), name)
      else if (broken && name === 'backend/dist/main.js') zip.addBuffer(Buffer.from("process.send?.({type:'ready',nonce:'incorrect',version:'0.1.2'});setTimeout(()=>process.exit(17),200)"), name)
      else zip.addFile(file, name)
    }
  }
  await visit(base)
  if (!await access(join(base, 'runtime/node.exe')).then(() => true).catch(() => false)) zip.addFile(join(install, 'runtime/node.exe'), 'runtime/node.exe')
  zip.end(); await written
  selectedArtifact = path
  const payload = Buffer.from(JSON.stringify({ ...metadata, url: new URL('release.zip', feedUrl).href, size: (await lstat(path)).size, sha256: await fileHash(path), notes: broken ? '隔离验收：模拟启动失败' : '隔离验收：保留数据并升级工作台', publishedAt: Date.now(), expiresAt: Date.now() + 86400000 }))
  feed = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('webnav-update-v1\0'), payload]), keys.privateKey).toString('base64') })
}
async function openPanel(page) {
  await page.getByRole('button', { name: '全局设置', exact: true }).click()
  await page.getByRole('button', { name: /工作台更新/ }).click()
  await page.locator('.update-panel').getByText('当前版本').waitFor()
}
try {
  await cp(source, install, { recursive: true }); await mkdir(screenshots, { recursive: true })
  await atomicJson(join(install, 'update-source.json'), { feed: feedUrl, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), channel: 'stable' })
  await candidate('0.1.1')
  await boot(); await connect()
  assert.equal((await client.rpc('updates.status')).currentVersion, '0.1.0')
  mark('Portable release boots outside the repository using bundled Node and dependencies')
  const catalog = { schemaVersion: 1, groups: [], servers: [{ id: 'fixture', name: '升级验收（本机模拟）', host: '127.0.0.1', groupId: '', note: 'must survive updates', tags: [], favorite: false, connections: [{ id: 'local', name: 'Local test', type: 'local', port: 1, saveHistory: false, pluginSettings: { shell: 'auto' } }] }] }
  await client.rpc('catalog.replace', { catalog, expectedRevision: 0 }, randomUUID())
  const ticket = await client.rpc('connections.open', { serverId: 'fixture', connectionId: 'local' }, randomUUID())
  terminal = new WebSocket(origin.replace('http', 'ws') + '/ws/terminal', { origin, headers: { cookie: client.cookie } })
  let ready = false, parsedBytes = 0, output = ''
  terminal.on('message', (data, binary) => {
    if (binary) { output += data.toString(); parsedBytes += data.length; terminal.send(JSON.stringify({ type: 'terminal.ack', parsedBytes })) }
    else if (JSON.parse(data.toString()).type === 'terminal.ready') ready = true
  })
  await once(terminal, 'open'); terminal.send(JSON.stringify({ type: 'terminal.attach', ...ticket, cols: 80, rows: 24 }))
  await until(() => ready); terminal.send(Buffer.from("echo 'UPDATE_PTY_VERIFIED'\r")); await until(() => output.includes('UPDATE_PTY_VERIFIED'))
  mark('Bundled native SQLite and local PTY execute successfully')
  let executablePath
  for (const p of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) { if (await access(p).then(() => true).catch(() => false)) { executablePath = p; break } }
  assert.ok(executablePath, 'Edge or Chrome required for browser qualification')
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } }), errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(30000)
  await page.goto(origin); await openPanel(page)
  await client.rpc('updates.check'); await state('available')
  await page.getByRole('button', { name: '下载更新', exact: true }).click(); await state('ready')
  await page.getByRole('button', { name: '空闲后安装并重启' }).click()
  await until(async () => (await client.rpc('updates.status')).blockers?.length)
  await assert.rejects(client.rpc('connections.open', { serverId: 'fixture', connectionId: 'local' }, randomUUID()), { code: 'UPDATE_WAITING' })
  assert.equal(terminal.readyState, WebSocket.OPEN)
  await page.getByText(/个 SSH \/ 本地终端/).waitFor()
  await page.screenshot({ path: join(screenshots, 'online-update-waiting.png'), fullPage: true })
  await page.getByRole('button', { name: '取消安装', exact: true }).click(); await state('ready')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '空闲后安装并重启' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(screenshots, 'online-update-mobile.png'), fullPage: true })
  mark('Update UI downloads, waits for a live terminal, cancels, and fits a 390px viewport')
  terminal.close(); await once(terminal, 'close'); terminal = undefined
  const original = await request(config, 'status'), operationId = randomUUID()
  await client.rpc('updates.install', { targetVersion: '0.1.1' }, operationId)
  await until(async () => { const p = JSON.parse(await readFile(join(install, 'installation.json'), 'utf8')); return p.current === '0.1.1' && !p.pending })
  await connect(); assert.equal((await state('succeeded')).currentVersion, '0.1.1')
  const upgraded = await request(config, 'status'); assert.equal(upgraded.pid, original.pid); assert.notEqual(upgraded.workerPid, original.workerPid)
  assert.deepEqual((await client.rpc('catalog.watch')).snapshot, catalog)
  await client.rpc('updates.install', { targetVersion: '0.1.1' }, operationId)
  assert.equal((await request(config, 'status')).workerPid, upgraded.workerPid)
  await page.getByText('更新完成，工作台已重新启动。', { exact: true }).waitFor()
  mark('Real worker switches version, reconnects the page, preserves data, and deduplicates installation')
  await candidate('0.1.2', true); await client.rpc('updates.check'); await state('available')
  await client.rpc('updates.download', { targetVersion: '0.1.2' }, randomUUID()); await state('ready')
  await client.rpc('updates.install', { targetVersion: '0.1.2' }, randomUUID())
  await until(async () => JSON.parse(await readFile(join(install, 'installation.json'), 'utf8')).recovered === true)
  await until(async () => (await request(config, 'status').catch(() => ({}))).state === 'running')
  await connect(); const failed = await state('failed'); assert.equal(failed.recovered, true); assert.equal(failed.currentVersion, '0.1.1')
  assert.deepEqual((await client.rpc('catalog.watch')).snapshot, catalog)
  await page.getByText(/已恢复上一版/).waitFor(); await page.screenshot({ path: join(screenshots, 'online-update-recovered.png'), fullPage: true })
  mark('A real failing candidate process restores the previous release and retained catalog')
  await browser.close(); browser = undefined; await stop()
  await atomicJson(join(install, 'installation.json'), { schemaVersion: 1, current: '0.1.2', previous: '0.1.1', pending: { from: '0.1.1', to: '0.1.2' } })
  await boot(); await connect(); assert.equal((await client.rpc('updates.status')).currentVersion, '0.1.1')
  assert.deepEqual((await client.rpc('catalog.watch')).snapshot, catalog)
  mark('Stable launcher recovers an interrupted pending pointer on the next launch')
  const startup = join(scratch, 'Startup'); await mkdir(startup)
  assert.equal(await refreshStartupConfiguration(config, startup), false)
  const sourceConfig = configuration('start', env)
  await saveLaunchConfiguration(sourceConfig); await windowsAction(sourceConfig, 'enable', startup)
  assert.equal(await refreshStartupConfiguration(config, startup), true)
  const launch = JSON.parse(await readFile(join(config.runtimeDirectory, 'launch.json'), 'utf8'))
  assert.equal(launch.entry, join(install, 'launch.mjs')); assert.equal(launch.node, join(install, 'runtime/node.exe')); assert.equal(launch.environment.WEBNAV_DATA_DIR, data)
  assert.equal(await windowsAction(config, 'status', startup), true)
  const inspect = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::ReadLine(); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); [Console]::WriteLine($s.Arguments)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  let linkArguments = ''; inspect.stdout.on('data', b => { linkArguments += b.toString() }); inspect.stdin.end(join(startup, `WebNav-${config.identity}.lnk`) + '\n'); await once(inspect, 'exit')
  assert.ok(linkArguments.includes(join(install, 'launcher/windows', 'launch.ps1').replaceAll('/', '\\')) || linkArguments.includes(join(install, 'launcher/windows', 'launch.ps1')))
  await stop()
  const bootstrap = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(windowsFiles(config), 'launch.ps1'), '-ConfigFile', join(config.runtimeDirectory, 'launch.json')], { windowsHide: true, stdio: 'ignore' })
  assert.equal((await once(bootstrap, 'exit'))[0], 0)
  await until(async () => (await request(config, 'status').catch(() => ({}))).state === 'running'); await connect()
  assert.equal((await client.rpc('updates.status')).currentVersion, '0.1.1'); assert.deepEqual((await client.rpc('catalog.watch')).snapshot, catalog)
  await windowsAction(config, 'disable', startup); assert.equal(await windowsAction(config, 'status', startup), false)
  mark('Windows startup migration preserves opt-in and data; its real hidden bootstrap starts the upgraded release')
  assert.deepEqual(errors, [])
  evidence.completed = true; evidence.screenshots = ['online-update-waiting.png', 'online-update-mobile.png', 'online-update-recovered.png']
} finally {
  await browser?.close(); await stop()
  server.closeAllConnections(); await new Promise(r => server.close(r))
  await mkdir(resolve('.releases'), { recursive: true }); await atomicJson(resolve('.releases/installed-acceptance.json'), evidence)
  await removeOwned(tmpdir(), scratch)
}
