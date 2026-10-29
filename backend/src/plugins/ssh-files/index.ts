import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import iconv from 'iconv-lite'
import type { RemoteTextFile, RemoteTextEncoding, RemoteFileJob } from '@webnav/shared'
import { AppError, integer, record, string } from '../../core/errors.ts'
import { validateRemotePath } from '../ssh-inspector.ts'
import { CHUNK, FILE_LIMIT, TEXT_LIMIT, RemoteFs, hash, stamp, childName } from './remote-fs.ts'
import { runArchive } from './zip.ts'
import { ExternalEditor } from './external-editor.ts'

export function decodeText(path: string, data: Buffer): RemoteTextFile {
  let encoding: RemoteTextEncoding = 'utf8', bom = false, body = data
  if (data.subarray(0,3).equals(Buffer.from([239,187,191]))) { bom=true; body=data.subarray(3) }
  else if(data.subarray(0,2).equals(Buffer.from([255,254]))) { encoding='utf16le';bom=true;body=data.subarray(2) }
  else if(data.subarray(0,2).equals(Buffer.from([254,255]))) { encoding='utf16be';bom=true;body=data.subarray(2) }
  else { try { new TextDecoder('utf-8',{fatal:true}).decode(data) } catch { encoding='gb18030' } }
  const text=iconv.decode(body,encoding)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || text.includes('\uFFFD')) throw new AppError('BINARY','此文件不是可识别的文本，请下载或使用本地编辑器。')
  return {path,text,version:hash(data),encoding,bom,lineEnding:text.includes('\r\n')?'CRLF':'LF'}
}
export function encodeText(params: Record<string,unknown>) {
  const text=string(params.text,TEXT_LIMIT*2,true), encoding=string(params.encoding) as RemoteTextEncoding
  if(!['utf8','utf16le','utf16be','gb18030'].includes(encoding))throw new AppError('INVALID_ARGUMENT','不支持此编码。')
  if(presentInvalidLineEnding(params.lineEnding))throw new AppError('INVALID_ARGUMENT','换行符必须是 LF 或 CRLF。')
  const normalized=text.replace(/\r\n/g,'\n'), output=params.lineEnding==='CRLF'?normalized.replace(/\n/g,'\r\n'):normalized
  const bytes=iconv.encode(output,encoding)
  if(iconv.decode(bytes,encoding)!==output)throw new AppError('ENCODING','当前编码不能保存部分字符，请改用 UTF-8。')
  const prefix=params.bom===true?encoding==='utf8'?[239,187,191]:encoding==='utf16le'?[255,254]:encoding==='utf16be'?[254,255]:[]:[]
  const data=Buffer.concat([Buffer.from(prefix),bytes]);if(data.length>TEXT_LIMIT)throw new AppError('LIMIT','内置编辑器最多保存 512 KiB 文本。');return data
}
function presentInvalidLineEnding(value:unknown){return value!==undefined&&value!=='LF'&&value!=='CRLF'}
type Lease={fs:RemoteFs;close:()=>void;client:Client}
type Transfer={id:string;owner:string;sessionId:string;path:string;temp?:string;expected:string|null;size:number;offset:number;handle:Buffer;lease:Lease;kind:'upload'|'download';busy:boolean;at:number;onClose?:()=>void}
type Job=RemoteFileJob&{owner:string;sessionId:string;at:number;editor?:ExternalEditor;lease?:Lease;cancelled?:boolean;disconnect?:()=>void}
declare module 'cordis' { interface Context { sshFiles:SshFilesService } }
export class SshFilesService extends Service {
  static inject=['sessions','credentials','sshInspector']
  private leases=new Set<Lease>()
  private pendingLeases=0
  private transfers=new Map<string,Transfer>()
  private jobs=new Map<string,Job>()
  get updateBusy(){return this.pendingLeases>0||[...this.transfers.values()].some(t=>t.busy)||[...this.jobs.values()].some(j=>j.state==='working'||j.editor?.active)}
  constructor(ctx:Context){
    super(ctx,'sshFiles',true)
    const unsubscribe=ctx.credentials.subscribe(status=>{if(!status.unlocked){for(const t of this.transfers.values())void this.release(t);for(const job of this.jobs.values())void this.stopJob(job)}})
    const timer=setInterval(()=>{for(const t of this.transfers.values())if(Date.now()-t.at>180_000)void this.release(t);for(const j of this.jobs.values())if(!j.editor&&j.state!=='working'&&Date.now()-j.at>600_000)this.jobs.delete(j.id)},30_000)
    ctx.on('dispose',async()=>{unsubscribe();clearInterval(timer);await Promise.allSettled([...this.transfers.values()].map(t=>this.release(t)));for(const job of this.jobs.values())await this.stopJob(job);for(const lease of this.leases)lease.close();this.jobs.clear()})
  }
  ready(owner:string,id:string){
    this.ctx.credentials.requireUnlocked();const s=this.ctx.sessions.owned(owner,id)
    if(!s.client||!s.channel||s.closed||s.finished)throw new AppError('CONFLICT','SSH 已断开，无法操作文件。')
    return s.client
  }
  async lease(owner:string,id:string):Promise<Lease>{
    const client=this.ready(owner,id)
    if(this.leases.size+this.pendingLeases>=12)throw new AppError('BUSY','文件任务较多，请稍后再试。')
    this.pendingLeases++
    const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>{let expired=false;const timer=setTimeout(()=>{expired=true;reject(new AppError('TIMEOUT','SFTP 连接超时。'))},8000);client.sftp((error,channel)=>{clearTimeout(timer);if(expired){channel?.end();return}if(error)reject(error);else resolve(channel)})}).finally(()=>this.pendingLeases--)
    const lease:Lease={client,fs:new RemoteFs(sftp),close:()=>{sftp.end();this.leases.delete(lease)}}
    sftp.on('error',()=>{});sftp.once('close',()=>this.leases.delete(lease));this.leases.add(lease)
    try{this.ready(owner,id)}catch(error){lease.close();throw error}return lease
  }
  async withRemote<T>(owner:string,id:string,run:(fs:RemoteFs)=>Promise<T>):Promise<T>{
    const lease=await this.lease(owner,id);let timer:ReturnType<typeof setTimeout>|undefined
    try{const result=await Promise.race([run(lease.fs),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('TIMEOUT','文件操作超时，请核对远端结果后再操作。')),25_000)})]);this.ready(owner,id);return result}
    catch(error){throw this.publicError(error)}finally{clearTimeout(timer);lease.close()}
  }
  private publicError(error:unknown){return error instanceof AppError?error:new AppError('FILE_ERROR','文件操作失败：'+((error as Error)?.message||'请检查权限和连接。').slice(0,240))}
  async readText(owner:string,input:unknown){const p=record(input),id=string(p.sessionId),path=validateRemotePath(p.path);return this.withRemote(owner,id,async fs=>decodeText(path,await fs.readFile(path,TEXT_LIMIT)))}
  async directory(owner:string,input:unknown){
    const id=string(record(input).sessionId);this.ready(owner,id);const current=this.ctx.sessions.directory(owner,id)
    if(!current.path)return {path:'',revision:0}
    return this.withRemote(owner,id,async fs=>{const path=current.path.startsWith('~')?posix.join(await fs.realpath('.'),current.path.slice(2)):current.path;return {path:await fs.realpath(path),revision:current.revision}})
  }
  async saveText(owner:string,input:unknown){
    const p=record(input),id=string(p.sessionId),path=validateRemotePath(p.path),version=string(p.version,64),data=encodeText(p)
    return this.withRemote(owner,id,async fs=>{const stat=await fs.fileStat(path);await fs.writeFile(path,data,stamp(stat),version);this.invalidate(id);return {version:hash(data)}})
  }
  invalidate(_id:string){this.ctx.sshInspector.invalidateFiles()}
  async action(owner:string,input:unknown){
    const p=record(input),id=string(p.sessionId),path=validateRemotePath(p.path),action=string(p.action)
    return this.withRemote(owner,id,async fs=>{
      if(action==='properties'){const s=await fs.stat(path);if(!s)throw new AppError('NOT_FOUND','文件已不存在。');return {path,size:s.size,modifiedAt:s.mtime*1000,permissions:(s.mode&0o7777).toString(8),owner:s.uid+':'+s.gid,kind:s.isDirectory()?'directory':s.isSymbolicLink()?'link':'file'}}
      if(action==='mkdir'||action==='create'){
        const target=posix.join(await fs.realpath(path),childName(p.name)),existing=await fs.stat(target)
        if(existing){if(action==='mkdir'&&p.ensure===true&&existing.isDirectory())return {path:target};throw new AppError('CONFLICT','同名文件或文件夹已经存在。')}
        if(action==='mkdir')await fs.mkdir(target);else await fs.writeFile(target,Buffer.alloc(0),null)
        this.invalidate(id);return {path:target}
      }
      if(action==='rename'){
        const target=posix.join(posix.dirname(path),childName(p.name));if(await fs.stat(target))throw new AppError('CONFLICT','同名目标已经存在。');await fs.rename(path,target);this.invalidate(id);return {path:target}
      }
      if(action==='remove'){
        if(p.confirm!==true)throw new AppError('INVALID_ARGUMENT','请确认删除。')
        await fs.removeTree(path);this.invalidate(id);return {removed:true}
      }
      if(action==='chmod'){
        const mode=string(p.mode,4);if(!/^[0-7]{3,4}$/.test(mode))throw new AppError('INVALID_ARGUMENT','权限须为 3–4 位八进制数字。')
        const stat=await fs.stat(path);if(!stat||stat.isSymbolicLink())throw new AppError('INVALID_ARGUMENT','请选择普通文件或文件夹。');await fs.chmod(path,parseInt(mode,8));this.invalidate(id);return {saved:true}
      }
      throw new AppError('INVALID_ARGUMENT','未知文件操作。')
    })
  }
  async begin(owner:string,input:unknown){
    const p=record(input),sessionId=string(p.sessionId),kind=p.kind==='upload'?'upload':p.kind==='download'?'download':undefined
    if(!kind)throw new AppError('INVALID_ARGUMENT','未知传输方式。')
    if(this.transfers.size>=8)throw new AppError('BUSY','同时最多 8 个文件传输。')
    const lease=await this.lease(owner,sessionId),fs=lease.fs;let temp:string|undefined
    try{
      const path=kind==='upload'?await fs.destination(validateRemotePath(p.path)):validateRemotePath(p.path),stat=await fs.stat(path)
      if(kind==='upload'&&stat&&p.overwrite!==true)throw new AppError('EXISTS','目标存在同名文件。')
      if(stat&&!stat.isFile())throw new AppError('INVALID_ARGUMENT','目标不是普通文件。')
      const size=kind==='upload'?integer(p.size,0,FILE_LIMIT):(await fs.fileStat(path)).size
      if(size>FILE_LIMIT)throw new AppError('LIMIT','单文件最多 512 MiB。')
      if(kind==='upload')temp=posix.join(posix.dirname(path),'.webnav-upload-'+randomUUID())
      const handle=await fs.open(temp??path,kind==='upload'?'wx':'r'),id=randomUUID()
      const transfer:Transfer={id,owner,sessionId,path,temp,expected:stamp(stat),size,offset:0,handle,lease,kind,busy:false,at:Date.now()}
      transfer.onClose=()=>{void this.release(transfer)};this.transfers.set(id,transfer);lease.client.once('close',transfer.onClose)
      return {id,size,path}
    }catch(error){if(temp)await fs.unlink(temp).catch(()=>{});lease.close();throw this.publicError(error)}
  }
  private transfer(owner:string,p:Record<string,unknown>){const t=this.transfers.get(string(p.id));if(!t||t.owner!==owner)throw new AppError('NOT_FOUND','传输已结束或不存在。');this.ready(owner,t.sessionId);if(t.busy)throw new AppError('BUSY','上一块数据尚未完成。');t.at=Date.now();return t}
  async chunk(owner:string,input:unknown){
    const p=record(input),t=this.transfer(owner,p);t.busy=true
    try{
      if(integer(p.offset,0,FILE_LIMIT)!==t.offset)throw new AppError('CONFLICT','文件块位置不一致，传输已暂停。')
      if(t.kind==='download'){
        if(stamp(await t.lease.fs.stat(t.path))!==t.expected)throw new AppError('CONFLICT','文件在下载时发生变化。')
        const data=t.offset===t.size?Buffer.alloc(0):await t.lease.fs.read(t.handle,t.offset,Math.min(CHUNK,t.size-t.offset));t.offset+=data.length
        const complete=t.offset===t.size;if(!complete&&!data.length)throw new AppError('CONFLICT','文件长度已变化。')
        if(complete)await this.release(t)
        return {data:data.toString('base64'),offset:t.offset,done:complete}
      }
      const encoded=string(p.data,CHUNK*2,true)
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new AppError('INVALID_ARGUMENT','无效文件块。')
      const data=Buffer.from(encoded,'base64');if(data.length>CHUNK||t.offset+data.length>t.size)throw new AppError('LIMIT','文件块超过限制。')
      await t.lease.fs.write(t.handle,data,t.offset);t.offset+=data.length;return {offset:t.offset}
    }catch(error){await this.release(t);throw this.publicError(error)}finally{t.busy=false}
  }
  async commit(owner:string,input:unknown){
    const t=this.transfer(owner,record(input));t.busy=true
    try{if(t.kind!=='upload'||t.offset!==t.size)throw new AppError('CONFLICT','文件还未完整上传。');await t.lease.fs.close(t.handle);await t.lease.fs.commit(t.temp!,t.path,t.expected);t.temp=undefined;this.invalidate(t.sessionId);return {path:t.path}}
    catch(error){throw this.publicError(error)}finally{await this.release(t)}
  }
  async cancel(owner:string,input:unknown){const t=this.transfers.get(string(record(input).id));if(t?.owner===owner)await this.release(t);return {cancelled:true}}
  private async release(t:Transfer){if(!this.transfers.delete(t.id))return;if(t.onClose)t.lease.client.off('close',t.onClose);await t.lease.fs.close(t.handle).catch(()=>{});if(t.temp)await t.lease.fs.unlink(t.temp).catch(()=>{});t.lease.close()}
  async startJob(owner:string,input:unknown){
    const p=record(input),sessionId=string(p.sessionId),path=validateRemotePath(p.path),kind=string(p.kind)
    this.ready(owner,sessionId)
    if(!['compress','extract','external'].includes(kind))throw new AppError('INVALID_ARGUMENT','未知任务。')
    if([...this.jobs.values()].filter(j=>j.state==='working'||j.editor).length>=4)throw new AppError('BUSY','同时最多 4 个压缩或本地编辑任务。')
    if(this.jobs.size>=32){const old=[...this.jobs.values()].find(j=>!j.editor&&j.state!=='working');if(old)this.jobs.delete(old.id);else throw new AppError('BUSY','文件任务已满。')}
    const job:Job={id:randomUUID(),owner,sessionId,path,kind:kind as Job['kind'],state:'working',progress:0,total:0,message:'准备中',at:Date.now()};this.jobs.set(job.id,job)
    void (async()=>{
      try{
        if(kind==='external'){
          const editor=new ExternalEditor({owner,sessionId,path,editor:string(p.editor),remote:run=>{const gate=this.ctx.get('maintenance');return gate?gate.run(true,()=>this.withRemote(owner,sessionId,run)):this.withRemote(owner,sessionId,run)},update:patch=>{if(!job.cancelled||patch.state==='stopped')Object.assign(job,patch);job.at=Date.now()},invalidate:()=>this.invalidate(sessionId)})
          job.editor=editor;await editor.start();if(job.cancelled){await editor.stop();job.editor=undefined;return}
          const client=this.ready(owner,sessionId),onClose=()=>{void this.stopJob(job)};client.once('close',onClose);job.disconnect=()=>client.off('close',onClose)
        }else{
          const lease=await this.lease(owner,sessionId);if(job.cancelled){lease.close();return}job.lease=lease
          const timeout=setTimeout(()=>lease.close(),600_000)
          try{await runArchive(lease.fs,path,kind as 'compress'|'extract',patch=>{if(!job.cancelled)Object.assign(job,patch)},()=>{if(job.cancelled)throw new AppError('CANCELLED','任务已停止。');return this.ready(owner,sessionId)});this.invalidate(sessionId);if(!job.cancelled){job.state='done';job.message='已完成'}}finally{clearTimeout(timeout);lease.close();job.lease=undefined}
        }
      }catch(error){if(kind==='external'&&job.editor&&!job.localPath){await job.editor.stop();job.editor=undefined}if(!job.cancelled){job.state=(error as {code?:string}).code==='CONFLICT'?'conflict':'error';job.message=this.publicError(error).message}}
      job.at=Date.now()
    })()
    return {id:job.id}
  }
  status(owner:string,input:unknown){const id=string(record(input).sessionId);this.ready(owner,id);return [...this.jobs.values()].filter(j=>j.owner===owner&&j.sessionId===id).map(({owner,sessionId,at,editor,lease,cancelled,disconnect,...publicJob})=>publicJob)}
  private async stopJob(job:Job){job.cancelled=true;job.disconnect?.();job.disconnect=undefined;job.lease?.close();await job.editor?.stop();job.editor=undefined;job.state='stopped';job.message=job.localPath?'已停止同步，本地副本请自行保留':'已停止';job.at=Date.now()}
  async jobAction(owner:string,input:unknown){
    const p=record(input),job=this.jobs.get(string(p.id));if(!job||job.owner!==owner)throw new AppError('NOT_FOUND','任务不存在。')
    if(p.action==='retry'){this.ready(owner,job.sessionId);if(!job.editor)throw new AppError('CONFLICT','任务不可重试。');await job.editor.sync(p.overwrite===true);return {saved:true}}
    if(p.action!=='stop')throw new AppError('INVALID_ARGUMENT','未知任务操作。');await this.stopJob(job);return {stopped:true}
  }
}
