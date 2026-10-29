import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { configuration, root } from '../src/desktop/config.ts'
import { request } from '../src/desktop/control.ts'
import { windowsAction, saveLaunchConfiguration, powershell, windowsFiles } from '../src/desktop/windows.ts'

const windows = process.platform === 'win32'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(100) }
  throw new Error('Timed out waiting for lifecycle state')
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function testConfig(t) {
  // Spaces, Unicode and apostrophes must survive PowerShell/shortcut boundaries.
  const directory = await mkdtemp(join(tmpdir(), "webnav 托盘 'test-"))
  const port = await freePort(); let ui = await freePort(); while (ui === port) ui = await freePort()
  const config = configuration('dev', { ...process.env, LOCALAPPDATA: directory, XDG_STATE_HOME: directory, WEBNAV_DATA_DIR: directory, WEBNAV_PORT: String(port), WEBNAV_UI_PORT: String(ui) })
  t.after(async () => {
    try { await request(config, 'exit') } catch { }
    await waitFor(async () => { try { await request(config, 'status'); return false } catch { return true } })
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  })
  return config
}
async function launch(config) {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'backend/tests/instance-supervisor-fixture.mjs'), config.mode], { cwd: join(root, 'frontend'), windowsHide: true, detached: true, env: { ...process.env, ...config.environment }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const status = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture controller timeout'))},50_000)
    child.once('message',message=>{clearTimeout(timer);resolve(message)})
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture controller exited: '+code))})
  })
  if(child.connected)child.disconnect();child.unref()
  return {code:status.state==='running'?0:1,output:status.error??''}
}
async function repeatLaunch(config,entry='scripts/dev.mjs') {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, entry)], { cwd: join(root, 'frontend'), windowsHide: true, env: { ...process.env, ...config.environment, WEBNAV_NO_TRAY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  const [code] = await once(child, 'exit'); return { code, output }
}
async function rpc(config, method, params = {}, savedCookie) {
  const page = await fetch(config.url), cookie = savedCookie??page.headers.get('set-cookie').split(';')[0]; await page.body?.cancel()
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, { origin: config.url.slice(0, -1), headers: { cookie } })
  try {
    const [helloRaw] = await once(socket, 'message'), hello = JSON.parse(String(helloRaw))
    const response = once(socket, 'message')
    socket.send(JSON.stringify({ v: 1, type: 'request', id: randomUUID(), epoch: hello.epoch, operationId: randomUUID(), method, params }))
    const [raw] = await response, result = JSON.parse(String(raw)); assert.equal(result.ok, true); return result.result
  } finally { socket.terminate() }
}
test('instance identity is shared across modes, data directories and ports within the application profile', () => {
  assert.throws(() => configuration('dev', { WEBNAV_PORT: '3030', WEBNAV_UI_PORT: '3030' }))
  assert.throws(() => configuration('dev', { WEBNAV_PORT: '999999' }))
  const first = configuration('dev'), second = configuration('start')
  assert.equal(first.pipe, second.pipe); assert.notEqual(first.url, second.url)
  const changed = configuration('start', {...process.env, WEBNAV_DATA_DIR: join(tmpdir(),'other-database'),WEBNAV_PORT:'3333'})
  assert.equal(first.pipe,changed.pipe);assert.equal(first.runtimeDirectory,changed.runtimeDirectory)
  const isolated = configuration('dev', {...process.env, LOCALAPPDATA:join(tmpdir(),'isolated-profile')})
  assert.notEqual(first.pipe,isolated.pipe)
})
test('Windows startup shortcut is opt-in, preserves paths and settings, and removes only its own entry', { skip: !windows, timeout: 40_000 }, async t => {
  const config = await testConfig(t), startup = join(config.directory, 'isolated startup'); await mkdir(startup)
  await writeFile(join(startup, 'unrelated.lnk'), 'preserve')
  assert.equal(await windowsAction(config, 'status', startup), false)
  await saveLaunchConfiguration(config)
  const saved = JSON.parse(await readFile(join(config.runtimeDirectory, 'launch.json'), 'utf8'))
  assert.equal(saved.environment.WEBNAV_DATA_DIR, config.directory)
  assert.equal(saved.node, process.execPath)
  assert.equal(await windowsAction(config, 'enable', startup), true)
  assert.equal(await windowsAction(config, 'status', startup), true)
  const shortcutPath = join(startup, `WebNav-${config.identity}.lnk`)
  // Read the real ShellLink, without launching a browser or altering the user's startup folder.
  const inspect = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::ReadLine(); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); [Console]::WriteLine($s.Arguments)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  let argumentsText = ''; inspect.stdout.setEncoding('utf8'); inspect.stdout.on('data', b => { argumentsText += b })
  inspect.stdin.end(shortcutPath + '\n'); await once(inspect, 'exit')
  assert.ok(argumentsText.includes('-WindowStyle Hidden'))
  assert.ok(argumentsText.includes('launch.ps1'))
  assert.ok(argumentsText.includes(config.directory))
  const bootstrap = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(windowsFiles(config), 'launch.ps1'), '-ConfigFile', join(config.runtimeDirectory, 'launch.json')], { windowsHide: true, stdio: 'ignore' })
  assert.equal((await once(bootstrap, 'exit'))[0], 0)
  await waitFor(async () => { try { return (await request(config, 'status')).state === 'running' } catch { return false } })
  assert.equal(await windowsAction(config, 'disable', startup), false)
  assert.deepEqual(await readdir(startup), ['unrelated.lnk'])
})
test('native tray owns both services, rejects unauthenticated control, deduplicates launches, restarts and exits', { skip: !windows, timeout: 100_000 }, async t => {
  const config = await testConfig(t)
  // Both commands racing on first startup must converge on the same named-pipe owner.
  const starts = await Promise.all([launch(config), launch(config)])
  for (const result of starts) assert.equal(result.code, 0, result.output)
  const initial = await request(config, 'status'); assert.equal(initial.state, 'running'); assert.equal(initial.autoStart, false)
  await waitFor(async()=>(await request(config,'status')).sessionSummary==='暂无运行')
  const changed = configuration('start',{...process.env,...config.environment,WEBNAV_DATA_DIR:join(config.directory,'unused-data'),WEBNAV_PORT:String(await freePort())})
  for(const entry of ['scripts/start.mjs','scripts/dev-worker.mjs','backend/src/main.ts','backend/dist/main.js']){
    const repeated=await repeatLaunch(changed,entry);assert.equal(repeated.code,0,repeated.output);assert.match(repeated.output,/已打开正在运行的 WebNav/)
    assert.equal((await request(config,'status')).workerPid,initial.workerPid)
  }
  const opened=(await readFile(join(config.runtimeDirectory,'opened-pages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(opened.length,5);assert.ok(opened.every(value=>value.url===config.url))
  await writeFile(join(config.runtimeDirectory,'fail-browser'),'fixture')
  const failedOpen=await repeatLaunch(changed)
  assert.equal(failedOpen.code,1);assert.match(failedOpen.output,/无法打开默认浏览器/)
  assert.equal((await readFile(join(config.runtimeDirectory,'opened-pages.jsonl'),'utf8')).trim().split('\n').length,6)
  assert.equal((await request(config,'status')).workerPid,initial.workerPid)
  await rm(join(config.runtimeDirectory,'fail-browser'))
  await assert.rejects(readFile(join(changed.directory,'webnav.sqlite')),{code:'ENOENT'})
  const denied = createConnection(config.pipe); await once(denied, 'connect')
  denied.write(JSON.stringify({ token: 'wrong', command: 'exit' }) + '\n'); await once(denied, 'close')
  assert.equal((await request(config, 'status')).pid, initial.pid)
  const catalog = { schemaVersion: 1, groups: [], servers: [{ id: 'saved', name: 'Tray lifecycle fixture', host: 'example.invalid', groupId: '', tags: [], note: '', favorite: false, connections: [{ id: 'ssh', name: 'SSH', type: 'ssh', port: 22, username: 'test', saveHistory: true },{id:'local',name:'Local test',type:'local',port:1,saveHistory:false,pluginSettings:{shell:'auto'}}] }] }
  await rpc(config, 'catalog.replace', { catalog, expectedRevision: 0 })
  const page=await fetch(config.url),cookie=page.headers.get('set-cookie').split(';')[0];await page.body?.cancel()
  const localOpened=await rpc(config,'connections.open',{serverId:'saved',connectionId:'local'},cookie)
  const terminal=new WebSocket(`ws://127.0.0.1:${config.port}/ws/terminal`,{origin:config.url.slice(0,-1),headers:{cookie}});t.after(()=>terminal.terminate())
  let parsed=0;terminal.on('message',(bytes,binary)=>{if(binary){parsed+=bytes.length;terminal.send(JSON.stringify({type:'terminal.ack',parsedBytes:parsed}))}})
  await once(terminal,'open');terminal.send(JSON.stringify({type:'terminal.attach',...localOpened}))
  await waitFor(async()=>(await request(config,'status')).sessions?.local===1)
  terminal.close();await once(terminal,'close');await delay(1200)
  assert.equal((await request(config,'status')).sessionSummary,'SSH 0 · RDP 0 · 本地终端 1')
  await rpc(config,'sessions.close',{sessionId:localOpened.sessionId},cookie)
  await waitFor(async()=>(await request(config,'status')).sessionSummary==='暂无运行')
  await request(config, 'restart')
  const restarted = await waitFor(async () => { const s = await request(config, 'status'); return s.state === 'running' && s.workerPid !== initial.workerPid && s })
  assert.equal(restarted.pid, initial.pid)
  assert.deepEqual((await rpc(config, 'catalog.watch')).snapshot, catalog)
  process.kill(restarted.workerPid)
  await waitFor(async () => (await request(config, 'status')).state === 'failed')
  await request(config, 'restart')
  await waitFor(async () => (await request(config, 'status')).state === 'running')
  assert.deepEqual((await rpc(config, 'catalog.watch')).snapshot, catalog)
  // A killed controller must not strand an invisible server; stale descriptor is recoverable.
  process.kill(initial.pid)
  await waitFor(async () => { try { await fetch(config.url); return false } catch { return true } })
  await waitFor(async () => { try { await fetch(`http://127.0.0.1:${config.port}/`); return false } catch { return true } })
  const recovered = await launch(config); assert.equal(recovered.code, 0, recovered.output)
  assert.deepEqual((await rpc(config, 'catalog.watch')).snapshot, catalog)
  await request(config, 'exit')
  await waitFor(async () => { try { await request(config, 'status'); return false } catch { return true } })
  await assert.rejects(fetch(config.url))
  await assert.rejects(fetch(`http://127.0.0.1:${config.port}/`))
})
test('a foreign occupied port remains untouched and tray can recover after it is released', { skip: !windows, timeout: 60_000 }, async t => {
  const config = await testConfig(t)
  const foreign = createServer(socket => { socket.resume(); socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') }).listen(config.port, '127.0.0.1')
  await once(foreign, 'listening'); t.after(() => { if (foreign.listening) foreign.close() })
  const result = await launch(config); assert.equal(result.code, 1)
  assert.equal((await request(config, 'status')).state, 'failed')
  assert.equal(foreign.listening, true)
  await new Promise(resolve => foreign.close(resolve))
  await request(config, 'restart')
  await waitFor(async () => (await request(config, 'status')).state === 'running')
})

test('a foreground production owner is reused by tray and console launches, then exits without leaving services', { skip: !windows, timeout: 40_000 }, async t => {
  const dev=await testConfig(t),config=configuration('start',{...process.env,...dev.environment})
  const child=spawn(process.execPath,['--experimental-strip-types',join(root,'backend/tests/instance-supervisor-fixture.mjs'),'start','--console'],{cwd:root,windowsHide:true,env:{...process.env,...config.environment},stdio:['ignore','ignore','ignore','ipc']})
  const exited=once(child,'exit')
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){if(child.connected)child.send('shutdown');const timer=setTimeout(()=>child.kill(),8000);await exited;clearTimeout(timer)}})
  const [initial]=await once(child,'message');assert.equal(initial.state,'running');assert.equal(initial.presentation,'console')
  for(const entry of ['scripts/dev.mjs','scripts/dev-worker.mjs']){
    const result=await repeatLaunch(dev,entry);assert.equal(result.code,0,result.output);assert.match(result.output,/已打开正在运行的 WebNav/)
  }
  const opened=(await readFile(join(config.runtimeDirectory,'opened-pages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(opened.length,2);assert.ok(opened.every(value=>value.url===config.url))
  assert.equal((await request(config,'status')).workerPid,initial.workerPid)
  child.send('shutdown');assert.equal((await exited)[0],0)
  await assert.rejects(fetch(config.url))
  await assert.rejects(request(config,'status'))
})
