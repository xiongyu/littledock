import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto'
import { ZipFile } from 'yazl'
import { HostUpdater } from '../src/desktop/updater.ts'
import { verifiedManifest, sourceConfig, extractRelease, readInstallation, releasePageManifest, updateRedirect } from '../src/desktop/update-files.ts'
import { Context } from 'cordis'
import { MaintenanceService } from '../src/core/maintenance.ts'

const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'pem',type:'spki'}).toString()
const info=version=>({schemaVersion:1,version,platform:process.platform,arch:process.arch,dataVersion:1,minLauncherVersion:1})
const envelope=manifest=>{const payload=Buffer.from(JSON.stringify(manifest));return Buffer.from(JSON.stringify({payload:payload.toString('base64'),signature:sign(null,Buffer.concat([Buffer.from('webnav-update-v1\0'),payload]),keys.privateKey).toString('base64')}))}
async function archive(version){const zip=new ZipFile();zip.addBuffer(Buffer.from(JSON.stringify(info(version))),'release.json');for(const file of ['backend/dist/main.js','backend/dist/desktop/supervisor.js','frontend/dist/index.html',process.platform==='win32'?'runtime/node.exe':'runtime/node'])zip.addBuffer(Buffer.from('fixture'),file);zip.end();const chunks=[];for await(const chunk of zip.outputStream)chunks.push(chunk);return Buffer.concat(chunks)}
async function until(fn){for(let i=0;i<500;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20))}throw new Error('update timeout')}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'webnav-update-')),bytes=await archive('1.0.1')
 let feed,requests=0,damaged=false
 const server=createServer((req,res)=>{if(req.url==='/feed.json'){requests++;res.end(feed)}else res.end(damaged?Buffer.from('bad'):bytes)}).listen(0,'127.0.0.1');await once(server,'listening')
 const url=`http://127.0.0.1:${server.address().port}/feed.json`,source={feed:url,publicKey,channel:'stable'}
 const manifest={...info('1.0.1'),url:new URL('update.zip',url).href,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),notes:'更新说明',publishedAt:Date.now(),expiresAt:Date.now()+86400000};feed=envelope(manifest)
 await mkdir(join(root,'releases/1.0.0'),{recursive:true});await writeFile(join(root,'releases/1.0.0/release.json'),JSON.stringify(info('1.0.0')))
 await writeFile(join(root,'installation.json'),JSON.stringify({schemaVersion:1,current:'1.0.0'}));await writeFile(join(root,'update-source.json'),JSON.stringify(source))
 let activity={requests:0,blocking:[],connections:[]},boots=[],stops=0,resumes=0,failBoot=false,failStop=false,prepare=async()=>activity
 const updater=new HostUpdater(root,{prepare:interrupt=>prepare(interrupt),resume:async()=>{resumes++},stop:async()=>{stops++;if(failStop)throw new Error('旧进程未正常退出')},boot:async version=>{boots.push(version);if(failBoot&&version==='1.0.1')throw new Error('模拟新版启动失败')}});await updater.initialize()
 t.after(async()=>{await updater.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})})
 return {root,source,manifest,bytes,updater,boots,get stops(){return stops},get resumes(){return resumes},get requests(){return requests},set activity(value){activity=value},set damaged(value){damaged=value},set failBoot(value){failBoot=value},set feed(value){feed=value},set prepare(value){prepare=value},set failStop(value){failStop=value}}
}
async function ready(f){await f.updater.command({action:'check'});await until(()=>f.updater.snapshot().phase==='available');await f.updater.command({action:'download',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='ready')}

test('signed update manifests bind source, platform, version, expiry and digest metadata',async t=>{
 const f=await fixture(t)
 assert.equal(verifiedManifest(envelope(f.manifest),f.source).version,'1.0.1')
 const bad=JSON.parse(envelope(f.manifest));bad.payload=Buffer.from(JSON.stringify({...f.manifest,version:'9.0.0'})).toString('base64')
 assert.throws(()=>verifiedManifest(Buffer.from(JSON.stringify(bad)),f.source),/签名/)
 assert.throws(()=>verifiedManifest(envelope({...f.manifest,url:'https://elsewhere.invalid/update.zip'}),f.source),/下载/)
 assert.throws(()=>verifiedManifest(envelope({...f.manifest,expiresAt:1}),f.source),/过期/)
 assert.throws(()=>sourceConfig({...f.source,feed:'http://example.com/feed.json'}),/HTTPS/)
})
test('checks coalesce, downloads are explicit and damaged payload never changes the installation',async t=>{
 const f=await fixture(t)
 await Promise.all(Array.from({length:5},()=>f.updater.command({action:'check'})))
 await until(()=>f.updater.snapshot().phase==='available');assert.equal(f.requests,1);assert.equal(f.stops,0)
 f.damaged=true
 await f.updater.command({action:'download',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='failed')
 assert.match(f.updater.snapshot().message,/校验/);assert.equal((await readInstallation(f.root)).current,'1.0.0');assert.equal(f.stops,0)
})
test('idle installation waits for requests and sessions, can cancel, then switches exactly once',async t=>{
 const f=await fixture(t);await ready(f)
 f.activity={requests:1,blocking:[],connections:['SSH']}
 const operation={action:'install',targetVersion:'1.0.1',operationId:randomUUID()}
 await f.updater.command(operation);await until(()=>f.updater.snapshot().blockers?.length);assert.equal(f.stops,0)
 await f.updater.command({action:'cancel',operationId:randomUUID()});assert.equal(f.updater.snapshot().phase,'ready');assert.equal(f.resumes,1)
 f.activity={requests:0,blocking:[],connections:[]}
 await f.updater.command({...operation,operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='succeeded')
 assert.deepEqual(f.boots,['1.0.1']);assert.equal(f.stops,1);assert.equal((await readInstallation(f.root)).previous,'1.0.0')
 await f.updater.command(operation);assert.equal(f.stops,1,'an old command does not restart installation')
})
test('new release startup failure restores old code and reports recovery separately',async t=>{
 const f=await fixture(t);await ready(f);f.failBoot=true
 await f.updater.command({action:'install',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='failed')
 assert.deepEqual(f.boots,['1.0.1','1.0.0']);assert.equal((await readInstallation(f.root)).current,'1.0.0');assert.equal(f.updater.snapshot().recovered,true)
})
test('interruption consent still waits for in-flight writes and restores pending pointers after a crash',async t=>{
 const f=await fixture(t);await ready(f);f.activity={requests:1,blocking:['文件写入'],connections:['SSH']}
 await f.updater.command({action:'install',targetVersion:'1.0.1',interrupt:true,operationId:randomUUID()});await until(()=>f.updater.snapshot().blockers?.length);assert.equal(f.stops,0)
 await f.updater.command({action:'cancel',operationId:randomUUID()})
 await mkdir(join(f.root,'releases/1.0.1'),{recursive:true});await writeFile(join(f.root,'releases/1.0.1/release.json'),JSON.stringify(info('1.0.1')))
 await writeFile(join(f.root,'installation.json'),JSON.stringify({schemaVersion:1,current:'1.0.1',previous:'1.0.0',pending:{from:'1.0.0',to:'1.0.1'}}))
 const restored=new HostUpdater(f.root,{});assert.equal(await restored.initialize(),'1.0.0');assert.equal(restored.snapshot().recovered,true);await restored.close()
})
test('archive extraction rejects traversal and links before code can run',async t=>{
 const f=await fixture(t),zip=new ZipFile();zip.addBuffer(Buffer.from('unsafe'),'aa/escape');zip.end();const parts=[];for await(const b of zip.outputStream)parts.push(b)
 const traversal=Buffer.from(Buffer.concat(parts).toString('latin1').replaceAll('aa/escape','../escape'),'latin1'),path=join(f.root,'bad.zip');await writeFile(path,traversal)
 await assert.rejects(extractRelease(path,join(f.root,'extract')),/path|不安全|invalid/i)
 const linkZip=new ZipFile();linkZip.addBuffer(Buffer.from('target'),'link',{mode:0o120777});linkZip.end();const links=[];for await(const b of linkZip.outputStream)links.push(b);await writeFile(path,Buffer.concat(links))
 await assert.rejects(extractRelease(path,join(f.root,'extract-link')),/链接/)
})
test('maintenance seals new work while allowing existing tasks to finish before commit',async()=>{
 const ctx=new Context();ctx.plugin(MaintenanceService);const gate=ctx.maintenance
 gate.draining=true;await assert.rejects(gate.run(false,()=>{}),/暂不接受/)
 assert.equal(await gate.run(true,()=>12),12);assert.equal(gate.active,0)
 gate.sealed=true;await assert.rejects(gate.run(true,()=>{}),/暂不接受/)
 gate.draining=false;gate.sealed=false;assert.equal(await gate.run(false,()=>15),15);await ctx.stop()
})

test('cancelling during an outstanding prepare waits before reopening admission',async t=>{
 const f=await fixture(t);await ready(f)
 let release,entered=false
 f.prepare=async()=>{entered=true;await new Promise(r=>release=r);return {requests:0,blocking:[],connections:[]}}
 await f.updater.command({action:'install',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>entered)
 const cancelled=f.updater.command({action:'cancel',operationId:randomUUID()})
 await new Promise(r=>setTimeout(r,50));assert.equal(f.resumes,0,'resume must follow the final prepare reply')
 release();await cancelled;assert.equal(f.resumes,1);assert.equal(f.stops,0);assert.equal(f.updater.snapshot().phase,'ready')
})

test('persisted operation IDs survive restart and a corrupted journal disables only updating',async t=>{
 const f=await fixture(t);await ready(f)
 const operation={action:'install',targetVersion:'1.0.1',operationId:randomUUID()}
 f.activity={requests:1,blocking:[],connections:[]};await f.updater.command(operation);await f.updater.close()
 const restarted=new HostUpdater(f.root,{})
 assert.equal(await restarted.initialize(),'1.0.0');assert.equal((await restarted.command(operation)).phase,'ready')
 await assert.rejects(restarted.command({...operation,interrupt:true}),/不一致/);await restarted.close()
 await writeFile(join(f.root,'updates/state.json'),'{damaged')
 const invalid=new HostUpdater(f.root,{})
 assert.equal(await invalid.initialize(),'1.0.0');assert.equal(invalid.snapshot().phase,'unavailable');await assert.rejects(invalid.command({action:'check'}),/记录损坏/);await invalid.close()
})

test('incompatible releases are rejected and obsolete verified directories are removed safely',async t=>{
 const f=await fixture(t)
 f.feed=envelope({...f.manifest,dataVersion:2});await f.updater.command({action:'check'});await until(()=>f.updater.snapshot().phase==='failed');assert.match(f.updater.snapshot().message,/迁移/)
 // The failed phase is published before the asynchronous journal finishes.
 // Wait for that check to settle before changing the fixture feed and retrying.
 await f.updater.checking
 f.feed=envelope(f.manifest);await ready(f)
 for(const version of ['0.9.0','0.9.1']){await mkdir(join(f.root,'releases',version));await writeFile(join(f.root,'releases',version,'release.json'),JSON.stringify(info(version)))}
 await mkdir(join(f.root,'releases','user-files'));await writeFile(join(f.root,'releases/user-files/keep.txt'),'retain')
 await f.updater.command({action:'install',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='succeeded');await f.updater.close()
 await assert.rejects(readFile(join(f.root,'releases/0.9.0/release.json')),{code:'ENOENT'});assert.equal(await readFile(join(f.root,'releases/user-files/keep.txt'),'utf8'),'retain')
 assert.equal(JSON.parse(await readFile(join(f.root,'releases/1.0.0/release.json'),'utf8')).version,'1.0.0')
})

test('Gitee page checks use signed markers, cache clicks across restart, and allow only observed download hosts',async t=>{
 const f=await fixture(t);await f.updater.close()
 const source={...f.source,feed:'https://gitee.com/axisxy/webpagenav/releases'}
 const manifest={...f.manifest,url:'https://gitee.com/axisxy/webpagenav/releases/download/v1.0.1/update.zip'}
 const bytes=envelope(manifest),html=`<html><pre><code>WEBNAV_UPDATE_V1:${bytes.toString('base64')}</code></pre><script>untrusted()</script></html>`
 assert.deepEqual(releasePageManifest(Buffer.from(html),source),bytes)
 assert.throws(()=>releasePageManifest(Buffer.from('<html>Login or validation required</html>'),source),/有效签名/)
 assert.throws(()=>verifiedManifest(envelope({...manifest,url:'https://gitee.com/other/repository/releases/download/v1/update.zip'}),source),/仓库/)
 assert.equal(new URL(updateRedirect(manifest.url,'https://foruda.gitee.com/attach/file?download=1',source)).hostname,'foruda.gitee.com')
 assert.throws(()=>updateRedirect(manifest.url,'https://attacker.example/package.zip',source),/未允许/)
 assert.throws(()=>updateRedirect(manifest.url,'http://127.0.0.1/internal',source),/未允许/)
 await writeFile(join(f.root,'update-source.json'),JSON.stringify(source))
 const original=globalThis.fetch;let requests=0
 globalThis.fetch=async(url,options)=>{requests++;assert.equal(url,source.feed);assert.equal(options.headers.Accept,'text/html');return new Response(html,{status:200,headers:{etag:'fixture-v1'}})}
 t.after(()=>{globalThis.fetch=original})
 const reader=new HostUpdater(f.root,{});await reader.initialize();await reader.command({action:'check'});await until(()=>reader.snapshot().phase==='available');await reader.close()
 const restarted=new HostUpdater(f.root,{});await restarted.initialize();await restarted.command({action:'check'});assert.equal(requests,1);assert.match(restarted.snapshot().message,/缓存/);await restarted.close()
})

test('server throttling persists Retry-After and prevents repeated network checks',async t=>{
 const f=await fixture(t),original=globalThis.fetch;let requests=0
 globalThis.fetch=async()=>{requests++;return new Response('rate limited',{status:429,headers:{'retry-after':'1800'}})}
 t.after(()=>{globalThis.fetch=original})
 await f.updater.command({action:'check'});await until(()=>f.updater.snapshot().phase==='failed');await f.updater.close()
 const restarted=new HostUpdater(f.root,{});await restarted.initialize();await restarted.command({action:'check'});assert.equal(requests,1);assert.match(restarted.snapshot().message,/缓存/);await restarted.close()
})

test('an unconfirmed old-process shutdown prevents committing the new pointer',async t=>{
 const f=await fixture(t);await ready(f);f.failStop=true
 await f.updater.command({action:'install',targetVersion:'1.0.1',operationId:randomUUID()});await until(()=>f.updater.snapshot().phase==='failed')
 assert.equal((await readInstallation(f.root)).current,'1.0.0');assert.deepEqual(f.boots,[]);assert.equal(f.resumes,1)
})
