<script setup lang="ts">
import { computed,onBeforeUnmount,ref,watch } from 'vue'
import { PhFolderOpen,PhFolder,PhFile,PhArrowUp,PhArrowClockwise,PhX,PhCaretLeft,PhCaretRight,PhUploadSimple,PhCrosshair,PhLink,PhLinkBreak,PhCode } from '@phosphor-icons/vue'
import type { SshFileEntry,SshFilePage,RemoteFileJob } from '@webnav/shared'
import { connectionState,rpc } from '../backend'
import { formatBytes } from '../workspace-preferences'
import ContextMenu,{type MenuItem} from './ContextMenu.vue'
import { menuBinding } from '../plugin-menus'
import { openFileEditor } from '../file-editors'
import { openRemoteEditor } from '../remote-editor'
import { droppedEntries,uploadEntries,downloadFile,remoteChild,type UploadEntry } from '../file-transfer'
const props=defineProps<{sessionId:string;ready:boolean;name:string;targets:{sessionId:string;number:number;name:string;ready:boolean}[];locateRequest:number}>()
const emit=defineEmits<{close:[];locate:[id:string]}>()
const page=ref<SshFilePage>(),path=ref('.'),busy=ref(false),error=ref(''),selected=ref(''),following=ref(true)
const menu=ref<{x:number;y:number;entry?:SshFileEntry}>(),fileInput=ref<HTMLInputElement>(),folderInput=ref<HTMLInputElement>()
const dragTarget=ref(''),dragDepth=ref(0),jobs=ref<RemoteFileJob[]>([]),notice=ref('')
const transfer=ref<{done:number;total:number;path:string;verb:string}>(),actionDialog=ref<{action:string;title:string;path:string;value:string;detail?:string}>()
let generation=0,lastDirectory='',pollBusy=false,controller:AbortController|undefined,uploadTarget=''
const disabled=computed(()=>!props.ready||connectionState.value!=='ready')
const menuExtension = menuBinding('builtin.sshFiles', 'entry', () => ({ sessionId: props.sessionId, path: menu.value?.entry ? remoteChild(page.value?.path ?? '.', menu.value.entry.name) : page.value?.path ?? '.', name: menu.value?.entry?.name ?? '', kind: menu.value?.entry?.kind ?? 'directory' }), () => !!menu.value && !disabled.value && !busy.value && !transfer.value)
const actions=computed<MenuItem[]>(()=>{
  const entry=menu.value?.entry,result:MenuItem[]=[]
  if(entry){
    result.push({id:'open',label:entry.kind==='directory'?'打开文件夹':entry.kind==='link'?'进入链接目标':'内置编辑器',shortcut:entry.kind==='file'?'Enter':undefined})
    if(entry.kind==='file')result.push({id:'vscode',label:'本地 VS Code（同步保存）'},{id:'notepad',label:'用记事本编辑'},{id:'download',label:'下载',separator:true})
    if(entry.kind==='directory')result.push({id:'remoteEditor',label:'在远程 VS Code 中打开'})
    if(entry.kind==='directory')result.push({id:'upload',label:'上传到此文件夹',separator:true})
    result.push({id:'rename',label:'重命名',shortcut:'F2',separator:true},{id:'copyPath',label:'复制完整路径'},{id:'copyName',label:'复制名称'})
    if(entry.kind!=='link')result.push({id:'compress',label:'压缩为 ZIP',separator:true})
    if(entry.kind==='file'&&/\.zip$/i.test(entry.name))result.push({id:'extract',label:'解压到同名文件夹'})
    result.push({id:'properties',label:'属性',separator:true},{id:'remove',label:'删除',shortcut:'Del',danger:true})
  }else result.push({id:'remoteEditor',label:'在远程 VS Code 中打开'},{id:'upload',label:'上传文件',separator:true},{id:'uploadFolder',label:'上传文件夹'},{id:'create',label:'新建文件',separator:true},{id:'mkdir',label:'新建文件夹'},{id:'copyPath',label:'复制当前路径',separator:true},{id:'refresh',label:'刷新',shortcut:'F5'})
  return result.map(item=>({...item,disabled:disabled.value||!!transfer.value||busy.value}))
})
async function load(target=path.value,offset=0,refresh=false,manual=false){
  if(busy.value||disabled.value||transfer.value)return
  if(manual)following.value=false
  const version=generation,id=props.sessionId;busy.value=true;error.value=''
  try{const result=await rpc<SshFilePage>('ssh.files',{sessionId:id,path:target,offset,refresh});if(version===generation){page.value=result;path.value=result.path;selected.value=''}}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'读取失败。'}
  finally{if(version===generation)busy.value=false}
}
function itemPath(entry:SshFileEntry){return remoteChild(page.value?.path??path.value,entry.name)}
async function open(entry:SshFileEntry){if(entry.kind==='directory'||entry.kind==='link')await load(itemPath(entry),0,false,true);else await operate(()=>openFileEditor(props.sessionId,itemPath(entry)))}
function context(event:MouseEvent,entry?:SshFileEntry){event.preventDefault();event.stopPropagation();selected.value=entry?.name??'';menu.value={x:event.clientX,y:event.clientY,entry}}
async function operate(run:()=>Promise<unknown>){const version=generation;error.value='';try{await run()}catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'操作失败。'}}
function copy(text:string){void operate(()=>navigator.clipboard.writeText(text))}
async function act(action:string){
  const version=generation,id=props.sessionId,entry=menu.value?.entry,target=entry?itemPath(entry):page.value?.path??path.value;menu.value=undefined
  if(action==='open'&&entry){await open(entry);return}
  if(action==='remoteEditor'){openRemoteEditor(id,target,props.name);return}
  if(action==='copyPath'||action==='copyName'){copy(action==='copyName'?entry!.name:target);return}
  if(action==='upload'||action==='uploadFolder'){uploadTarget=entry?.kind==='directory'?target:page.value?.path??path.value;(action==='uploadFolder'?folderInput:fileInput).value?.click();return}
  if(action==='refresh'){await load(page.value?.path,0,true);return}
  if(['create','mkdir','rename','remove'].includes(action)){actionDialog.value={action,path:target,title:({create:'新建文件',mkdir:'新建文件夹',rename:'重命名',remove:'删除文件'} as Record<string,string>)[action]!,value:action==='rename'?entry!.name:'',detail:action==='remove'?'删除后无法通过 WebNav 撤销。文件夹将连同其内容一起删除。':undefined};return}
  if(action==='properties'){await operate(async()=>{const p=await rpc<{path:string;size:number;modifiedAt:number;permissions:string;owner:string;kind:string}>('files.action',{sessionId:id,path:target,action},true);if(version!==generation)return;actionDialog.value={action,title:'属性',path:target,value:p.permissions,detail:`${p.kind==='directory'?'文件夹':'文件'} · ${formatBytes(p.size)}\n修改时间：${new Date(p.modifiedAt).toLocaleString()}\n用户 / 组：${p.owner}`}});return}
  if(action==='download'){await runTransfer('下载',target,signal=>downloadFile(props.sessionId,target,signal,report));return}
  await operate(async()=>{await rpc('files.startJob',{sessionId:props.sessionId,path:target,kind:['vscode','notepad'].includes(action)?'external':action,editor:action},true);await poll()})
}
async function confirmAction(){
  const form=actionDialog.value;if(!form||busy.value)return;busy.value=true;const id=props.sessionId,version=generation
  try{await rpc('files.action',{sessionId:id,path:form.path,action:form.action==='properties'?'chmod':form.action,name:form.value,mode:form.value,confirm:form.action==='remove'},true);if(version!==generation)return;actionDialog.value=undefined;busy.value=false;await load(page.value?.path,0,true);if(form.action==='create')await openFileEditor(id,remoteChild(form.path,form.value))}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'操作失败。'}finally{if(version===generation)busy.value=false}
}
function report(done:number,total:number,path:string){if(transfer.value)Object.assign(transfer.value,{done,total,path})}
async function runTransfer(verb:string,target:string,run:(signal:AbortSignal)=>Promise<void>){
  if(transfer.value||disabled.value)return;const version=generation;controller=new AbortController();transfer.value={done:0,total:0,path:target,verb};error.value=''
  try{await run(controller.signal);if(version===generation)notice.value=verb+'完成'}catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:verb+'失败'}finally{if(version===generation){transfer.value=undefined;controller=undefined;await load(page.value?.path,0,true)}}
}
async function upload(entries:UploadEntry[],target:string){const id=props.sessionId;await runTransfer('上传',target,signal=>uploadEntries(id,target,entries,signal,report))}
async function chosen(event:Event){const input=event.target as HTMLInputElement,entries=[...(input.files??[])].map(file=>({relative:file.webkitRelativePath||file.name,file}));input.value='';await upload(entries,uploadTarget||page.value?.path||path.value)}
function hasFiles(event:DragEvent){return [...(event.dataTransfer?.types??[])].includes('Files')}
function dragOver(event:DragEvent){if(!hasFiles(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=disabled.value||transfer.value?'none':'copy';const folder=(event.target as Element).closest<HTMLElement>('[data-folder-path]');dragTarget.value=folder?.dataset.folderPath??page.value?.path??path.value}
async function drop(event:DragEvent){event.preventDefault();const version=generation,target=dragTarget.value||page.value?.path;dragDepth.value=0;dragTarget.value='';if(!event.dataTransfer||!target||disabled.value||transfer.value)return;await operate(async()=>{const entries=await droppedEntries(event.dataTransfer!);if(version===generation)await upload(entries,target)})}
async function locate(){following.value=true;lastDirectory='';await poll(true)}
async function poll(explicit=false){
  if(disabled.value||pollBusy)return;pollBusy=true;const version=generation,id=props.sessionId
  try{
    const status=await rpc<RemoteFileJob[]>('files.status',{sessionId:id});if(version!==generation)return
    const completed=status.some(job=>job.state==='done'&&!jobs.value.some(old=>old.id===job.id&&old.state==='done'));jobs.value=status
    if(completed&&!busy.value&&!transfer.value)await load(page.value?.path,0,true)
    if(following.value&&!busy.value&&!transfer.value){const cwd=await rpc<{path:string;revision:number}>('files.cwd',{sessionId:id});if(version!==generation||!following.value)return;if(cwd.path&&cwd.path!==lastDirectory){lastDirectory=cwd.path;if(cwd.path!==page.value?.path)await load(cwd.path)}else if(explicit&&!cwd.path)notice.value='此终端暂未提供当前目录，请手动选择。'}
  }catch(cause){if(explicit&&version===generation)error.value=cause instanceof Error?cause.message:'定位失败。'}finally{pollBusy=false}
}
async function jobAction(job:RemoteFileJob,action:string){await operate(async()=>{if(action==='retry'&&job.state==='conflict'&&!confirm('远端文件已变化，确定用本地副本覆盖？\n'+job.path))return;await rpc('files.jobAction',{id:job.id,action,overwrite:job.state==='conflict'},true);await poll()})}
function keyboard(event:KeyboardEvent){const entry=page.value?.entries.find(item=>item.name===selected.value);if(event.key==='F5'){event.preventDefault();void load(page.value?.path,0,true)}else if(entry&&['F2','Delete','Enter','ContextMenu'].includes(event.key)){event.preventDefault();if(event.key==='Enter')void open(entry);else if(event.key==='ContextMenu'){const box=(event.target as HTMLElement).getBoundingClientRect();menu.value={x:box.left+20,y:box.top+20,entry}}else{menu.value={x:0,y:0,entry};void act(event.key==='F2'?'rename':'remove')}}}
watch(()=>[props.sessionId,props.ready,connectionState.value],()=>{generation++;controller?.abort();controller=undefined;transfer.value=undefined;page.value=undefined;path.value='.';busy.value=false;pollBusy=false;error.value='';notice.value='';menu.value=undefined;actionDialog.value=undefined;jobs.value=[];lastDirectory='';following.value=true;void load().then(()=>poll())},{immediate:true})
watch(()=>props.locateRequest,()=>{void locate()})
const timer=setInterval(()=>{void poll()},2000)
onBeforeUnmount(()=>{generation++;controller?.abort();clearInterval(timer)})
</script>
<template>
  <section class="ssh-files-panel" :class="{'is-file-drop':dragDepth>0}" aria-label="远程文件" @contextmenu.prevent="context($event)" @dragenter="hasFiles($event)&&(dragDepth++,dragOver($event))" @dragover="dragOver" @dragleave="dragDepth=Math.max(0,dragDepth-1)" @drop="drop">
    <header class="inspector-header"><PhFolderOpen :size="16"/><strong>文件</strong><div class="file-locate-buttons" aria-label="定位到终端目录"><PhCrosshair :size="14"/><button v-for="target in targets" :key="target.sessionId" :class="{active:target.sessionId===sessionId&&following}" :aria-label="'定位到终端 '+target.number+' 的目录'" :title="'定位并跟随 '+target.number+' · '+target.name" :disabled="!target.ready||!!transfer" @click="emit('locate',target.sessionId)">{{ target.number }}</button></div><button class="icon-button small" :title="following?'正在跟随终端目录，点击暂停':'跟随已暂停，点击重新定位'" :aria-label="following?'暂停目录跟随':'恢复目录跟随'" @click="following?following=false:locate()"><PhLink v-if="following" :size="14"/><PhLinkBreak v-else :size="14"/></button><span class="inspector-target" :title="name">{{ name }}</span><button class="icon-button small" aria-label="用远程 VS Code 打开当前目录" title="远程 VS Code" :disabled="disabled||!page" @click="openRemoteEditor(sessionId,page?.path??path,name)"><PhCode :size="17"/></button><button class="icon-button small" title="上传文件" aria-label="上传文件" :disabled="disabled||!!transfer" @click="uploadTarget=page?.path??path;fileInput?.click()"><PhUploadSimple :size="16"/></button><button class="icon-button small" aria-label="关闭文件栏" title="关闭文件栏" @click="emit('close')"><PhX :size="16"/></button></header>
    <input ref="fileInput" type="file" multiple hidden aria-label="选择上传文件" @change="chosen"/><input ref="folderInput" type="file" webkitdirectory multiple hidden aria-label="选择上传文件夹" @change="chosen"/>
    <form class="file-pathbar" @submit.prevent="load(path,0,false,true)"><button type="button" class="icon-button small" aria-label="上级目录" title="上级目录" :disabled="busy||disabled||!!transfer" @click="load((page?.path??path).replace(/\/$/,'')+'/..',0,false,true)"><PhArrowUp :size="16"/></button><input v-model="path" aria-label="远程目录路径" spellcheck="false" :disabled="disabled||!!transfer"/><button class="icon-button small" type="button" aria-label="刷新文件列表" title="刷新" :disabled="busy||disabled||!!transfer" @click="load(page?.path,0,true)"><PhArrowClockwise :size="16"/></button></form>
    <p v-if="error" class="file-operation-error" role="alert">{{ error }}<button aria-label="关闭文件错误" @click="error=''">×</button></p><p v-if="notice" class="file-notice" role="status">{{ notice }}<button aria-label="关闭文件提示" @click="notice=''">×</button></p>
    <div v-if="transfer" class="file-transfer-progress" role="status"><strong>{{ transfer.verb }} {{ transfer.total?Math.round(transfer.done/transfer.total*100):0 }}%</strong><code :title="transfer.path">{{ transfer.path }}</code><span>{{ formatBytes(transfer.done) }} / {{ formatBytes(transfer.total) }}</span><button class="icon-button small" aria-label="取消文件传输" @click="controller?.abort()"><PhX :size="14"/></button><progress :value="transfer.done" :max="transfer.total||1"/></div>
    <div v-if="jobs.length" class="file-job-list"><div v-for="job in jobs" :key="job.id" class="file-job" :class="job.state"><span :title="job.path">{{ job.path.split('/').pop() }}</span><span :title="job.localPath??job.message">{{ job.message }}</span><button v-if="job.localPath" @click="copy(job.localPath)">复制本地路径</button><button v-if="job.kind==='external'&&['conflict','error'].includes(job.state)" @click="jobAction(job,'retry')">{{ job.state==='conflict'?'覆盖回传':'重试' }}</button><button v-if="['working','watching','syncing','conflict','error'].includes(job.state)" @click="jobAction(job,'stop')">停止</button></div></div>
    <p v-if="!ready" class="inspector-state">等待 SSH 连接就绪</p><p v-else-if="busy&&!page" class="inspector-state">正在读取目录…</p>
    <div v-else class="file-table-scroll" tabindex="0" aria-label="文件列表" @keydown="keyboard"><table class="remote-files-table"><thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>权限</th><th>用户 / 组</th></tr></thead><tbody><tr v-for="entry in page?.entries" :key="entry.name" :class="{selected:selected===entry.name}" :data-folder-path="entry.kind==='directory'?itemPath(entry):undefined" @click="selected=entry.name" @contextmenu="context($event,entry)"><td><button :disabled="busy||disabled||!!transfer" :title="entry.name" @click="open(entry)"><component :is="entry.kind==='directory'?PhFolder:PhFile" :size="16"/><span>{{ entry.name }}</span></button></td><td>{{ entry.kind==='directory'?'文件夹':formatBytes(entry.size) }}</td><td>{{ new Date(entry.modifiedAt).toLocaleString('zh-CN',{hour12:false}) }}</td><td><code>{{ entry.permissions }}</code></td><td>{{ entry.owner }}</td></tr></tbody></table><p v-if="page&&!page.entries.length" class="inspector-state">此目录为空 · 拖入文件即可上传</p></div>
    <footer v-if="page" class="file-pagination"><span>{{ page.total }} 项{{ page.truncated?' · 仅列出前 2,000 项':'' }}</span><span>{{ Math.floor(page.offset/100)+1 }} / {{ Math.max(1,Math.ceil(page.total/100)) }}</span><button class="icon-button small" aria-label="上一页文件" :disabled="busy||page.offset===0" @click="load(page.path,page.offset-100)"><PhCaretLeft :size="15"/></button><button class="icon-button small" aria-label="下一页文件" :disabled="busy||page.offset+100>=page.total" @click="load(page.path,page.offset+100)"><PhCaretRight :size="15"/></button></footer>
    <div v-if="dragDepth>0" class="file-drop-overlay"><PhUploadSimple :size="32"/><strong>{{ disabled?'SSH 未就绪':transfer?'请等待当前传输完成':'松开即可上传' }}</strong><span>目标目录</span><code>{{ dragTarget||page?.path||path }}</code><small>支持文件与整个文件夹</small></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="actions" label="文件操作" :extension="menuExtension" :execute="act" @close="menu=undefined"/>
    <Teleport to="body"><div v-if="actionDialog" class="file-action-backdrop"><form class="file-action-dialog" role="dialog" :aria-label="actionDialog.title" @submit.prevent="confirmAction"><header><strong>{{ actionDialog.title }}</strong><button type="button" class="icon-button" aria-label="关闭文件操作" :disabled="busy" @click="actionDialog=undefined"><PhX :size="18"/></button></header><code>{{ actionDialog.path }}</code><p v-if="actionDialog.detail">{{ actionDialog.detail }}</p><label v-if="actionDialog.action!=='remove'">{{ actionDialog.action==='properties'?'权限（八进制）':'名称' }}<input v-model="actionDialog.value" :aria-label="actionDialog.action==='properties'?'权限':'名称'" autofocus :disabled="busy"/></label><p v-if="error" role="alert">{{ error }}</p><footer><button type="button" class="button" :disabled="busy" @click="actionDialog=undefined">取消</button><button class="button primary" :disabled="busy">{{ actionDialog.action==='remove'?'确认删除':actionDialog.action==='properties'?'保存权限':'确定' }}</button></footer></form></div></Teleport>
  </section>
</template>
