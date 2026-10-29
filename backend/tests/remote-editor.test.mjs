import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import yazl from 'yazl'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import ssh2 from 'ssh2'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from 'cordis'
import { RemoteEditorService } from '../src/plugins/remote-editor/index.ts'
import { EditorPackageCache, editorPackages } from '../src/plugins/remote-editor/packages.ts'
import { shQuote, psQuote, powershell, windowsPath, installCommand, launchCommand, listeningPort, execRemote } from '../src/plugins/remote-editor/remote.ts'
import { editorGateway } from '../src/plugins/remote-editor/proxy.ts'
import { configureWorkbench } from '../src/plugins/remote-editor/workbench.ts'
import { editorErrorMessage } from '../src/plugins/remote-editor/errors.ts'
import { SshFilesService } from '../src/plugins/ssh-files/index.ts'
import { writableSftp, seedRemoteFiles } from './writable-sftp-fixture.mjs'

const digest=data=>createHash('sha256').update(data).digest('hex')
async function temp(t){const root=await mkdtemp(join(tmpdir(),'webnav-editor-test-'));t.after(async()=>{assert.match(relative(tmpdir(),root),/^webnav-editor-test-[\w-]+$/);await rm(root,{recursive:true,force:true})});return root}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve())})
async function http(url,headers={},method='GET'){return new Promise((resolve,reject)=>{const req=request(url,{headers,method},res=>{const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}))});req.on('error',reject);req.end()})}
async function wait(check){for(let i=0;i<200;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,30))}assert.fail('condition timed out')}

test('editor package cache verifies digests, reuses offline packages, coalesces downloads and discards broken partials',async t=>{
  const root=await temp(t),payload=Buffer.from('test editor archive');let hits=0
  const server=createServer((_req,res)=>{hits++;res.writeHead(200,{'content-length':payload.length});res.end(payload)})
  const port=await listen(server);t.after(()=>close(server))
  const pkg={...editorPackages['linux-x64'],file:'fixture.tar.gz',sha256:digest(payload),url:`http://127.0.0.1:${port}/archive`},cache=new EditorPackageCache(root),signal=new AbortController().signal
  const paths=await Promise.all([cache.ensure(pkg,signal),cache.ensure(pkg,signal)])
  assert.equal(paths[0],paths[1]);assert.equal(hits,1);assert.deepEqual(await readFile(paths[0]),payload)
  await cache.ensure(pkg,signal);assert.equal(hits,1)
  await writeFile(paths[0],'corrupt');await assert.rejects(cache.ensure(pkg,signal),/校验/);assert.equal(hits,1)
  await assert.rejects(cache.ensure({...pkg,file:'bad.tar.gz',sha256:'0'.repeat(64)},signal),/校验/)
  assert.equal((await readdir(root)).some(name=>name.endsWith('.part')),false)
})

test('remote scripts quote paths, use verified archives and bind only loopback with a watchdog',()=>{
  assert.equal(shQuote("/home/a'b$()"),"'/home/a'\\''b$()'");assert.equal(psQuote("C:/a'b"),"'C:/a''b'")
  assert.equal(windowsPath('/C:/Users/用户'),'C:\\Users\\用户')
  const ps=powershell("Write-Output '中文'");assert.ok(Buffer.from(ps.split(' ').at(-1),'base64').toString('utf16le').includes('中文'))
  for(const pkg of Object.values(editorPackages))assert.match(installCommand(pkg,"/home/quote'$/pkg",'/home/stage','/home/editor'),pkg.platform.startsWith('windows')?/EncodedCommand/:/sha256sum/)
  const linux=launchCommand(editorPackages['linux-x64'],'/a','/b','/c');assert.match(linux,/setsid/);assert.match(linux,/heartbeat/);assert.match(linux,/45/)
  const win=Buffer.from(launchCommand(editorPackages['windows-x64'],'/C:/a','/C:/b','/C:/c').split(' ').at(-1),'base64').toString('utf16le');assert.match(win,/CreateNoWindow=\$true/);assert.match(win,/--host 127.0.0.1/);assert.match(win,/--connection-token-file/)
  assert.equal(listeningPort('[info] HTTP server listening on http://127.0.0.1:41234/'),41234)
  assert.equal(listeningPort('Extension host agent listening on 43210'),43210);assert.equal(listeningPort('http://evil:1234'),undefined)
})

