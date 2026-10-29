import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative } from 'node:path'
import ssh2 from 'ssh2'
import iconv from 'iconv-lite'
import { Context } from 'cordis'
import { SshFilesService,decodeText,encodeText } from '../src/plugins/ssh-files/index.ts'
import { archiveName,childName,CHUNK,hash,RemoteFs } from '../src/plugins/ssh-files/remote-fs.ts'
import { ExternalEditor } from '../src/plugins/ssh-files/external-editor.ts'
import { TerminalDirectoryTracker } from '../src/core/terminal-directory.ts'
import { writableSftp,seedRemoteFiles } from './writable-sftp-fixture.mjs'

test('file text keeps Chinese encodings, BOM and CRLF; binary and traversal are rejected',()=>{
  for(const encoding of ['utf8','utf16le','utf16be','gb18030']){
    const source={text:'你好\n文件',encoding,bom:encoding!=='gb18030',lineEnding:'CRLF'}
    const bytes=encodeText(source),result=decodeText('/test.txt',bytes)
    assert.equal(result.text,'你好\r\n文件');assert.equal(result.encoding,encoding);assert.equal(result.lineEnding,'CRLF')
    assert.deepEqual(encodeText(result),bytes)
  }
  assert.equal(decodeText('/gbk',iconv.encode('中文配置','gbk')).text,'中文配置')
  assert.throws(()=>decodeText('/binary',Buffer.from([0,1,2,3])),/文本/)
  assert.throws(()=>encodeText({text:'x'.repeat(524289),encoding:'utf8'}),/512/)
  for(const path of ['../bad','/absolute','C:/absolute','a/../b','a\\b','a\0b'])assert.throws(()=>archiveName(path))
  for(const name of ['..','a/b','a\\b','C:foo'])assert.throws(()=>childName(name))
  assert.equal(childName("a'$(literal).txt"),"a'$(literal).txt")
})

test('directory tracking handles fragmented OSC, Windows SSH and Linux prompts without guessing unknown output',()=>{
  const tracker=new TerminalDirectoryTracker()
  const osc=Buffer.from('\x1b]7;file://localhost/home/%E4%B8%AD%E6%96%87\x1b\\')
  for(const byte of osc)tracker.feed(Buffer.from([byte]))
  assert.equal(tracker.snapshot().path,'/home/中文')
  tracker.feed(Buffer.from('\r\nuser@WINDOWS C:\\Users\\用户>'))
  assert.equal(tracker.snapshot().path,'/C:/Users/用户')
  tracker.feed(Buffer.from('\r\nPS D:\\Projects> '));assert.equal(tracker.snapshot().path,'/D:/Projects')
  tracker.feed(Buffer.from('\r\nuser@linux:~/work$ '));assert.equal(tracker.snapshot().path,'~/work')
  tracker.feed(Buffer.from('\r\nnot a prompt /no/path\n'));assert.equal(tracker.snapshot().path,'~/work')
  tracker.feed(Buffer.from('x'.repeat(100000)));assert.ok(tracker.tail.length<=8192)
})

async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'webnav-files-test-')),home=await seedRemoteFiles(root)
  const host=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})
  const peers=new Set()
  const server=new ssh2.Server({hostKeys:[host.privateKey]},client=>{peers.add(client);client.on('error',()=>{});client.on('close',()=>peers.delete(client));client.on('authentication',ctx=>ctx.accept());client.on('ready',()=>client.on('session',accept=>writableSftp(accept(),root,options)))})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const client=new ssh2.Client();client.on('error',()=>{});client.connect({host:'127.0.0.1',port:server.address().port,username:'fixture'});await once(client,'ready')
  const ctx=new Context(),listeners=new Set();let locked=false,revision=0
  ctx.set('credentials',{requireUnlocked(){if(locked)throw new Error('locked')},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}})
  ctx.set('sessions',{owned(owner,id){if(owner!=='owner'||id!=='session')throw new Error('not owner');return {client,channel:{},closed:false}},directory(){return {path:'~/projects',revision:1}}})
  ctx.set('sshInspector',{invalidateFiles(){revision++}});ctx.plugin(SshFilesService);await ctx.start()
  t.after(async()=>{await ctx.stop();client.destroy();for(const peer of peers)peer.end();server.close();assert.match(relative(tmpdir(),root),/^webnav-files-test-[\w-]+$/);await rm(root,{recursive:true,force:true})})
  return {service:ctx.sshFiles,home,client,revision:()=>revision,lock(){locked=true;for(const fn of listeners)fn({unlocked:false})},unlock(){locked=false}}
}
const input=extra=>({sessionId:'session',...extra})
async function waitFor(check){for(let n=0;n<100;n++){if(await check())return;await new Promise(r=>setTimeout(r,100))}assert.fail('condition timed out')}

