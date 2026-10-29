import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Context } from 'cordis'
import ssh2 from 'ssh2'
import { SshInspectorService, parseLinuxSystem, parseWindowsSystem, validateRemotePath, linuxProbe, windowsProbe } from '../src/plugins/ssh-inspector.ts'
import { inspectorFixture, linuxOutput } from './ssh-inspector-fixture.mjs'

test('system parsers calculate CPU deltas and bounded memory/disk data for Linux and Windows',()=>{
  const first=parseLinuxSystem(linuxOutput)
  assert.equal(first.info.cpuPercent,null);assert.equal(first.info.memoryTotal,16*1024**3)
  const second=parseLinuxSystem(linuxOutput.replace('100 0 100 800','150 0 100 850'),first.cpu)
  assert.equal(second.info.cpuPercent,50);assert.equal(second.info.disks[0].path,'/')
  assert.equal(linuxProbe.includes("printf '\\n__CPU__\\n'"),true)
  const windows=parseWindowsSystem(JSON.stringify({hostname:'PC',platform:'Windows',uptime:60,cpuCount:4,cpuPercent:35,memoryTotal:100,memoryUsed:20,disks:[{path:'C:',total:400,used:100}]}))
  assert.equal(windows.cpuPercent,35);assert.equal(windows.disks[0].path,'C:')
  for(const value of ['', 'a\0b','a\nb',12,'x'.repeat(5000)])assert.throws(()=>validateRemotePath(value))
  assert.equal(validateRemotePath("/home/a'$(echo literal)"),"/home/a'$(echo literal)")
})
test('Windows probe emits UTF-8 Chinese even when the inherited console code page is GBK', {skip:process.platform!=='win32'},()=>{
  const probeScript=Buffer.from(windowsProbe.split(' -EncodedCommand ')[1],'base64').toString('utf16le')
  const fixture=`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936)
    $env:COMPUTERNAME='测试工作站'
    function Get-CimInstance($ClassName, $Filter) {
      switch ($ClassName) {
        'Win32_OperatingSystem' { [pscustomobject]@{Caption='Microsoft Windows 10 专业版';LastBootUpTime=(Get-Date).AddHours(-6);TotalVisibleMemorySize=16384000;FreePhysicalMemory=14000000} }
        'Win32_ComputerSystem' { [pscustomobject]@{NumberOfLogicalProcessors=4} }
        'Win32_Processor' { [pscustomobject]@{LoadPercentage=3} }
        'Win32_LogicalDisk' { [pscustomobject]@{DeviceID='C:';Size=100000000000;FreeSpace=71000000000} }
      }
    }
    ${probeScript}`
  const output=execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixture,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:64*1024})
  const info=parseWindowsSystem(output.toString('utf8'))
  assert.equal(info.hostname,'测试工作站')
  assert.equal(info.platform,'Microsoft Windows 10 专业版')
  assert.equal(output.includes(Buffer.from('\uFFFD')),false)
})
test('inspector reuses SSH, pages SFTP metadata, enforces ownership/lock and does not write to the shell',async t=>{
  const host=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})
  const stats={connections:0,input:0}
  const server=new ssh2.Server({hostKeys:[host.privateKey]},client=>{stats.connections++;client.on('error',()=>{});client.on('authentication',ctx=>ctx.accept());client.on('ready',()=>client.on('session',accept=>inspectorFixture(accept(),stats)))})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const client=new ssh2.Client();client.on('error',()=>{});client.connect({host:'127.0.0.1',port:server.address().port,username:'fixture'});await once(client,'ready')
  const ctx=new Context();let locked=false,closed=false
  ctx.set('credentials',{requireUnlocked(){if(locked)throw new Error('locked')}})
  ctx.set('sessions',{owned(owner,id){if(owner!=='owner'||id!=='session'||closed)throw new Error('not found');return {client,channel:{},closed:false}}})
  ctx.plugin(SshInspectorService);await ctx.start()
  t.after(async()=>{await ctx.stop();client.destroy();server.close()})
  const info=await ctx.sshInspector.system('owner',{sessionId:'session'})
  assert.equal(info.hostname,'atlas-dev');assert.equal(stats.probes,1)
  await ctx.sshInspector.system('owner',{sessionId:'session'});assert.equal(stats.probes,1)
  const files=await ctx.sshInspector.files('owner',{sessionId:'session',path:'.'})
  assert.equal(files.path,'/home/fixture');assert.equal(files.entries[0].kind,'directory');assert.equal(files.entries.length,6)
  const first=await ctx.sshInspector.files('owner',{sessionId:'session',path:'/many'})
  const second=await ctx.sshInspector.files('owner',{sessionId:'session',path:'/many',offset:100})
  assert.equal(first.entries.length,100);assert.equal(first.total,230);assert.equal(second.entries[0].name,'file-100')
  assert.equal(stats.sftp,2);assert.equal(stats.connections,1);assert.equal(stats.input,0)
  await assert.rejects(ctx.sshInspector.files('owner',{sessionId:'session',path:'/denied'}),/无法读取/)
  await assert.rejects(ctx.sshInspector.system('other',{sessionId:'session'}),/not found/)
  locked=true;await assert.rejects(ctx.sshInspector.system('owner',{sessionId:'session'}),/locked/)
  locked=false;closed=true;await assert.rejects(ctx.sshInspector.files('owner',{sessionId:'session'}),/not found/)
})