test('installer output is drained without aborting on progress volume; failed exits remain failures',async()=>{
  function command(code){const client=new EventEmitter();client.exec=(_command,ready)=>{const channel=new EventEmitter();channel.stderr=new PassThrough();channel.close=()=>{};ready(null,channel);queueMicrotask(()=>{for(let i=0;i<80;i++){channel.emit('data',Buffer.alloc(8192,65));channel.stderr.write(Buffer.alloc(8192,66))}channel.stderr.write('disk write denied');channel.emit('close',code)})};return client}
  assert.equal(await execRemote(command(0),'install',new AbortController().signal,1000,'drain'),'')
  await assert.rejects(execRemote(command(7),'install',new AbortController().signal,1000,'drain'),/远端命令执行失败.*7/)
  await assert.rejects(execRemote(command(0),'probe',new AbortController().signal,1000),/远端响应过大/)
})

test('VS Code bootstrap carries a per-page token without cookies or script injection',()=>{
  const html='<meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;127.0.0.1:1234&quot;}">'
  const result=configureWorkbench(html,'test-token')
  assert.match(result,/&quot;connectionToken&quot;:&quot;test-token&quot;/)
  assert.match(result,/127.0.0.1:1234/)
  assert.doesNotMatch(configureWorkbench(html,'"><script>'),/<script>/)
  assert.throws(()=>configureWorkbench('<html/>','test'),/配置缺失/)
})

async function runPowerShell(command){
  const args=command.split(' ').slice(1),child=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PSModulePath:join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')}})
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d)
  const timer=setTimeout(()=>child.kill(),30_000),[code]=await once(child,'exit');clearTimeout(timer);assert.equal(code,0,err.slice(-2000));return {out,err}
}
test('Windows PowerShell suppresses XML progress and publishes a complete marker while preserving an incomplete install',{skip:process.platform!=='win32'},async t=>{
  const progress=await runPowerShell(powershell("for($i=0;$i -lt 500;$i++){Write-Progress -Activity 'Installing' -PercentComplete ($i%100)}; [Console]::WriteLine('done')"))
  assert.equal(progress.out.trim(),'done');assert.equal(progress.err,'')
  const root=await temp(t),archive=join(root,'archive.zip'),stage=join(root,'stage-fixture'),dest=join(root,'1.143.1')
  const zip=new yazl.ZipFile(),file=createWriteStream(archive);zip.outputStream.pipe(file);zip.addBuffer(Buffer.from('fixture'),editorPackages['windows-x64'].root+'/node.exe');zip.addBuffer(Buffer.from('fixture'),editorPackages['windows-x64'].root+'/out/server-main.js');zip.end();await once(file,'close')
  await mkdir(dest);await writeFile(join(dest,'preserve.txt'),'old partial contents')
  const pkg={...editorPackages['windows-x64'],sha256:digest(await readFile(archive))}
  await runPowerShell(installCommand(pkg,...[archive,stage,dest].map(path=>path.replace(/\\/g,'/'))))
  assert.deepEqual(JSON.parse(await readFile(join(dest,'webnav-install.json'),'utf8')),{sha256:pkg.sha256,licenseAccepted:true})
  assert.equal(await readFile(join(dest+'.incomplete-stage-fixture','preserve.txt'),'utf8'),'old partial contents')
  assert.equal(await readFile(join(dest,'out/server-main.js'),'utf8'),'fixture')
})

