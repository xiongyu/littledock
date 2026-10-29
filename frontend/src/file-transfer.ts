import { rpc } from './backend'
import { type UploadEntry,remoteChild } from './upload-entries'
export { droppedEntries,remoteChild,type UploadEntry } from './upload-entries'
function base64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text)}
export async function uploadEntries(sessionId:string,target:string,entries:UploadEntry[],signal:AbortSignal,progress:(done:number,total:number,path:string)=>void){
  const total=entries.reduce((sum,item)=>sum+(item.file?.size??0),0),created=new Set<string>();let done=0
  const check=()=>{if(signal.aborted)throw new Error('上传已取消。')}
  for(const entry of entries){
    check();const parts=entry.relative.split('/');if(parts.some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f]/.test(part)))throw new Error('文件路径不正确。')
    const folders=entry.file?parts.slice(0,-1):parts;let current=target
    for(const name of folders){check();const next=remoteChild(current,name);if(!created.has(next)){await rpc('files.action',{sessionId,path:current,action:'mkdir',name,ensure:true},true);created.add(next)}current=next}
    const file=entry.file;if(!file)continue;const path=remoteChild(target,entry.relative)
    let transfer:{id:string;size:number}
    try{transfer=await rpc('files.begin',{sessionId,path,kind:'upload',size:file.size},true)}
    catch(error){if(!(error instanceof Error)||!error.message.includes('同名'))throw error;if(!confirm('覆盖远端同名文件？\n'+path))continue;check();transfer=await rpc('files.begin',{sessionId,path,kind:'upload',size:file.size,overwrite:true},true)}
    try{for(let offset=0;offset<file.size;offset+=128*1024){check();const bytes=new Uint8Array(await file.slice(offset,offset+128*1024).arrayBuffer());await rpc('files.chunk',{id:transfer.id,offset,data:base64(bytes)});done+=bytes.length;progress(done,total,path)}check();await rpc('files.commit',{id:transfer.id},true)}
    catch(error){await rpc('files.cancel',{id:transfer.id}).catch(()=>{});throw error}
  }
}
interface LocalWriter {write(data:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>}
type SaveWindow=Window&{showSaveFilePicker?:(options:{suggestedName:string})=>Promise<{createWritable:()=>Promise<LocalWriter>}>}
export async function downloadFile(sessionId:string,path:string,signal:AbortSignal,progress:(done:number,total:number,path:string)=>void){
  const picker=(window as SaveWindow).showSaveFilePicker;let writer:LocalWriter|undefined
  if(picker)writer=await (await picker.call(window,{suggestedName:path.split('/').pop()??'download'})).createWritable()
  let transfer:{id:string;size:number}|undefined;const parts:Uint8Array<ArrayBuffer>[]=[];let offset=0
  try{
    transfer=await rpc<{id:string;size:number}>('files.begin',{sessionId,path,kind:'download'},true)
    if(!writer&&transfer.size>64*1024*1024)throw new Error('当前浏览器下载上限为 64 MiB，请使用支持直接保存文件的浏览器。')
    do{if(signal.aborted)throw new Error('下载已取消。');const chunk=await rpc<{data:string;offset:number;done:boolean}>('files.chunk',{id:transfer.id,offset});const bytes=Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0));if(writer)await writer.write(bytes);else parts.push(bytes);offset=chunk.offset;progress(offset,transfer.size,path);if(chunk.done)break}while(true)
    if(writer)await writer.close();else{const url=URL.createObjectURL(new Blob(parts)),a=document.createElement('a');a.href=url;a.download=path.split('/').pop()??'download';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  }catch(error){await writer?.abort().catch(()=>{});if(transfer)await rpc('files.cancel',{id:transfer.id}).catch(()=>{});throw error}
}
