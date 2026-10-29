import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import yazl from 'yazl'
import yauzl from 'yauzl'
import type { RemoteFileJob } from '@webnav/shared'
import { AppError } from '../../core/errors.ts'
import { RemoteFs, FILE_LIMIT, archiveName } from './remote-fs.ts'

export function byteLimit(limit:number){let size=0;return new Transform({transform(chunk:Buffer,_encoding,callback){size+=chunk.length;callback(size>limit?new AppError('LIMIT','压缩数据超过大小限制。'):null,chunk)}})}
export async function runArchive(fs:RemoteFs,path:string,kind:'compress'|'extract',update:(value:Partial<RemoteFileJob>)=>void,check:()=>unknown){
  if(kind==='compress'){
    const entries=await fs.tree(path),target=await fs.destination(path+'.zip'),temp=posix.join(posix.dirname(target),'.webnav-zip-'+randomUUID())
    if(await fs.stat(target))throw new AppError('CONFLICT','压缩目标已存在，请先重命名或移走。')
    const zip=new yazl.ZipFile();zip.on('error',error=>(zip.outputStream as Readable).destroy(error))
    const writing=pipeline(zip.outputStream,byteLimit(FILE_LIMIT+10*1024*1024),fs.sftp.createWriteStream(temp,{flags:'wx',mode:0o600}));void writing.catch(()=>{})
    let completed=0;update({total:entries.length,message:'正在压缩'})
    try{
      for(const item of entries){
        check();if(item.stat.isSymbolicLink())throw new AppError('INVALID_ARGUMENT','压缩暂不包含符号链接。')
        if(item.stat.isDirectory())zip.addEmptyDirectory(item.relative)
        else zip.addReadStreamLazy(item.relative,{size:item.stat.size,mtime:new Date(item.stat.mtime*1000)},cb=>{try{check();update({progress:++completed,message:'压缩 '+item.relative});cb(null,fs.sftp.createReadStream(item.path))}catch(error){cb(error as Error,undefined!)}})
      }
      zip.end();await writing;check();await fs.commit(temp,target,null);update({progress:entries.length,message:target})
    }catch(error){(zip.outputStream as Readable).destroy(error as Error);await writing.catch(()=>{});throw error}finally{await fs.unlink(temp).catch(()=>{})}
    return
  }
  if(!/\.zip$/i.test(path))throw new AppError('INVALID_ARGUMENT','当前支持 ZIP 解压。')
  const stat=await fs.fileStat(path);if(stat.size>FILE_LIMIT)throw new AppError('LIMIT','ZIP 文件超过 512 MiB。')
  const target=await fs.destination(path.replace(/\.zip$/i,'')+'-extracted')
  if(await fs.stat(target))throw new AppError('CONFLICT','解压目标已存在，请先重命名或移走。')
  const directory=await mkdtemp(join(tmpdir(),'webnav-zip-')),local=join(directory,'archive.zip'),stage=posix.join(posix.dirname(target),'.webnav-extract-'+randomUUID())
  let zip:yauzl.ZipFile|undefined,created=false
  try{
    await pipeline(fs.sftp.createReadStream(path),byteLimit(FILE_LIMIT),createWriteStream(local,{flags:'wx',mode:0o600}));check()
    zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(local,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,value)=>error?reject(error):resolve(value)))
    await fs.mkdir(stage);created=true
    const known=new Set<string>(),directories=new Set(['']);let total=0,count=0
    await new Promise<void>((resolve,reject)=>{
      const archive=zip!;archive.on('error',reject);archive.on('end',resolve)
      archive.on('entry',(entry:yauzl.Entry)=>{void(async()=>{
        check();const name=archiveName(entry.fileName);if(!name)return archive.readEntry()
        if(++count>2000||name.split('/').length>32)throw new AppError('LIMIT','压缩包超过 2,000 项或 32 层限制。')
        if(known.has(name.toLowerCase()))throw new AppError('CONFLICT','压缩包包含重复路径。');known.add(name.toLowerCase())
        if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000)throw new AppError('INVALID_ARGUMENT','压缩包包含符号链接。')
        total+=entry.uncompressedSize;if(total>FILE_LIMIT)throw new AppError('LIMIT','解压后总大小超过 512 MiB。')
        const folder=entry.fileName.endsWith('/'),parts=name.split('/'),parents=folder?parts:parts.slice(0,-1)
        let current='';for(const part of parents){current=posix.join(current,part);if(!directories.has(current)){await fs.ensureDirectory(posix.join(stage,current));directories.add(current)}}
        if(!folder){const stream=await new Promise<NodeJS.ReadableStream>((resolve,reject)=>archive.openReadStream(entry,(error,stream)=>error?reject(error):resolve(stream!)));await pipeline(stream,byteLimit(entry.uncompressedSize),fs.sftp.createWriteStream(posix.join(stage,name),{flags:'wx',mode:0o600}))}
        update({progress:count,total:archive.entryCount,message:'解压 '+name});archive.readEntry()
      })().catch(error=>{archive.close();reject(error)})})
      archive.readEntry()
    })
    check();if(await fs.stat(target))throw new AppError('CONFLICT','解压目标已被创建。');await fs.rename(stage,target);created=false
  }finally{
    zip?.close();if(created)await fs.removeTree(stage).catch(()=>{})
    if(/^webnav-zip-[\w-]+$/.test(relative(tmpdir(),directory)))await rm(directory,{recursive:true,force:true})
  }
}