test('editor gateway transports HTTP and WebSocket over a real SSH forward with owner, Host, Origin and cookie isolation',async t=>{
  let seen,forwards=0
  const remote=createServer((req,res)=>{
    seen=req
    // Match VS Code's root handler: a query token always redirects to a clean
    // URL. The gateway must authenticate via its own upstream cookie instead.
    if(new URL(req.url,'http://fixture').searchParams.has('tkn')){res.writeHead(302,{location:'/'}).end();return}
    if(req.headers.cookie!=='vscode-tkn=private-editor-token'){res.writeHead(401).end();return}
    if(req.url.includes('bootstrap')){res.writeHead(200,{'content-type':'text/html','set-cookie':'unexpected=remote; Path=/'});res.end('<meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;fixture&quot;}">');return}
    res.end('editor workbench')
  })
  const wss=new WebSocketServer({server:remote});wss.on('connection',ws=>ws.on('message',data=>ws.send(data)))
  const remotePort=await listen(remote),host=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}),peers=new Set()
  const ssh=new ssh2.Server({hostKeys:[host.privateKey]},peer=>{peers.add(peer);peer.on('error',()=>{});peer.on('authentication',ctx=>ctx.accept());peer.on('tcpip',(accept,reject,info)=>{if(info.destIP!=='127.0.0.1'||info.destPort!==1){reject();return}forwards++;const socket=connect(remotePort,'127.0.0.1',()=>{const ch=accept();ch.pipe(socket).pipe(ch);ch.on('close',()=>socket.destroy());socket.on('close',()=>ch.destroy());ch.on('error',()=>{})});socket.on('error',()=>{})})})
  const sshPort=await listen(ssh),client=new ssh2.Client();client.on('error',()=>{});client.connect({host:'127.0.0.1',port:sshPort,username:'fixture'});await once(client,'ready')
  // The logical remote port deliberately differs from the local fixture port.
  // Connecting locally by mistake can no longer make this test pass.
  const gateway=await editorGateway(client,1,'private-editor-token',cookie=>cookie==='owner=allowed')
  t.after(async()=>{await gateway.close();client.destroy();for(const peer of peers)peer.end();await close(ssh);for(const ws of wss.clients)ws.terminate();wss.close();await close(remote)})
  assert.equal((await http(gateway.url)).status,403)
  assert.equal((await http(gateway.url,{cookie:'owner=allowed',origin:'https://evil.invalid'})).status,403)
  assert.equal((await http(gateway.url,{cookie:'owner=allowed',host:'evil.invalid'})).status,403)
  const marketplace=gateway.url+'/_webnav/marketplace/extensionquery'
  assert.equal((await http(marketplace,{},'POST')).status,403)
  assert.equal((await http(marketplace,{cookie:'owner=allowed'},'POST')).status,403)
  assert.equal((await http(marketplace,{cookie:'owner=allowed',origin:'https://evil.invalid'},'POST')).status,403)
  assert.equal((await http(marketplace,{cookie:'owner=allowed'})).status,405)
  const result=await http(gateway.url+'/?folder=/test',{cookie:'owner=allowed'})
  assert.equal(result.status,200);assert.equal(result.body,'editor workbench');assert.equal(seen.headers.cookie,'vscode-tkn=private-editor-token');assert.equal(new URL(seen.url,'http://test').searchParams.has('tkn'),false);assert.ok(forwards>0)
  const bootstrap=await http(gateway.url+'/?bootstrap=1',{cookie:'owner=allowed'})
  assert.equal(bootstrap.status,200);assert.match(bootstrap.body,/&quot;connectionToken&quot;:&quot;private-editor-token&quot;/)
  assert.equal(bootstrap.headers['set-cookie'],undefined);assert.equal(bootstrap.headers['cache-control'],'no-store')
  const ws=new WebSocket(gateway.url.replace('http','ws'),{headers:{cookie:'owner=allowed',origin:gateway.url}});await once(ws,'open');ws.send('test frame');assert.equal((await once(ws,'message'))[0].toString(),'test frame')
  const closed=once(ws,'close');await gateway.close();await closed;await assert.rejects(http(gateway.url,{cookie:'owner=allowed'}))
})

