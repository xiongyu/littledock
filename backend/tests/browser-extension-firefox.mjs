// Requires Mozilla's web-ext CLI (WEBNAV_WEB_EXT_CLI). Uses a fresh temporary Firefox profile.
import { mkdtemp, cp, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'

if (!process.env.WEBNAV_WEB_EXT_CLI) throw new Error('Set WEBNAV_WEB_EXT_CLI to Mozilla web-ext/bin/web-ext.js')
const root = resolve(import.meta.dirname, '../..'), directory = await mkdtemp(join(tmpdir(), 'webnav-extension-firefox-'))
let app, processHandle, siteServer, messages
try {
  siteServer = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"></form>') })
  siteServer.listen(0, '127.0.0.1'); await once(siteServer, 'listening')
  const sitePort = siteServer.address().port, siteOrigin = `http://webnav-extension.test:${sitePort}`
  messages = new WebSocketServer({ server: siteServer, maxPayload: 4000 })
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  app = await createApp({ directory: join(directory, 'data'), port, frontendRoot: join(root, 'frontend/dist'), disablePlugins: true, webCapture: async () => Buffer.from([255,216,255,217]) })
  app.webBookmarks.save({ bookmark: { id: 'firefox', name: 'Firefox local fixture', url: `https://webnav-extension.test:${sitePort}/` }, expectedVersion: 0, login: { username: 'fixture-firefox', password: 'fixture-firefox-secret' } })
  const token = app.auth.create(), owner = app.auth.session(`${app.auth.cookieName}=${token}`).id
  const pairing = await app.browserExtension.begin(owner, { name: 'Firefox fixture' }, crypto.randomUUID())
  const source = join(directory, 'extension'); await cp(join(root, 'extension/dist/firefox'), source, { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  // This hostname maps to loopback only in the isolated test profile, exercising non-secure HTTP.
  manifest.host_permissions.push('http://webnav-extension.test/*', 'https://webnav-extension.test/*')
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  const harness = `(async()=>{
    console.error('WEBNAV TEST: popup loaded');
    const report=new WebSocket(${JSON.stringify(`ws://127.0.0.1:${sitePort}/`)});
    console.error('WEBNAV TEST: report socket constructed');
    await new Promise((r,j)=>{report.onopen=r;report.onerror=()=>j(new Error('Report WebSocket failed'));setTimeout(()=>j(new Error('Report WebSocket timed out')),8000)});
    try{
      console.error('WEBNAV TEST: report connected');
      const call=async(type,params={})=>{const reply=await browser.runtime.sendMessage({type,...params});if(!reply.ok)throw new Error(reply.error);return reply.result};
      await call('pair',{code:${JSON.stringify(pairing.code)}});
      console.error('WEBNAV TEST: paired');
      const tab=await browser.tabs.create({url:${JSON.stringify(siteOrigin + '/')},active:true});
      const loaded=()=>new Promise(resolve=>{const check=async()=>{const current=await browser.tabs.get(tab.id);if(current.status==='complete'&&current.url?.startsWith(${JSON.stringify(siteOrigin)})){browser.tabs.onUpdated.removeListener(listener);resolve()}};const listener=(id)=>{if(id===tab.id)void check()};browser.tabs.onUpdated.addListener(listener);void check()});
      await loaded();console.error('WEBNAV TEST: fixture loaded');
      console.error('WEBNAV TEST permissions',JSON.stringify(await browser.permissions.getAll()));
      const matches=await call('matches',{tabId:tab.id,origin:${JSON.stringify(siteOrigin)}});
      if(matches.matches.length!==1)throw new Error('No exact site match');
      await call('manualFill',{tabId:tab.id,origin:${JSON.stringify(siteOrigin)},bookmarkId:'firefox',automatic:true});
      console.error('WEBNAV TEST: manual fill finished');
      const read=async()=>{const results=await browser.scripting.executeScript({target:{tabId:tab.id},func:()=>!isSecureContext&&document.querySelector('#username').value==='fixture-firefox'&&document.querySelector('#password').value==='fixture-firefox-secret'});return results[0].result};
      if(!await read())throw new Error('Manual fill failed');
      await browser.tabs.update(tab.id,{active:true});
      // Firefox restores the username on reload, while passwords are cleared. The extension
      // intentionally preserves non-empty inputs; empty the fixture before testing automatic fill.
      await browser.scripting.executeScript({target:{tabId:tab.id},func:()=>{document.querySelector('#username').value='';document.querySelector('#password').value=''}});
      const reloaded=new Promise(resolve=>{const listener=(id,change)=>{if(id===tab.id&&change.status==='complete'){browser.tabs.onUpdated.removeListener(listener);resolve()}};browser.tabs.onUpdated.addListener(listener)});
      await browser.tabs.reload(tab.id);await reloaded;
      const checked=await browser.scripting.executeScript({target:{tabId:tab.id},func:async()=>{for(let i=0;i<40;i++){if(document.querySelector('#password').value==='fixture-firefox-secret')return true;await new Promise(r=>setTimeout(r,200))}return false}});
      const filled=checked[0].result;
      if(!filled){
        const state=await browser.scripting.executeScript({target:{tabId:tab.id},func:()=>({usernameLength:document.querySelector('#username').value.length,passwordLength:document.querySelector('#password').value.length,visibility:document.visibilityState})});
        const probe=await browser.tabs.sendMessage(tab.id,{type:'webnav.probe'},{frameId:0}).catch(()=>({missing:true}));
        console.error('WEBNAV TEST auto state',JSON.stringify({state:state[0].result,probe,scripts:await browser.scripting.getRegisteredContentScripts()}));
        throw new Error('Automatic fill failed');
      }
      const captured=await call('capturePage',{tabId:tab.id,origin:${JSON.stringify(siteOrigin)}});
      if(!captured.captured||captured.username!=='fixture-firefox'||captured.password!=='fixture-firefox-secret')throw new Error('Capture preview failed: found='+captured.captured+', usernameMatch='+(captured.username==='fixture-firefox')+', passwordMatch='+(captured.password==='fixture-firefox-secret'));
      const saved=await call('savePage',{captureId:captured.captureId,targetId:'',name:'Firefox saved fixture',url:captured.url,login:{username:captured.username,password:captured.password}});
      const next=await call('capturePage',{tabId:tab.id,origin:${JSON.stringify(siteOrigin)}});
      if(!next.targets.some(target=>target.id===saved.bookmarkId))throw new Error('Saved bookmark missing');
      await call('savePage',{captureId:next.captureId,targetId:saved.bookmarkId,name:'Firefox updated fixture',url:next.url,login:{username:'firefox-updated',password:'firefox-updated-secret'}});
      report.send(JSON.stringify({ok:true,checks:['Firefox temporary install','mutual pairing','HTTP page matches HTTPS bookmark','manual fill','automatic fill after reload','capture filled form','save and update bookmark']}));
    }catch(error){console.error('WEBNAV TEST step failed',error.message);report.send(JSON.stringify({ok:false,error:String(error)}))}
    setTimeout(()=>browser.runtime.sendMessage({type:'forget'}),100);
  })().catch(error=>console.error('WEBNAV TEST harness',error.message));`
  await writeFile(join(source, 'test-harness.js'), harness)
  const popup = await readFile(join(source, 'popup.html'), 'utf8'); await writeFile(join(source, 'popup.html'), popup.replace('</body>', '<script src="test-harness.js"></script></body>'))
  await appendFile(join(source, 'background.js'), '\nconsole.error("WEBNAV TEST: background loaded");setTimeout(()=>browser.tabs.create({url:browser.runtime.getURL("popup.html")}).catch(e=>console.error("WEBNAV TEST popup",e.message)),500);\n')
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox extension acceptance timed out')), 30_000)
    messages.on('connection', ws => ws.on('message', raw => { clearTimeout(timer); resolve(JSON.parse(raw.toString())) }))
  })
  const logs = []
  processHandle = spawn(process.execPath, [process.env.WEBNAV_WEB_EXT_CLI, 'run', '--no-config-discovery', '--no-reload', '--no-input', '--verbose', '--pref=devtools.console.stdout.chrome=true', '--pref=devtools.console.stdout.content=true', '--pref=network.dns.localDomains=webnav-extension.test', '--pref=network.proxy.type=0', '--source-dir', source, '--firefox', process.env.WEBNAV_TEST_FIREFOX ?? 'C:/Program Files/Mozilla Firefox/firefox.exe', '--args=-headless'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  processHandle.stdout.on('data', data => logs.push(data.toString())); processHandle.stderr.on('data', data => logs.push(data.toString()))
  let outcome
  try { outcome = await result } catch (error) { console.error(logs.join('').split('\n').filter(line=>/WEBNAV TEST|moz-extension|SecurityError|test-harness|background\.js|temporary add-on|WebSocket|websocket|Content-Security|insecure|blocked/.test(line)).join('\n').slice(-6000)); throw error }
  if(!outcome.ok)console.error(logs.join('').split('\n').filter(line=>/WEBNAV TEST/.test(line)).join('\n'))
  assert.equal(outcome.ok, true, outcome.error)
  assert.ok(app.browserExtension.status().devices[0].origin.startsWith('moz-extension://'))
  const saved = app.webBookmarks.snapshot().bookmarks.find(b => b.name === 'Firefox updated fixture')
  assert.ok(saved); assert.equal(app.webBookmarks.snapshot().bookmarks.length, 2)
  assert.deepEqual(app.credentials.bookmarkLogin(saved.id), { username: 'firefox-updated', password: 'firefox-updated-secret' })
  console.log(JSON.stringify(outcome, null, 2))
} finally {
  if (processHandle) {
    // Terminate only the helper and its isolated browser children, never existing Firefox instances.
    if (process.platform === 'win32') await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('close', resolve) })
    else processHandle.kill('SIGTERM')
    if (processHandle.exitCode === null) await once(processHandle, 'exit').catch(() => {})
  }
  for (const ws of messages?.clients ?? []) ws.terminate()
  messages?.close(); await app?.stop()
  if (siteServer) { siteServer.closeAllConnections(); await new Promise(resolve => siteServer.close(resolve)) }
  assert.ok(directory.startsWith(join(tmpdir(), 'webnav-extension-firefox-')))
  await rm(directory, { recursive: true, force: true })
}
