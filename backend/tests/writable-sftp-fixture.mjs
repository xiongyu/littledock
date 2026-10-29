import * as fs from 'node:fs/promises'
import { join,resolve,relative,posix } from 'node:path'
import ssh2 from 'ssh2'
export async function seedRemoteFiles(root){
  const home=join(root,'home','fixture');await fs.mkdir(join(home,'projects','empty'),{recursive:true})
  await fs.writeFile(join(home,'README.md'),'# WebNav 文件测试\r\n你好，世界。\r\n')
  await fs.writeFile(join(home,'settings.json'),'{\n  "name": "测试配置",\n  "enabled": true\n}\n')
  await fs.writeFile(join(home,'projects','notes.txt'),'项目目录\n')
  await fs.writeFile(join(home,'binary.dat'),Buffer.from([0,1,2,3,255]))
  return home
}
export function writableSftp(session,root,{maxWriteSize=Infinity}={}){
  session.on('sftp',accept=>{
    const stream=accept(),handles=new Map();let serial=0
    const remote=path=>posix.resolve('/home/fixture',path)
    const local=path=>{const dest=resolve(root,'.'+remote(path));if(relative(root,dest).startsWith('..'))throw new Error('out of fixture');return dest}
    const attrs=s=>({mode:s.mode,size:s.size,uid:1000,gid:1000,atime:Math.floor(s.atimeMs/1000),mtime:Math.floor(s.mtimeMs/1000)})
    const send=(method,...args)=>{if(!stream.destroyed)stream[method](...args)}
    const fail=(id,error)=>send('status',id,error.code==='ENOENT'?2:error.code==='EACCES'||error.code==='EPERM'?3:4,error.message)
    function on(event,run){stream.on(event,(id,...args)=>{void Promise.resolve().then(()=>run(id,...args)).catch(error=>fail(id,error))})}
    on('REALPATH',async(id,path)=>{await fs.lstat(local(path));send('name',id,[{filename:remote(path),longname:'',attrs:{}}])})
    for(const op of ['STAT','LSTAT'])on(op,async(id,path)=>send('attrs',id,attrs(await fs.lstat(local(path)))))
    on('OPEN',async(id,path,flags,a)=>{const fd=await fs.open(local(path),ssh2.utils.sftp.flagsToString(flags),a.mode??0o600);const handle=Buffer.from(String(++serial));handles.set(handle.toString(),{fd});send('handle',id,handle)})
    on('FSTAT',async(id,handle)=>send('attrs',id,attrs(await handles.get(handle.toString()).fd.stat())))
    on('READ',async(id,handle,offset,length)=>{const bytes=Buffer.alloc(Math.min(length,128*1024));const {bytesRead}=await handles.get(handle.toString()).fd.read(bytes,0,bytes.length,offset);if(bytesRead)send('data',id,bytes.subarray(0,bytesRead));else send('status',id,1)})
    on('WRITE',async(id,handle,offset,data)=>{if(data.length>maxWriteSize){send('status',id,4,'Failure');return}await handles.get(handle.toString()).fd.write(data,0,data.length,offset);send('status',id,0)})
    on('OPENDIR',async(id,path)=>{const entries=await fs.readdir(local(path)),handle=Buffer.from(String(++serial));handles.set(handle.toString(),{path,entries,offset:0});send('handle',id,handle)})
    on('READDIR',async(id,handle)=>{const h=handles.get(handle.toString());if(h.offset>=h.entries.length){send('status',id,1);return}const names=h.entries.slice(h.offset,h.offset+100);h.offset+=names.length;send('name',id,await Promise.all(names.map(async name=>({filename:name,longname:name,attrs:attrs(await fs.lstat(local(posix.join(h.path,name))))}))))})
    on('CLOSE',async(id,handle)=>{const h=handles.get(handle.toString());handles.delete(handle.toString());await h?.fd?.close();send('status',id,0)})
    on('MKDIR',async(id,path,a)=>{await fs.mkdir(local(path),{mode:a.mode??0o755});send('status',id,0)})
    on('RMDIR',async(id,path)=>{await fs.rmdir(local(path));send('status',id,0)})
    on('REMOVE',async(id,path)=>{await fs.unlink(local(path));send('status',id,0)})
    on('RENAME',async(id,from,to)=>{try{await fs.lstat(local(to));throw new Error('target exists')}catch(error){if(error.code!=='ENOENT')throw error}await fs.rename(local(from),local(to));send('status',id,0)})
    on('SETSTAT',async(id,path,a)=>{if(a.mode!==undefined)await fs.chmod(local(path),a.mode);send('status',id,0)})
    on('EXTENDED',async(id,name)=>send('status',id,8,'Operation unsupported'))
    stream.on('close',()=>{for(const h of handles.values())void h.fd?.close().catch(()=>{});handles.clear()})
  })
}