async function serviceFixture(t,platform='linux-x64'){
  const root=await temp(t),home=await seedRemoteFiles(root),pkg=editorPackages[platform],archive=join(root,'test-package');await writeFile(archive,Buffer.alloc(128*1024+333,77))
  const remote=createServer((_req,res)=>res.end('test editor'));const remotePort=await listen(remote)
  const host=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}),peers=new Set(),channels=new Set();let installs=0,starts=0,downloads=0
  const ssh=new ssh2.Server({hostKeys:[host.privateKey]},peer=>{peers.add(peer);peer.on('error',()=>{});peer.on('authentication',ctx=>ctx.accept());peer.on('tcpip',(accept)=>{const ch=accept(),socket=connect(remotePort,'127.0.0.1');ch.pipe(socket).pipe(ch);ch.on('error',()=>{});socket.on('error',()=>{});ch.on('close',()=>socket.destroy())});peer.on('ready',()=>peer.on('session',accept=>{
    const session=accept();writableSftp(session,root,{maxWriteSize:32*1024})
    session.on('exec',(accept,_reject,info)=>{const ch=accept();channels.add(ch);ch.on('error',()=>{});ch.on('close',()=>channels.delete(ch));void(async()=>{
      let cmd=info.command;if(cmd.startsWith('powershell.exe'))cmd=Buffer.from(cmd.split(' ').at(-1),'base64').toString('utf16le')
      if(cmd.includes('uname -s')){if(platform.startsWith('linux'))ch.write('Linux\nx86_64\n');else{ch.exit(1);ch.end();return}}
      else if(cmd.includes('PROCESSOR_ARCHITECTURE'))ch.write('AMD64\n')
      else if(cmd.includes('sha256sum')||cmd.includes('Get-FileHash')){installs++;const dest=join(home,'.webnav-editor',platform,pkg.version);await mkdir(dest,{recursive:true});await writeFile(join(dest,'webnav-install.json'),JSON.stringify({sha256:pkg.sha256,licenseAccepted:!!pkg.licenseUrl}))}
      else if(cmd.includes('setsid')||cmd.includes('ProcessStartInfo')){starts++;ch.write(platform.startsWith('linux')?`[info] HTTP server listening on http://127.0.0.1:${remotePort}/\n`:`Extension host agent listening on ${remotePort}\n`);return}
      else throw new Error('unexpected command')
      ch.exit(0);ch.end()
    })().catch(()=>{ch.exit(1);ch.end()})})
  }))})
  const sshPort=await listen(ssh),client=new ssh2.Client();client.on('error',()=>{});client.connect({host:'127.0.0.1',port:sshPort,username:'fixture'});await once(client,'ready')
  const ctx=new Context(),watchers=new Set();let locked=false
  ctx.set('credentials',{requireUnlocked(){if(locked)throw new Error('locked')},status:()=>({unlocked:!locked}),subscribe(fn){watchers.add(fn);return()=>watchers.delete(fn)}})
  ctx.set('sessions',{owned(owner,id){if(owner!=='owner'||id!=='session')throw new Error('not owner');return {client,channel:{},closed:false}},directory(){return {path:'',revision:0}}})
  ctx.set('sshInspector',{invalidateFiles(){}});ctx.set('auth',{authorized:owner=>owner==='owner',session:cookie=>cookie==='owner=allowed'?{id:'owner'}:undefined})
  ctx.plugin(SshFilesService);ctx.plugin(RemoteEditorService,{directory:root,cache:{async ensure(_pkg,_signal,report){downloads++;report(100);return archive}}});await ctx.start()
  t.after(async()=>{await ctx.stop();client.destroy();for(const ch of channels)ch.close();for(const peer of peers)peer.end();await close(ssh);await close(remote)})
  return {ctx,client,service:ctx.remoteEditor,stats:()=>({installs,starts,downloads}),lock(){locked=true;for(const fn of watchers)fn({unlocked:false})}}
}
for(const platform of ['linux-x64','windows-x64'])test(`${platform}: prepare is read-only, install/start is explicit, credentials stay remote, saved install is reused and locking releases the gateway`,async t=>{
  const {service,stats,lock}=await serviceFixture(t,platform),input={sessionId:'session',folder:'/home/fixture/projects'}
  const first=service.prepare('owner',input)
  assert.equal(service.prepare('owner',input).id,first.id)
  const status=()=>service.status('owner',{id:first.id});await wait(()=>status().state==='needs-install')
  assert.equal(stats().installs,0);assert.throws(()=>service.status('other',{id:first.id}),/不存在/)
  if(platform.startsWith('windows'))assert.throws(()=>service.install('owner',{id:first.id}),/条款/)
  service.install('owner',{id:first.id,acceptLicense:true});await wait(()=>status().state==='ready'||status().state==='error');assert.equal(status().state,'ready',status().message)
  const url=status().url;assert.equal((await http(url,{cookie:'owner=allowed'})).body,'test editor');assert.equal(new URL(url).searchParams.has('tkn'),false)
  assert.equal(stats().installs,1);await service.stopOwned('owner',{id:first.id});await assert.rejects(http(url,{cookie:'owner=allowed'}))
  const second=service.prepare('owner',input);await wait(()=>service.status('owner',{id:second.id}).state==='ready');assert.equal(stats().installs,1);assert.equal(stats().downloads,1)
  const newUrl=service.status('owner',{id:second.id}).url;lock();await wait(async()=>{try{await http(newUrl,{cookie:'owner=allowed'});return false}catch{return true}})
})

test('editor failures retain their stage and explain SFTP status instead of returning raw Failure',()=>{
  assert.match(editorErrorMessage(Object.assign(new Error('Failure'),{code:4}),'uploading'),/上传安装包失败.*SFTP.*4/)
  assert.match(editorErrorMessage(Object.assign(new Error('Permission denied'),{code:3}),'installing'),/安装远端编辑器失败.*权限/)
  assert.match(editorErrorMessage(new Error('Failure'),'checking'),/检查远端环境失败/)
  assert.doesNotMatch(editorErrorMessage(new Error('Failure'),'checking'),/Failure/)
})

test('SSH disconnection stops the editor and cancellation while checking never installs',async t=>{
  const {service,client,stats}=await serviceFixture(t),input={sessionId:'session',folder:'/home/fixture/projects'}
  const cancelled=service.prepare('owner',input)
  await service.stopOwned('owner',{id:cancelled.id})
  assert.equal(service.status('owner',{id:cancelled.id}).state,'stopped');assert.equal(stats().installs,0)
  const running=service.prepare('owner',input),status=()=>service.status('owner',{id:running.id})
  await wait(()=>status().state==='needs-install');service.install('owner',{id:running.id})
  await wait(()=>status().state==='ready');const url=status().url
  client.destroy();await wait(()=>status().state==='stopped')
  await wait(async()=>{try{await http(url,{cookie:'owner=allowed'});return false}catch{return true}})
})
