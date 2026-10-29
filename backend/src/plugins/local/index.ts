import { Service, type Context } from 'cordis'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { builtinConnectionSettings, type LocalShell } from '@webnav/shared'
import type { TerminalProvider } from '../../core/terminal-provider.ts'
import { AppError } from '../../core/errors.ts'

export async function shellCommand(choice:LocalShell,platform:NodeJS.Platform=process.platform){
  const windows=platform==='win32'
  const name=choice==='auto'?(windows?'powershell':platform==='darwin'?'zsh':'bash'):choice
  if((['powershell','cmd'].includes(name)&&!windows)||(['bash','zsh','sh'].includes(name)&&windows))throw new AppError('SHELL_UNAVAILABLE','此 Shell 不适用于当前系统。')
  if(name==='powershell')return {file:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo']}
  if(name==='cmd')return {file:join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe'),args:[]}
  const executable=name+(windows?'.exe':'')
  const dirs=[...(windows&&name==='pwsh'?[join(process.env.ProgramFiles??'C:\\Program Files','PowerShell','7')]:[]),...(process.env.PATH??'').split(delimiter)]
  for(const directory of dirs){if(!isAbsolute(directory))continue;const file=join(directory,executable);try{await access(file);return {file,args:name==='pwsh'?['-NoLogo']:['-i']}}catch{}}
  if(choice==='auto'&&!windows)return {file:'/bin/sh',args:['-i']}
  throw new AppError('SHELL_UNAVAILABLE','未找到所选 Shell，请安装后重试。')
}
export const launchLocalTerminal:TerminalProvider=async({connection,cols,rows,signal,output,exit})=>{
  const settings=builtinConnectionSettings(connection),command=await shellCommand(settings.shell)
  const cwd=settings.cwd||homedir()
  if(!isAbsolute(cwd)||!(await stat(cwd)).isDirectory())throw new AppError('INVALID_ARGUMENT','工作目录必须是已存在的绝对路径。')
  if(signal.aborted)throw new Error('Aborted')
  const source=import.meta.url.endsWith('.ts'),path=fileURLToPath(new URL(source?'./pty-host.ts':'./pty-host.js',import.meta.url))
  const child=fork(path,[],{windowsHide:true,stdio:['pipe','pipe','ignore','ipc'],execArgv:source?['--experimental-strip-types']:[]})
  let closed=false
  let killTimer:ReturnType<typeof setTimeout>|undefined
  const close=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',close);if(child.connected)child.send({type:'close'},()=>{});child.stdin?.end();child.stdout?.resume();killTimer=setTimeout(()=>child.kill(),1500);killTimer.unref()}
  signal.addEventListener('abort',close,{once:true})
  child.stdout!.on('data',(bytes:Buffer)=>{if(!closed)output(bytes)})
  child.on('exit',()=>{clearTimeout(killTimer);if(!closed)exit()})
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{close();reject(new Error('PTY startup timeout'))},10000)
    const finish=(error?:Error)=>{clearTimeout(timer);child.off('message',message);error?reject(error):resolve()}
    const message=(raw:unknown)=>{const type=(raw as {type?:string})?.type;if(type==='ready')finish();else if(type==='error'||type==='exit')finish(new Error('PTY startup failed'))}
    child.on('message',message);child.once('error',()=>finish(new Error('PTY host failed')));child.once('exit',()=>finish(new Error('PTY host exited')))
    child.send({type:'start',...command,cwd,cols,rows})
  }).catch(error=>{close();throw error})
  child.stdin!.on('error',()=>{close();exit()})
  return {write:bytes=>{if(!closed){if(child.stdin!.writableLength>128*1024)throw new AppError('FLOW_CONTROL','本地终端输入过快。');child.stdin!.write(bytes)}},resize:(cols,rows)=>{if(!closed&&child.connected)child.send({type:'resize',cols,rows},()=>{})},pause:()=>child.stdout?.pause(),resume:()=>child.stdout?.resume(),close}
}
export class LocalTerminalPlugin extends Service {
  static inject=['sessions','connectors']
  constructor(ctx:Context){
    super(ctx,'local',true)
    ctx.on('dispose',ctx.sessions.register('local',launchLocalTerminal))
    ctx.on('dispose',ctx.connectors.register('local',(owner,server,connection)=>ctx.sessions.create(owner,server,connection)))
  }
}
