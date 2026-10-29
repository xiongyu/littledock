import { Service, type Context } from 'cordis'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import type { SshFileEntry, SshFilePage, SshSystemInfo } from '@webnav/shared'
import { AppError, integer, record, string } from '../core/errors.ts'

// Fixed read-only probes use independent SSH exec channels, never the interactive shell.
export const linuxProbe = `LC_ALL=C; export LC_ALL
uname -s || exit 1
hostname
uname -r
printf '\\n__CPU__\\n'; head -n 1 /proc/stat
printf '__MEM__\\n'; cat /proc/meminfo
printf '__UP__\\n'; cat /proc/uptime
printf '__LOAD__\\n'; cat /proc/loadavg
printf '__CORES__\\n'; getconf _NPROCESSORS_ONLN
printf '__DISKS__\\n'; df -Pk`
// EncodedCommand defines the input encoding only. Explicitly set stdout as well:
// Windows PowerShell otherwise writes localized CIM strings using the OEM code page.
const windowsScript = `$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor; [ordered]@{hostname=$env:COMPUTERNAME;platform=$o.Caption;uptime=[math]::Max(0,((Get-Date)-$o.LastBootUpTime).TotalSeconds);cpuCount=$c.NumberOfLogicalProcessors;cpuPercent=($p|Measure-Object LoadPercentage -Average).Average;memoryTotal=([double]$o.TotalVisibleMemorySize*1024);memoryUsed=([double]($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)*1024);load='';disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object {@{path=$_.DeviceID;total=[double]$_.Size;used=[double]($_.Size-$_.FreeSpace)}})}|ConvertTo-Json -Depth 4 -Compress`
export const windowsProbe = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(windowsScript,'utf16le').toString('base64')
const number = (value:unknown) => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0
const label = (value:unknown) => typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,256):''
export function parseWindowsSystem(output:string):SshSystemInfo {
  const data=record(JSON.parse(output.replace(/^\uFEFF/,'')))
  if(!data.hostname||!data.platform)throw new Error('Invalid system data')
  return {hostname:label(data.hostname),platform:label(data.platform),uptime:number(data.uptime),cpuCount:number(data.cpuCount),cpuPercent:typeof data.cpuPercent==='number'?Math.min(100,number(data.cpuPercent)):null,memoryTotal:number(data.memoryTotal),memoryUsed:number(data.memoryUsed),load:'',sampledAt:Date.now(),disks:(Array.isArray(data.disks)?data.disks:[]).slice(0,32).map(value=>{const disk=record(value);return {path:label(disk.path),total:number(disk.total),used:number(disk.used)}})}
}
type CpuSample={total:number;idle:number}
export function parseLinuxSystem(output:string,previous?:CpuSample):{info:SshSystemInfo;cpu:CpuSample} {
  const lines=output.trim().split(/\r?\n/)
  if(lines[0]!=='Linux')throw new Error('Unsupported system')
  const section=(name:string)=>output.split('__'+name+'__')[1]?.split(/__\w+__/)[0]?.trim()??''
  const ticks=section('CPU').split(/\s+/).slice(1).map(Number).slice(0,8)
  if(ticks.length<4||ticks.some(value=>!Number.isFinite(value)))throw new Error('Invalid CPU counters')
  const cpu={total:ticks.reduce((a,b)=>a+b,0),idle:(ticks[3]??0)+(ticks[4]??0)}
  const mem=section('MEM'),memory=(key:string)=>number(Number(mem.match(new RegExp('^'+key+':\\s+(\\d+)','m'))?.[1]))*1024
  const total=memory('MemTotal'),available=memory('MemAvailable')||memory('MemFree')
  const percent=previous&&cpu.total>previous.total?Math.max(0,Math.min(100,100*(1-(cpu.idle-previous.idle)/(cpu.total-previous.total)))):null
  const disks=section('DISKS').split('\n').slice(1,33).flatMap(line=>{const match=line.match(/^\S+\s+(\d+)\s+(\d+)\s+\d+\s+\d+%\s+(.+)$/);return match?[{path:label(match[3]),total:Number(match[1])*1024,used:Number(match[2])*1024}]:[]})
  return {cpu,info:{hostname:label(lines[1]),platform:'Linux '+label(lines[2]),uptime:number(Number(section('UP').split(' ')[0])),cpuCount:number(Number(section('CORES'))),cpuPercent:percent,memoryTotal:total,memoryUsed:Math.max(0,total-available),load:section('LOAD').split(' ').slice(0,3).join(' '),disks,sampledAt:Date.now()}}
}

function execProbe(client:Client,command:string,signal:AbortSignal):Promise<string> {
  return new Promise((resolve,reject)=>{
    let channel:ClientChannel|undefined,done=false,size=0,output:Buffer[]=[]
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);client.off('close',closed);signal.removeEventListener('abort',closed);channel?.destroy();if(error)reject(error);else resolve(Buffer.concat(output).toString('utf8'));output=[]}
    const closed=()=>finish(new Error('SSH closed'))
    const timer=setTimeout(()=>finish(new Error('Probe timeout')),8000)
    client.once('close',closed)
    signal.addEventListener('abort',closed,{once:true});if(signal.aborted){closed();return}
    client.exec(command,(error,stream)=>{
      if(done){stream?.destroy();return}if(error){finish(error);return}channel=stream
      stream.on('error',finish)
      stream.on('data',(data:Buffer)=>{size+=data.length;if(size>64*1024)finish(new Error('Probe output limit'));else output.push(data)})
      stream.stderr.on('data',(data:Buffer)=>{size+=data.length;if(size>64*1024)finish(new Error('Probe output limit'))})
      stream.on('close',(code:number)=>finish(code?new Error('Probe failed'):undefined))
    })
  })
}

