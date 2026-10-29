import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { EditorPlatform } from '@webnav/shared'

export interface EditorPackage { platform: EditorPlatform; product: string; version: string; file: string; url: string; sha256: string; root: string; licenseUrl?: string }
// Update versions and their vendor-published digests together, never resolve latest during installation.
export const editorPackages: Record<EditorPlatform, EditorPackage> = {
  'linux-x64': { platform:'linux-x64', product:'code-server', version:'4.143.1', file:'code-server-4.143.1-linux-amd64.tar.gz', root:'code-server-4.143.1-linux-amd64', url:'https://github.com/coder/code-server/releases/download/v4.143.1/code-server-4.143.1-linux-amd64.tar.gz', sha256:'614877cf71005f14ea252bd2d9b1c12237cf7d73681ef150f0dff7f13849fdb5' },
  'linux-arm64': { platform:'linux-arm64', product:'code-server', version:'4.143.1', file:'code-server-4.143.1-linux-arm64.tar.gz', root:'code-server-4.143.1-linux-arm64', url:'https://github.com/coder/code-server/releases/download/v4.143.1/code-server-4.143.1-linux-arm64.tar.gz', sha256:'51481a891754dc2585b86d007aec24ac675453fc5ef6cfa346c4462449277384' },
  'windows-x64': { platform:'windows-x64', product:'VS Code Server Web', version:'1.143.1', file:'vscode-server-1.143.1-win32-x64-web.zip', root:'vscode-server-win32-x64-web', url:'https://vscode.download.prss.microsoft.com/dbazure/download/stable/e646868227c3e3a9e3f24277c8c7220be42c0be7/vscode-server-win32-x64-web.zip', sha256:'02768ff37e1697a8a9e8258a4091bd3d2da7e83821c0e3f2cf3bdfcfadbda3b9', licenseUrl:'https://aka.ms/vscode-server-license' },
  'windows-arm64': { platform:'windows-arm64', product:'VS Code Server Web', version:'1.143.1', file:'vscode-server-1.143.1-win32-arm64-web.zip', root:'vscode-server-win32-arm64-web', url:'https://vscode.download.prss.microsoft.com/dbazure/download/stable/e646868227c3e3a9e3f24277c8c7220be42c0be7/vscode-server-win32-arm64-web.zip', sha256:'f0025a8ff7f76e55ca7702268596ee0e26fe50a8bd505a1f878bcd9a31947f81', licenseUrl:'https://aka.ms/vscode-server-license' },
}
export async function fileDigest(path: string) {
  const hash=createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
export class EditorPackageCache {
  private pending=new Map<string,Promise<string>>()
  readonly directory: string
  constructor(directory: string) { this.directory=directory }
  async ensure(pkg:EditorPackage, signal:AbortSignal, report:(percent:number)=>void=()=>{}):Promise<string> {
    const old=this.pending.get(pkg.file);if(old)return old
    const promise=this.download(pkg,signal,report);this.pending.set(pkg.file,promise)
    try{return await promise}finally{this.pending.delete(pkg.file)}
  }
  private async download(pkg:EditorPackage,signal:AbortSignal,report:(percent:number)=>void) {
    await mkdir(this.directory,{recursive:true});const path=join(this.directory,pkg.file)
    try { if((await stat(path)).isFile()) { if(await fileDigest(path)===pkg.sha256)return path;throw new Error('安装包校验失败，请移除本机缓存中的 '+pkg.file+' 后重试。') } }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const temp=path+'.'+randomUUID()+'.part',limit=512*1024*1024
    try {
      const response=await fetch(pkg.url,{signal:AbortSignal.any([signal,AbortSignal.timeout(600_000)])})
      if(!response.ok||!response.body)throw new Error('安装包下载失败（HTTP '+response.status+'）。')
      const total=Number(response.headers.get('content-length'))||0;if(total>limit)throw new Error('安装包超出 512 MiB 限制。')
      let count=0,last=-1;const hash=createHash('sha256')
      const reader=response.body.getReader()
      const source=Readable.from((async function*(){try{for(;;){const result=await reader.read();if(result.done)break;yield result.value}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}})())
      await pipeline(source,new Transform({transform(chunk:Buffer,_encoding,done){count+=chunk.length;if(count>limit){done(new Error('安装包过大。'));return}hash.update(chunk);const percent=total?Math.min(99,Math.floor(count/total*100)):0;if(percent!==last){last=percent;report(percent)}done(null,chunk)}}),createWriteStream(temp,{flags:'wx',mode:0o600}),{signal})
      if(hash.digest('hex')!==pkg.sha256)throw new Error('下载的安装包校验失败，没有安装。')
      await rename(temp,path);report(100);return path
    }finally{await rm(temp,{force:true})}
  }
}
