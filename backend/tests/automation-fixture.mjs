import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,relative} from 'node:path'
import {generateKeyPairSync,createHash} from 'node:crypto'
import {once} from 'node:events'
import {createServer} from 'node:net'
import ssh2 from 'ssh2'
import {createApp} from '../src/app.ts'
import {seedRemoteFiles,writableSftp} from './writable-sftp-fixture.mjs'
import {linuxOutput} from './ssh-inspector-fixture.mjs'
export const waitFor=async(check,milliseconds=8000)=>{const until=Date.now()+milliseconds;for(;;){if(await check())return;if(Date.now()>until)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,20))}}
export async function automationFixture(options={}){
  const directory=await mkdtemp(join(tmpdir(),'webnav-automation-test-')),remote=join(directory,'remote'),home=await seedRemoteFiles(remote)
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})
  const peers=new Set(),stats={connections:0,inputs:[],shells:0,resizes:0},streams=new Set()
  const ssh=new ssh2.Server({hostKeys:[keys.privateKey]},client=>{
    peers.add(client);stats.connections++;client.on('error',()=>{});client.on('close',()=>peers.delete(client));client.on('authentication',c=>c.accept())
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();writableSftp(session,remote)
      session.on('pty',accept=>accept());session.on('window-change',accept=>{stats.resizes++;accept?.()})
      session.on('exec',accept=>{const stream=accept();stream.end(linuxOutput)})
      session.on('shell',accept=>{stats.shells++;const stream=accept();streams.add(stream);stream.once('close',()=>streams.delete(stream));stream.write('AI loopback fixture\r\nfixture> ');stream.on('data',bytes=>{stats.inputs.push(bytes.toString());stream.write(bytes);stream.write('\r\nfixture> ')})})
    }))
  });ssh.listen(0,'127.0.0.1');await once(ssh,'listening')
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r))
  const config={directory,port,frontendRoot:resolve('../frontend/dist'),rdpEnabled:false,disablePlugins:true,...options},ctx=await createApp(config)
  ctx.storage.replace({schemaVersion:1,groups:[],servers:['alpha','beta'].map(id=>({id,name:'Fixture '+id,host:'127.0.0.1',groupId:'',tags:[],note:'',favorite:false,connections:[{id:'ssh',name:'SSH',type:'ssh',port:ssh.address().port,username:'fixture'}]}))},0)
  for(const serverId of ['alpha','beta'])await ctx.credentials.save({serverId,connectionId:'ssh',kind:'password',secret:'test-only'})
  const fingerprint='SHA256:'+createHash('sha256').update(ssh2.utils.parseKey(keys.privateKey).getPublicSSH()).digest('base64').replace(/=+$/,'')
  ctx.storage.db.prepare('INSERT INTO hostkeys VALUES (?,?)').run(JSON.stringify(['127.0.0.1',ssh.address().port]),fingerprint)
  const browserToken=ctx.auth.create(),cookie=ctx.auth.cookieName+'='+browserToken,owner=ctx.auth.session(cookie).id
  const grant=ctx.automation.authority.saveGrant({id:'work',name:'测试工作',scopes:['catalog.read','plugins.read','ssh.execute','files.read','files.write','system.read','history.read'],targets:[['alpha','ssh']],paths:['/home/fixture']})
  const enroll=(name='Test AI')=>{const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');const pairing=ctx.automation.authority.begin(name,grant.id);return {id:ctx.automation.authority.enroll(pairing.code,publicKey),keys,publicKey}}
  return {ctx,config,directory,home,remote,stats,streams,cookie,owner,port,origin:`http://127.0.0.1:${port}`,enroll,async close(){await ctx.stop();for(const p of peers)p.end();await new Promise(r=>ssh.close(r));if(!/^webnav-automation-test-[\w-]+$/.test(relative(tmpdir(),directory)))throw new Error('Unexpected fixture root');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})}}
}
