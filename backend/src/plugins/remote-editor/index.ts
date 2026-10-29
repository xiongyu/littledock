import { Service, type Context } from 'cordis'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import type { ClientChannel } from 'ssh2'
import type { RemoteEditorStatus } from '@webnav/shared'
import { AppError, record, string } from '../../core/errors.ts'
import { validateRemotePath } from '../ssh-inspector.ts'
import { editorPackages, EditorPackageCache } from './packages.ts'
import { detectPlatform, execRemote, installCommand, launchCommand, listeningPort, mkdirs, putFile, uploadPackage } from './remote.ts'
import { editorGateway, type EditorGateway } from './proxy.ts'
import { editorErrorMessage } from './errors.ts'

type Lease=Awaited<ReturnType<Context['sshFiles']['lease']>>
type Job={status:RemoteEditorStatus;owner:string;controller:AbortController;lease?:Lease;home?:string;base?:string;install?:string;run?:string;gateway?:EditorGateway;channel?:ClientChannel;heartbeat?:ReturnType<typeof setInterval>;disconnect?:()=>void;updated:number;task?:Promise<void>;releasing?:Promise<void>}
declare module 'cordis' { interface Context { remoteEditor:RemoteEditorService } }
export class RemoteEditorService extends Service {
  static inject=['sshFiles','credentials','auth','sessions']
  private jobs=new Map<string,Job>()
  private cache:Pick<EditorPackageCache,'ensure'>
  private enabled:boolean
  constructor(ctx:Context,config:{directory:string;enabled?:boolean;packageDirectory?:string;cache?:Pick<EditorPackageCache,'ensure'>}) {
    super(ctx,'remoteEditor',true);this.enabled=config.enabled!==false
    this.cache=config.cache??new EditorPackageCache(config.packageDirectory??process.env.WEBNAV_EDITOR_PACKAGE_DIR??join(config.directory,'editor-packages'))
    const unwatch=ctx.credentials.subscribe(status=>{if(!status.unlocked)for(const job of this.jobs.values())void this.stopJob(job)})
    const timer=setInterval(()=>{for(const [id,job]of this.jobs){if(!ctx.auth.authorized(job.owner))void this.stopJob(job);if(['stopped','error','needs-install'].includes(job.status.state)&&Date.now()-job.updated>600_000){void this.stopJob(job);this.jobs.delete(id)}}},15_000)
    ctx.on('dispose',async()=>{unwatch();clearInterval(timer);await Promise.allSettled([...this.jobs.values()].map(job=>this.stopJob(job)));await Promise.allSettled([...this.jobs.values()].map(job=>job.task));this.jobs.clear()})
  }
  private owned(owner:string,id:unknown) {const job=this.jobs.get(string(id,100));if(!job||job.owner!==owner)throw new AppError('NOT_FOUND','编辑器任务不存在。');return job}
  private publish(job:Job,state:RemoteEditorStatus['state'],message:string,progress?:number){if(job.controller.signal.aborted)return;Object.assign(job.status,{state,message,progress});job.updated=Date.now()}
  private work(job:Job,run:()=>Promise<void>){
    let timer:ReturnType<typeof setTimeout>|undefined
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('编辑器准备超时，请检查网络和远端状态后重试。')),25*60_000)})
    job.task=Promise.race([run(),deadline]).catch(async error=>{if(!job.controller.signal.aborted){this.publish(job,'error',editorErrorMessage(error,job.status.state));job.controller.abort();await this.release(job)}}).finally(()=>clearTimeout(timer))
  }
  prepare(owner:string,input:unknown) {
    if(!this.enabled)throw new AppError('NOT_IMPLEMENTED','远程编辑器插件未启用。')
    const p=record(input),sessionId=string(p.sessionId,100),folder=validateRemotePath(p.folder)
    this.ctx.sshFiles.ready(owner,sessionId)
    const old=[...this.jobs.values()].find(job=>job.owner===owner&&job.status.sessionId===sessionId&&job.status.folder===folder&&!['error','stopped'].includes(job.status.state))
    if(old)return {...old.status}
    if([...this.jobs.values()].filter(job=>!['error','stopped'].includes(job.status.state)).length>=4)throw new AppError('LIMIT','最多同时准备或运行 4 个编辑器。')
    const job:Job={status:{id:randomUUID(),sessionId,folder,state:'checking',message:'检查远端环境…'},owner,controller:new AbortController(),updated:Date.now()};this.jobs.set(job.status.id,job)
    this.work(job,()=>this.check(job));return {...job.status}
  }
  status(owner:string,input:unknown){const job=this.owned(owner,record(input).id);this.ctx.credentials.requireUnlocked();return {...job.status}}
  install(owner:string,input:unknown){
    const p=record(input),job=this.owned(owner,p.id);this.ctx.sshFiles.ready(owner,job.status.sessionId)
    if(job.status.state!=='needs-install')throw new AppError('CONFLICT','当前任务不需要安装。')
    const pkg=editorPackages[job.status.platform!]
    if(pkg.licenseUrl&&p.acceptLicense!==true)throw new AppError('LICENSE_REQUIRED','请先阅读并接受 VS Code Server 使用条款。')
    this.publish(job,'downloading','检查本机安装包缓存…',0)
    this.work(job,async()=>{
      const signal=job.controller.signal,archive=await this.cache.ensure(pkg,signal,p=>this.publish(job,'downloading','下载安装包到本机缓存…',p));signal.throwIfAborted()
      const fs=job.lease!.fs,remoteArchive=posix.join(job.base!,job.status.id+(pkg.platform.startsWith('windows')?'.zip':'.tar.gz')),stage=posix.join(job.base!,'stage-'+job.status.id)
      this.publish(job,'uploading','通过 SSH 上传安装包…',0)
      await mkdirs(fs,job.home!,['.webnav-editor',pkg.platform])
      try{
        await uploadPackage(fs,archive,remoteArchive,signal,p=>this.publish(job,'uploading','通过 SSH 上传安装包…',p));signal.throwIfAborted()
        this.publish(job,'installing','校验并解压到远端用户目录…')
        await execRemote(job.lease!.client,installCommand(pkg,remoteArchive,stage,job.install!),signal,180_000,'drain')
      }finally{await fs.unlink(remoteArchive).catch(()=>{})}
      await this.startEditor(job)
    });return {...job.status}
  }
  async stopOwned(owner:string,input:unknown){await this.stopJob(this.owned(owner,record(input).id));return {}}
  private async check(job:Job){
    const lease=await this.ctx.sshFiles.lease(job.owner,job.status.sessionId);if(job.controller.signal.aborted){lease.close();return}job.lease=lease
    job.disconnect=()=>{void this.stopJob(job)};lease.client.once('close',job.disconnect)
    const signal=job.controller.signal,platform=await detectPlatform(lease.client,signal),pkg=editorPackages[platform]
    job.home=await lease.fs.realpath('.');job.status.folder=await lease.fs.realpath(job.status.folder)
    const folder=await lease.fs.stat(job.status.folder);if(!folder?.isDirectory())throw new Error('请选择要打开的文件夹。')
    signal.throwIfAborted()
    Object.assign(job.status,{platform,product:pkg.product,version:pkg.version,licenseUrl:pkg.licenseUrl})
    // Inspection is read-only. Directories are only created after the install/open action.
    job.base=posix.join(job.home,'.webnav-editor',platform);job.install=posix.join(job.base,pkg.version)
    const marker=posix.join(job.install,'webnav-install.json')
    if(await lease.fs.stat(marker)){
      const data:unknown=JSON.parse((await lease.fs.readFile(marker,4096)).toString());const saved=record(data)
      if(saved.sha256!==pkg.sha256||(pkg.licenseUrl&&saved.licenseAccepted!==true))throw new Error('已安装编辑器的版本记录不匹配，请检查远端安装目录。')
      await this.startEditor(job)
    }else if(await lease.fs.stat(job.install))this.publish(job,'needs-install','检测到上次安装未完成；重新安装时会保留旧目录，再安装完整版本。')
    else this.publish(job,'needs-install','首次使用需安装到远端用户目录；安装包会保留在本机供以后复用。')
  }
  private async startEditor(job:Job){
    const lease=job.lease!,pkg=editorPackages[job.status.platform!],signal=job.controller.signal
    this.ctx.sshFiles.ready(job.owner,job.status.sessionId);signal.throwIfAborted()
    await mkdirs(lease.fs,job.home!,['.webnav-editor',pkg.platform,'data'])
    signal.throwIfAborted()
    job.run=await mkdirs(lease.fs,job.home!,['.webnav-editor',pkg.platform,'sessions',job.status.id])
    const heartbeat=posix.join(job.run,'heartbeat'),token=randomBytes(32).toString('hex')
    await putFile(lease.fs,heartbeat,Buffer.from('1'))
    if(pkg.platform.startsWith('windows'))await putFile(lease.fs,posix.join(job.run,'token'),Buffer.from(token))
    else await putFile(lease.fs,posix.join(job.run,'config.yaml'),Buffer.from('bind-addr: 127.0.0.1:0\nauth: none\ncert: false\ndisable-telemetry: true\ndisable-update-check: true\n'))
    signal.throwIfAborted()
    let touching=false
    // Writing uses the remote filesystem clock. Local timestamps break the watchdog
    // when the local and remote computers have different clock offsets.
    job.heartbeat=setInterval(()=>{if(touching||signal.aborted)return;touching=true;void putFile(lease.fs,heartbeat,Buffer.from('1')).catch(()=>this.stopJob(job)).finally(()=>{touching=false})},10_000)
    this.publish(job,'starting','启动远端编辑器并建立 SSH 转发…')
    const port=await new Promise<number>((resolve,reject)=>{
      let done=false,output='';const finish=(error?:Error,port?:number)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);if(error)reject(error);else resolve(port!)}
      const aborted=()=>finish(new Error('编辑器已停止。')),timer=setTimeout(()=>finish(new Error('编辑器启动超时，请检查系统依赖、可用内存与执行权限。')),90_000)
      signal.addEventListener('abort',aborted,{once:true});if(signal.aborted){aborted();return}
      lease.client.exec(launchCommand(pkg,job.install!,posix.join(job.base!,'data'),job.run!),(error,ch)=>{
        if(signal.aborted||done){ch?.close();return}if(error){finish(new Error('无法启动远端编辑器。'));return}job.channel=ch
        const read=(bytes:Buffer)=>{output=(output+bytes.toString('utf8')).slice(-8192);const port=listeningPort(output);if(port)finish(undefined,port)}
        ch.on('data',read);ch.stderr.on('data',read)
        ch.on('error',()=>finish(new Error('编辑器启动通道异常。')))
        ch.once('close',()=>{if(!done)finish(new Error('编辑器启动失败，请检查系统依赖。'));else if(job.status.state==='ready'){this.publish(job,'error','远端编辑器已退出。');void this.release(job)}})
      })
    })
    signal.throwIfAborted()
    job.gateway=await editorGateway(lease.client,port,pkg.platform.startsWith('windows')?token:undefined,cookie=>!signal.aborted&&this.ctx.credentials.status().unlocked&&this.ctx.auth.session(cookie)?.id===job.owner&&this.ctx.auth.authorized(job.owner))
    if(signal.aborted){await job.gateway.close();return}
    // VS Code treats a leading slash as a remote resource. A bare C:/ path is
    // parsed as URI scheme "c" and has no filesystem provider in the browser.
    const url=new URL(job.gateway.url);url.searchParams.set('folder',job.status.folder)
    job.status.url=url.href;this.publish(job,'ready','编辑器已就绪')
  }
  private release(job:Job):Promise<void>{
    return job.releasing??=this.releaseResources(job)
  }
  private async releaseResources(job:Job){
    clearInterval(job.heartbeat);job.heartbeat=undefined;delete job.status.url
    await job.gateway?.close();job.gateway=undefined
    if(job.run&&job.lease){
      const fs=job.lease.fs,run=job.run;let timer:ReturnType<typeof setTimeout>|undefined
      await Promise.race([(async()=>{await fs.unlink(posix.join(run,'heartbeat')).catch(()=>{});await fs.unlink(posix.join(run,'token')).catch(()=>{});await fs.unlink(posix.join(run,'config.yaml')).catch(()=>{});await fs.rmdir(run).catch(()=>{})})(),new Promise<void>(resolve=>{timer=setTimeout(resolve,2000)})]).finally(()=>clearTimeout(timer))
    }
    job.channel?.close();job.channel=undefined
    if(job.disconnect)job.lease?.client.off('close',job.disconnect)
    job.lease?.close();job.lease=undefined
  }
  private async stopJob(job:Job){if(job.controller.signal.aborted)return;job.controller.abort();job.status.state='stopped';job.status.message='编辑器已停止';job.updated=Date.now();await this.release(job)}
}