test('SFTP edits compare content, retain originals on conflict, clean staged writes and enforce ownership',async t=>{
  const {service,home,revision,lock,unlock}=await fixture(t),path='/home/fixture/README.md'
  const original=await service.readText('owner',input({path}))
  await service.saveText('owner',input({...original,text:'修改的中文\n',encoding:'utf8'}))
  assert.equal(await readFile(join(home,'README.md'),'utf8'),'修改的中文\r\n')
  assert.ok(revision()>0)
  await assert.rejects(service.saveText('owner',input({...original,text:'stale'})),/远端文件已变化/)
  assert.equal((await readdir(home)).some(n=>n.startsWith('.webnav-')),false)
  await assert.rejects(service.readText('other',input({path})),/not owner/)
  lock();await assert.rejects(service.readText('owner',input({path})),/locked/);unlock()
  assert.deepEqual(await service.directory('owner',input({})),{path:'/home/fixture/projects',revision:1})
  await service.action('owner',input({path:'/home/fixture',action:'mkdir',name:'新目录'}))
  await service.action('owner',input({path:'/home/fixture/新目录',action:'create',name:"quote'$.txt"}))
  await service.action('owner',input({path:"/home/fixture/新目录/quote'$.txt",action:'rename',name:'renamed.txt'}))
  assert.equal((await service.action('owner',input({path:'/home/fixture/新目录/renamed.txt',action:'properties'}))).size,0)
  await assert.rejects(service.action('owner',input({path:'/home/fixture/新目录',action:'remove'})),/确认/)
  await service.action('owner',input({path:'/home/fixture/新目录',action:'remove',confirm:true}))
  await assert.rejects(stat(join(home,'新目录')),/ENOENT/)
  await assert.rejects(service.action('owner',input({path:'/',action:'remove',confirm:true})),/根目录/)
})

test('chunk transfers support offsets, empty files, cancellation, lock cleanup and overwrite conflicts',async t=>{
  const {service,home,lock}=await fixture(t,{maxWriteSize:32*1024}),path='/home/fixture/upload.bin',data=Buffer.from(Array.from({length:CHUNK+333},(_,i)=>i%251))
  const upload=await service.begin('owner',input({path,kind:'upload',size:data.length}))
  await service.chunk('owner',{id:upload.id,offset:0,data:data.subarray(0,CHUNK).toString('base64')})
  await service.chunk('owner',{id:upload.id,offset:CHUNK,data:data.subarray(CHUNK).toString('base64')})
  await service.commit('owner',{id:upload.id});assert.deepEqual(await readFile(join(home,'upload.bin')),data)
  const download=await service.begin('owner',input({path,kind:'download'})),parts=[];let offset=0
  for(;;){const block=await service.chunk('owner',{id:download.id,offset});parts.push(Buffer.from(block.data,'base64'));offset=block.offset;if(block.done)break}
  assert.deepEqual(Buffer.concat(parts),data)
  const aborted=await service.begin('owner',input({path:'/home/fixture/cancelled',kind:'upload',size:9}))
  await assert.rejects(service.chunk('other',{id:aborted.id,offset:0,data:''}),/不存在/)
  await service.cancel('owner',{id:aborted.id});assert.equal((await readdir(home)).some(n=>n.startsWith('.webnav-')),false)
  const empty=await service.begin('owner',input({path:'/home/fixture/empty',kind:'upload',size:0}));await service.commit('owner',{id:empty.id})
  const zero=await service.begin('owner',input({path:'/home/fixture/empty',kind:'download'}));assert.equal((await service.chunk('owner',{id:zero.id,offset:0})).done,true)
  const mismatch=await service.begin('owner',input({path:'/home/fixture/bad',kind:'upload',size:9}));await assert.rejects(service.chunk('owner',{id:mismatch.id,offset:1,data:''}),/位置/)
  await assert.rejects(service.begin('owner',input({path,kind:'upload',size:0})),/同名/)
  const replace=await service.begin('owner',input({path,kind:'upload',size:0,overwrite:true}));await writeFile(join(home,'upload.bin'),'changed')
  await assert.rejects(service.commit('owner',{id:replace.id}),/变化/);assert.equal(await readFile(join(home,'upload.bin'),'utf8'),'changed')
  await service.begin('owner',input({path:'/home/fixture/locked',kind:'upload',size:0}));lock()
  await waitFor(async()=>!(await readdir(home)).some(n=>n.startsWith('.webnav-')))
})

