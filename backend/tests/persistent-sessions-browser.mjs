// Real Edge, xterm, FreeRDP and noVNC; all targets and browser/app data are isolated.
import assert from 'node:assert/strict'
import {access,mkdtemp,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {chromium} from 'playwright-core'
import {automationFixture,waitFor} from './automation-fixture.mjs'
import {mockVnc} from './desktop-fixtures.mjs'

const directory=await mkdtemp(join(tmpdir(),'webnav-persistent-browser-')),vnc=await mockVnc({password:'test-vnc'})
let fixture,context,peer
try{
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r))
  const certificate=join(directory,'test.crt'),key=join(directory,'test.key')
  execFileSync(resolve('../.native-deps/openssl-install/bin/openssl.exe'),['req','-config','NUL','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','1','-subj','/CN=localhost'],{windowsHide:true,stdio:'ignore'})
  const events=[]
  peer=spawn(resolve('native/rdp/build/Release/webnav-rdp-test-peer.exe'),[String(port),certificate,key],{windowsHide:true,stdio:['ignore','pipe','ignore']})
  peer.stdout.on('data',bytes=>events.push(bytes.toString()));await waitFor(()=>events.join('').includes('listening'))
  fixture=await automationFixture({rdpEnabled:true})
  const doc=fixture.ctx.storage.snapshot()
  doc.snapshot.servers.push({id:'desktop',name:'Fixture desktop',host:'127.0.0.1',groupId:'',tags:[],note:'',favorite:false,connections:[{id:'rdp',name:'RDP',type:'rdp',port,username:'test',rdpOptions:{security:'tls'},rdpDisplay:{mode:'windowed',width:960,height:540}},{id:'vnc',name:'VNC',type:'vnc',port:vnc.port}]})
  fixture.ctx.storage.replace(doc.snapshot,doc.revision)
  fixture.ctx.credentials.prepareDesktopPasswords([{serverId:'desktop',connectionId:'rdp',secret:'test-rdp'},{serverId:'desktop',connectionId:'vnc',secret:'test-vnc'}],doc.snapshot)()
  let executablePath
  for(const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'])try{await access(path);executablePath=path;break}catch{}
  const errors=[]
  const open=async()=>{context=await chromium.launchPersistentContext(join(directory,'browser'),{executablePath,headless:true,viewport:{width:1360,height:900}});const page=context.pages()[0]??await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(fixture.origin);return page}
  let page=await open()
  const directoryTab=()=>page.getByRole('tab',{name:/服务器目录/})
  const pane=label=>page.getByRole('region',{name:label,exact:true,includeHidden:true})
  const connected=label=>waitFor(async()=>(await pane(label).locator('.terminal-status').innerText()).includes('已连接'),15000)
  await page.getByRole('button',{name:'Fixture alpha SSH',exact:true}).click();await connected('终端 Fixture alpha · SSH')
  await directoryTab().click();await page.getByRole('button',{name:'Fixture beta SSH',exact:true}).click();await connected('终端 Fixture beta · SSH')
  await page.getByRole('tab',{name:/Fixture alpha · SSH/}).click({button:'right'})
  await page.getByRole('menuitem',{name:'左右分屏',exact:true}).click()
  await waitFor(()=>page.locator('.terminal-window.is-split').count().then(n=>n===2))
  await directoryTab().click();await page.getByRole('button',{name:'Fixture desktop RDP',exact:true}).click();await connected('桌面 Fixture desktop · RDP')
  await directoryTab().click();await page.getByRole('button',{name:'Fixture desktop VNC',exact:true}).click();await connected('桌面 Fixture desktop · VNC')
  const initialIds=await page.locator('.terminal-window').evaluateAll(nodes=>nodes.map(n=>n.id).sort())
  assert.equal(fixture.stats.shells,2);assert.equal(fixture.ctx.desktops.size,2)
  const vncConnections=vnc.events.filter(e=>e[0]==='connection').length,rdpConnections=events.join('').split('activated').length
  const cookie=(await context.cookies()).find(c=>c.name===fixture.ctx.auth.cookieName),owner=fixture.ctx.auth.session(`${cookie.name}=${cookie.value}`).id
  await waitFor(()=>fixture.ctx.transport.workspaces.get(owner)?.view.groups.length===3)
  await page.reload()
  for(const label of ['终端 Fixture alpha · SSH','终端 Fixture beta · SSH','桌面 Fixture desktop · RDP','桌面 Fixture desktop · VNC'])await connected(label)
  assert.deepEqual(await page.locator('.terminal-window').evaluateAll(nodes=>nodes.map(n=>n.id).sort()),initialIds)
  assert.equal(fixture.stats.shells,2);assert.equal(vnc.events.filter(e=>e[0]==='connection').length,vncConnections);assert.equal(events.join('').split('activated').length,rdpConnections)
  await context.close();context=undefined
  assert.equal(fixture.ctx.sessions.size,2);assert.equal(fixture.ctx.desktops.size,2)
  for(const stream of fixture.streams)stream.write('\r\nBROWSER-CLOSED-CONTINUES\r\n')
  await waitFor(()=>[...fixture.ctx.sessions.sessions.values()].every(s=>s.terminal.terminal.buffer.active.getLine(s.terminal.terminal.buffer.active.cursorY+s.terminal.terminal.buffer.active.baseY-1)?.translateToString().includes('BROWSER-CLOSED-CONTINUES')))
  page=await open()
  for(const label of ['终端 Fixture alpha · SSH','终端 Fixture beta · SSH','桌面 Fixture desktop · RDP','桌面 Fixture desktop · VNC'])await connected(label)
  assert.deepEqual(await page.locator('.terminal-window').evaluateAll(nodes=>nodes.map(n=>n.id).sort()),initialIds)
  assert.equal(fixture.stats.shells,2);assert.equal(vnc.events.filter(e=>e[0]==='connection').length,vncConnections);assert.equal(events.join('').split('activated').length,rdpConnections)
  await page.getByRole('tab',{name:/Fixture alpha · SSH/}).click()
  assert.equal(await page.locator('.terminal-window.is-split:visible').count(),2)
  await pane('终端 Fixture alpha · SSH').locator('.xterm-helper-textarea').focus();await page.keyboard.type('after-browser-restart')
  await waitFor(()=>fixture.stats.inputs.join('').includes('after-browser-restart'))
  const screenshots=resolve('../docs/design/screenshots');await mkdir(screenshots,{recursive:true})
  await page.getByRole('tab',{name:/Fixture desktop · VNC/}).click()
  await waitFor(()=>pane('桌面 Fixture desktop · VNC').locator('canvas').evaluate(canvas=>{const c=canvas.getContext('2d');return c&&c.getImageData(100,100,1,1).data[3]===255}))
  await page.screenshot({path:join(screenshots,'persistent-vnc-workspace.png')})
  await page.getByRole('tab',{name:/Fixture alpha · SSH/}).click()
  await page.screenshot({path:join(screenshots,'persistent-terminal-workspace.png')})
  await page.getByRole('tab',{name:/Fixture desktop · RDP/}).click();await page.screenshot({path:join(screenshots,'persistent-rdp-workspace.png')})
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(screenshots,'persistent-workspace-mobile.png')})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await page.setViewportSize({width:1360,height:900})
  // The close action owns lifetime; view unmount and browser shutdown do not.
  await page.getByRole('button',{name:'关闭整组终端 Fixture alpha · SSH',exact:true}).click()
  await page.getByRole('button',{name:'关闭桌面 Fixture desktop · RDP',exact:true}).click()
  await page.getByRole('button',{name:'关闭桌面 Fixture desktop · VNC',exact:true}).click()
  await waitFor(()=>fixture.ctx.sessions.size===0&&fixture.ctx.desktops.size===0&&vnc.sockets.size===0)
  assert.deepEqual(errors,[])
  console.log('Browser persistence passed: same SSH PTYs / native RDP / VNC across reload and browser restart; split layout, background output, input, 390px and release.')
}finally{
  await context?.close();await fixture?.close();await vnc.close()
  if(peer&&peer.exitCode===null){const exited=once(peer,'exit');peer.kill();await exited}
  if(!/^webnav-persistent-browser-[\w-]+$/.test(relative(tmpdir(),directory)))throw new Error('Unexpected test directory')
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
