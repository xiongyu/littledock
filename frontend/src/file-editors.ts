import { ref } from 'vue'
import type { RemoteTextFile } from '@webnav/shared'
import { rpc,connectionState } from './backend'
import { watch } from 'vue'
export interface FileEditorDocument { id:string;sessionId:string;file:RemoteTextFile;order:number }
export const fileEditors=ref<FileEditorDocument[]>([])
let order=0
let generation=0
watch(connectionState,()=>{generation++})
export async function openFileEditor(sessionId:string,path:string){
  const existing=fileEditors.value.find(item=>item.sessionId===sessionId&&item.file.path===path)
  if(existing){existing.order=++order;return}
  if(fileEditors.value.length>=4)throw new Error('最多同时打开 4 个文件编辑器。')
  const current=generation
  const file=await rpc<RemoteTextFile>('files.read',{sessionId,path})
  if(current!==generation||connectionState.value!=='ready')return
  if(fileEditors.value.length>=4)throw new Error('最多同时打开 4 个文件编辑器。')
  if(fileEditors.value.some(item=>item.sessionId===sessionId&&item.file.path===path))return
  fileEditors.value.push({id:crypto.randomUUID(),sessionId,file,order:++order})
}
export function closeFileEditor(id:string){fileEditors.value=fileEditors.value.filter(item=>item.id!==id)}
export function raiseFileEditor(id:string){const item=fileEditors.value.find(item=>item.id===id);if(item)item.order=++order}
