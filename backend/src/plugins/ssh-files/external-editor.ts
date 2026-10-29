import { watch, type FSWatcher } from 'node:fs'
import { mkdtemp, readFile, writeFile, stat, rm, access } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { RemoteFileJob } from '@webnav/shared'
import { AppError } from '../../core/errors.ts'
import { type RemoteFs, hash, stamp } from './remote-fs.ts'

type Options={owner:string;sessionId:string;path:string;editor:string;remote:<T>(run:(fs:RemoteFs)=>Promise<T>)=>Promise<T>;update:(patch:Partial<RemoteFileJob>)=>void;invalidate:()=>void;launch?:(executable:string,args:string[])=>Promise<void>}
export class ExternalEditor {
  private directory='';private file='';private version='';private uploaded='';private watcher?:FSWatcher;private timer?:ReturnType<typeof setTimeout>;private busy=false;private stopped=false;private paused=false
  private options:Options
  get active(){return this.busy}
  constructor(options:Options){this.options=options}
  async start(){
    if(process.platform!=='win32')throw new AppError('UNAVAILABLE','本地编辑器启动目前支持 Windows。')
    const editor=this.options.editor;let executable=''
    if(editor==='notepad')executable=join(process.env.SystemRoot??'C:\\Windows','System32','notepad.exe')
    else if(editor==='vscode'){
      for(const root of [process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code'):'',process.env.ProgramFiles?join(process.env.ProgramFiles,'Microsoft VS Code'):''])if(root){const candidate=join(root,'Code.exe');try{await access(candidate);executable=candidate;break}catch{}}
      if(!executable)throw new AppError('NOT_FOUND','未找到 VS Code，可选择记事本或内置编辑器。')
    }else throw new AppError('INVALID_ARGUMENT','请选择 VS Code 或记事本。')
    const data=await this.options.remote(fs=>fs.readFile(this.options.path,16*1024*1024));if(this.stopped)return;this.version=this.uploaded=hash(data)
    this.directory=await mkdtemp(join(tmpdir(),'webnav-edit-'))
    // Always a private fixed folder; remote names cannot create local paths or invoke associations.
    const name=posix.basename(this.options.path).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'')||'file.txt'
    this.file=join(this.directory,'edit-'+name);await writeFile(this.file,data,{mode:0o600,flag:'wx'})
    if(this.stopped){await this.stop();return}
    this.watcher=watch(this.directory,()=>this.schedule());this.watcher.on('error',()=>{this.paused=true;this.options.update({state:'error',message:'无法继续监视本地文件，可手动重试。'})})
    try{const args=editor==='vscode'?['--new-window',this.file]:[this.file];if(this.options.launch)await this.options.launch(executable,args);else await new Promise<void>((resolve,reject)=>{const child=spawn(executable,args,{stdio:'ignore',windowsHide:false,shell:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve()})})}
    catch(error){await this.stop();throw error}
    if(!this.stopped)this.options.update({state:'watching',message:'本地保存后自动回传',localPath:this.file})
  }
  private schedule(){if(this.stopped||this.paused)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.sync(false).catch(()=>{})},700)}
  async sync(overwrite=false){
    if(this.stopped||this.busy)return;this.busy=true;this.paused=false
    try{
      const before=await stat(this.file);if(before.size>16*1024*1024)throw new AppError('LIMIT','本地编辑文件超过 16 MiB，已暂停回传。')
      const data=await readFile(this.file),after=await stat(this.file)
      if(before.mtimeMs!==after.mtimeMs||before.size!==after.size){this.schedule();return}
      const next=hash(data);if(next===this.uploaded){this.options.update({state:'watching',message:'已同步，等待本地保存'});return}
      if(this.stopped)return
      this.options.update({state:'syncing',message:'正在回传'})
      await this.options.remote(async fs=>{
        const remote=await fs.fileStat(this.options.path)
        await fs.writeFile(this.options.path,data,stamp(remote),overwrite?undefined:this.version)
      })
      this.version=this.uploaded=next;this.options.invalidate();if(this.stopped)return;this.options.update({state:'watching',message:'已同步 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})})
      if(hash(await readFile(this.file))!==next)this.schedule()
    }catch(error){this.paused=true;this.options.update({state:(error as {code?:string}).code==='CONFLICT'?'conflict':'error',message:(error as Error).message+'；本地副本已保留。',localPath:this.file});throw error}
    finally{this.busy=false}
  }
  async stop(){
    this.stopped=true;clearTimeout(this.timer);this.watcher?.close()
    let clean=false;try{clean=!this.busy&&hash(await readFile(this.file))===this.uploaded}catch{}
    if(clean&&/^webnav-edit-[\w-]+$/.test(relative(tmpdir(),this.directory)))await rm(this.directory,{recursive:true,force:true}).catch(()=>{})
    this.options.update({state:'stopped',message:clean?'已停止同步':'已停止同步，本地副本保留',localPath:clean?undefined:this.file})
  }
}
