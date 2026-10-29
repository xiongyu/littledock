export type UploadEntry={relative:string;file?:File}
export function remoteChild(base:string,name:string){return base.replace(/\/$/,'')+'/'+name}
export async function droppedEntries(data:DataTransfer):Promise<UploadEntry[]>{
  const result:UploadEntry[]=[]
  async function visit(entry:FileSystemEntry,prefix=''){
    if(result.length>=2000||prefix.split('/').length>32)throw new Error('一次最多上传 2,000 项、32 层目录。')
    const relative=prefix+entry.name
    if(entry.isFile){const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));result.push({relative,file})}
    else if(entry.isDirectory){result.push({relative});const reader=(entry as FileSystemDirectoryEntry).createReader();for(;;){const entries=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!entries.length)break;for(const child of entries)await visit(child,relative+'/')}}
  }
  const entries=[...data.items].filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.()).filter((entry):entry is FileSystemEntry=>!!entry)
  if(entries.length)for(const entry of entries)await visit(entry)
  else for(const file of [...data.files])result.push({relative:file.name,file})
  return result
}