test('bounded SFTP writes stop at the first failed packet without replaying or writing later offsets',async()=>{
  const offsets=[]
  const fs=new RemoteFs({write(_handle,_buffer,_offset,length,position,cb){offsets.push({length,position});cb(offsets.length===2?Object.assign(new Error('Failure'),{code:4}):null)}})
  await assert.rejects(fs.write(Buffer.from('handle'),Buffer.alloc(128*1024),333),/Failure/)
  assert.deepEqual(offsets,[{length:32768,position:333},{length:32768,position:33101}])
})

test('ZIP jobs round-trip folders and empty directories; failed archive leaves no destination',async t=>{
  const {service,home}=await fixture(t)
  const zip=await service.startJob('owner',input({path:'/home/fixture/projects',kind:'compress'}))
  await waitFor(()=>service.status('owner',input({})).find(j=>j.id===zip.id)?.state!=='working')
  assert.equal(service.status('owner',input({})).find(j=>j.id===zip.id)?.state,'done')
  const unzip=await service.startJob('owner',input({path:'/home/fixture/projects.zip',kind:'extract'}))
  await waitFor(()=>service.status('owner',input({})).find(j=>j.id===unzip.id)?.state!=='working')
  assert.equal(service.status('owner',input({})).find(j=>j.id===unzip.id)?.state,'done')
  assert.equal(await readFile(join(home,'projects-extracted','projects','notes.txt'),'utf8'),'项目目录\n')
  assert.ok((await stat(join(home,'projects-extracted','projects','empty'))).isDirectory())
  await writeFile(join(home,'bad.zip'),'not zip')
  const bad=await service.startJob('owner',input({path:'/home/fixture/bad.zip',kind:'extract'}));await waitFor(()=>service.status('owner',input({})).find(j=>j.id===bad.id)?.state==='error')
  assert.equal((await readdir(home)).some(n=>n.startsWith('.webnav-')||n==='bad-extracted'),false)
  const cancelled=await service.startJob('owner',input({path:'/home/fixture/projects',kind:'compress'}));await service.jobAction('owner',{id:cancelled.id,action:'stop'})
  await new Promise(r=>setTimeout(r,150));assert.equal(service.status('owner',input({})).find(j=>j.id===cancelled.id)?.state,'stopped')
})

test('local editor watches saves, pauses on remote conflict, supports explicit overwrite and preserves unsaved local copy',{skip:process.platform!=='win32'},async t=>{
  const {service,home}=await fixture(t),state={};let launched=false
  const editor=new ExternalEditor({owner:'owner',sessionId:'session',path:'/home/fixture/settings.json',editor:'notepad',remote:run=>service.withRemote('owner','session',run),update:patch=>Object.assign(state,patch),invalidate:()=>{},launch:async(exe,args)=>{assert.ok(exe.endsWith('notepad.exe'));assert.equal(args.length,1);launched=true}})
  t.after(()=>editor.stop())
  await editor.start();assert.equal(launched,true);const local=state.localPath
  await writeFile(local,'local edit');await waitFor(async()=>{
    // The mock SFTP fallback moves the old file aside before committing the staged file.
    try{return await readFile(join(home,'settings.json'),'utf8')==='local edit'}catch(error){if(error.code==='ENOENT')return false;throw error}
  })
  await writeFile(join(home,'settings.json'),'remote edit');await writeFile(local,'conflicting edit')
  await waitFor(()=>state.state==='conflict');assert.equal(await readFile(join(home,'settings.json'),'utf8'),'remote edit')
  await editor.sync(true);assert.equal(await readFile(join(home,'settings.json'),'utf8'),'conflicting edit')
  await writeFile(local,'unsaved');await editor.stop();assert.equal(await readFile(local,'utf8'),'unsaved')
  const directory=join(local,'..');assert.match(relative(tmpdir(),directory),/^webnav-edit-[\w-]+$/);await rm(directory,{recursive:true,force:true})
})