export function validateRemotePath(value:unknown) { const path=string(value??'.',4096);if(/[\x00-\x1f\x7f]/.test(path))throw new AppError('INVALID_ARGUMENT','路径包含无效字符。');return path }
function listDirectory(client:Client,path:string,signal:AbortSignal):Promise<{path:string;entries:SshFileEntry[];truncated:boolean}> {
  return new Promise((resolve,reject)=>{
    let sftp:SFTPWrapper|undefined,done=false,handle:Buffer|undefined
    const finish=(error?:Error,result?:{path:string;entries:SshFileEntry[];truncated:boolean})=>{
      if(done)return;done=true;clearTimeout(timer);client.off('close',closed);signal.removeEventListener('abort',closed)
      if(handle)sftp?.close(handle,()=>{});sftp?.end()
      if(error)reject(error);else resolve(result!)
    }
    const closed=()=>finish(new Error('SSH closed')),timer=setTimeout(()=>finish(new Error('SFTP timeout')),8000)
    client.once('close',closed)
    signal.addEventListener('abort',closed,{once:true});if(signal.aborted){closed();return}
    client.sftp((error,channel)=>{
      if(done){channel?.end();return}if(error){finish(error);return}sftp=channel;sftp.on('error',finish)
      sftp.realpath(path,(error,canonical)=>{
        if(done)return;if(error){finish(error);return}
        sftp!.opendir(canonical,(error,directory)=>{
          if(done)return;if(error){finish(error);return}handle=directory
          const entries:SshFileEntry[]=[]
          const read=()=>sftp!.readdir(directory,(error,files)=>{
            if(done)return;if(error&&(error as Error & {code?:number}).code!==1){finish(error);return}
            if(error||!files){entries.sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||a.name.localeCompare(b.name));finish(undefined,{path:canonical,entries,truncated:false});return}
            for(const file of files){
              if(file.filename==='.'||file.filename==='..'||file.filename.length>512||/[\x00-\x1f\/\\]/.test(file.filename))continue
              const attrs=file.attrs
              entries.push({name:file.filename,kind:attrs.isDirectory()?'directory':attrs.isSymbolicLink()?'link':'file',size:number(attrs.size),modifiedAt:number(attrs.mtime)*1000,permissions:(attrs.mode&0o7777).toString(8).padStart(3,'0'),owner:attrs.uid+':'+attrs.gid})
              if(entries.length>=2000){finish(undefined,{path:canonical,entries,truncated:true});return}
            }
            read()
          })
          read()
        })
      })
    })
  })
}

declare module 'cordis' { interface Context { sshInspector:SshInspectorService } }
export class SshInspectorService extends Service {
  static inject=['sessions','credentials']
  private states=new WeakMap<Client,{platform?:'linux'|'windows';cpu?:CpuSample;info?:SshSystemInfo;files?:{path:string;entries:SshFileEntry[];truncated:boolean;at:number;revision:number};busy:Set<string>}>()
  private active=new Set<AbortController>()
  invalidateFiles(){this.fileRevision++}
  private fileRevision=0
  constructor(ctx:Context){super(ctx,'sshInspector',true);ctx.on('dispose',()=>{for(const controller of this.active)controller.abort();this.active.clear()})}
  private ready(owner:string,id:string){
    this.ctx.credentials.requireUnlocked()
    const session=this.ctx.sessions.owned(owner,id)
    if(!session.client||!session.channel||session.finished||session.closed)throw new AppError('CONFLICT','SSH 连接就绪后可查看。')
    let state=this.states.get(session.client)
    if(!state){state={busy:new Set()};this.states.set(session.client,state)}
    return {client:session.client,state}
  }
  async system(owner:string,input:unknown){
    const id=string(record(input).sessionId),{client,state}=this.ready(owner,id)
    if(state.info&&Date.now()-state.info.sampledAt<3000)return state.info
    if(state.busy.has('system'))throw new AppError('BUSY','系统信息正在读取。')
    state.busy.add('system')
    const controller=new AbortController();this.active.add(controller)
    try{
      if(state.platform!=='windows'){
        try{const result=parseLinuxSystem(await execProbe(client,linuxProbe,controller.signal),state.cpu);state.platform='linux';state.cpu=result.cpu;state.info=result.info}
        catch(error){if(state.platform==='linux'||controller.signal.aborted)throw error;state.platform='windows'}
      }
      if(state.platform==='windows')state.info=parseWindowsSystem(await execProbe(client,windowsProbe,controller.signal))
      this.ready(owner,id);return state.info!
    }catch{throw new AppError('UNAVAILABLE','系统信息暂不可用，可手动重试。')}
    finally{state.busy.delete('system');this.active.delete(controller)}
  }
  async files(owner:string,input:unknown):Promise<SshFilePage>{
    const params=record(input),id=string(params.sessionId),path=validateRemotePath(params.path),offset=integer(params.offset??0,0,2000),{client,state}=this.ready(owner,id)
    if(state.busy.has('files'))throw new AppError('BUSY','文件列表正在读取。')
    state.busy.add('files')
    const controller=new AbortController();this.active.add(controller)
    try{
      if(!state.files||state.files.revision!==this.fileRevision||state.files.path!==path||params.refresh===true||Date.now()-state.files.at>20_000)state.files={...await listDirectory(client,path,controller.signal),at:Date.now(),revision:this.fileRevision}
      this.ready(owner,id)
      return {path:state.files.path,entries:state.files.entries.slice(offset,offset+100),offset,total:state.files.entries.length,truncated:state.files.truncated}
    }catch{throw new AppError('UNAVAILABLE','无法读取该目录，请检查路径、权限或服务器的 SFTP 支持。')}
    finally{state.busy.delete('files');this.active.delete(controller)}
  }
}
