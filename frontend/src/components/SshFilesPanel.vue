<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.sshFiles')

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
    result.push({id:'open',label:entry.kind==='directory'?i18nT('mfcf8b4bff0df'):entry.kind==='link'?i18nT('m2b1392c3880b'):i18nT('mdf3391746cdf'),shortcut:entry.kind==='file'?'Enter':undefined})
    if(entry.kind==='file')result.push({id:'vscode',label:i18nT('m00a0fa1e1840')},{id:'notepad',label:i18nT('m44f2037a5874')},{id:'download',label:i18nT('m4673a2306165'),separator:true})
    if(entry.kind==='directory')result.push({id:'remoteEditor',label:i18nT('mf1ee79c04c30')})
    if(entry.kind==='directory')result.push({id:'upload',label:i18nT('m6a14e9761369'),separator:true})
    result.push({id:'rename',label:i18nT('m0d0cbac2eee5'),shortcut:'F2',separator:true},{id:'copyPath',label:i18nT('maffad28dddd5')},{id:'copyName',label:i18nT('ma77a6cca3ce2')})
    if(entry.kind!=='link')result.push({id:'compress',label:i18nT('m26a45747ea72'),separator:true})
    if(entry.kind==='file'&&/\.zip$/i.test(entry.name))result.push({id:'extract',label:i18nT('m7de7bf85254d')})
    result.push({id:'properties',label:i18nT('m86de52d17820'),separator:true},{id:'remove',label:i18nT('m2f9daa828907'),shortcut:'Del',danger:true})
  }else result.push({id:'remoteEditor',label:i18nT('mf1ee79c04c30')},{id:'upload',label:i18nT('mbb5caa9c5976'),separator:true},{id:'uploadFolder',label:i18nT('mcf330aa2e05e')},{id:'create',label:i18nT('m6ddd1eaccab1'),separator:true},{id:'mkdir',label:i18nT('m84244abc71de')},{id:'copyPath',label:i18nT('mc82e44dae349'),separator:true},{id:'refresh',label:i18nT('maee887434131'),shortcut:'F5'})
  return result.map(item=>({...item,disabled:disabled.value||!!transfer.value||busy.value}))
})
async function load(target=path.value,offset=0,refresh=false,manual=false){
  if(busy.value||disabled.value||transfer.value)return
  if(manual)following.value=false
  const version=generation,id=props.sessionId;busy.value=true;error.value=''
  try{const result=await rpc<SshFilePage>('ssh.files',{sessionId:id,path:target,offset,refresh});if(version===generation){page.value=result;path.value=result.path;selected.value=''}}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:i18nT('m5215599023ee')}
  finally{if(version===generation)busy.value=false}
}
function itemPath(entry:SshFileEntry){return remoteChild(page.value?.path??path.value,entry.name)}
async function open(entry:SshFileEntry){if(entry.kind==='directory'||entry.kind==='link')await load(itemPath(entry),0,false,true);else await operate(()=>openFileEditor(props.sessionId,itemPath(entry)))}
function context(event:MouseEvent,entry?:SshFileEntry){event.preventDefault();event.stopPropagation();selected.value=entry?.name??'';menu.value={x:event.clientX,y:event.clientY,entry}}
async function operate(run:()=>Promise<unknown>){const version=generation;error.value='';try{await run()}catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:i18nT('mb3b75bd055c0')}}
function copy(text:string){void operate(()=>navigator.clipboard.writeText(text))}
async function act(action:string){
  const version=generation,id=props.sessionId,entry=menu.value?.entry,target=entry?itemPath(entry):page.value?.path??path.value;menu.value=undefined
  if(action==='open'&&entry){await open(entry);return}
  if(action==='remoteEditor'){openRemoteEditor(id,target,props.name);return}
  if(action==='copyPath'||action==='copyName'){copy(action==='copyName'?entry!.name:target);return}
  if(action==='upload'||action==='uploadFolder'){uploadTarget=entry?.kind==='directory'?target:page.value?.path??path.value;(action==='uploadFolder'?folderInput:fileInput).value?.click();return}
  if(action==='refresh'){await load(page.value?.path,0,true);return}
  if(['create','mkdir','rename','remove'].includes(action)){actionDialog.value={action,path:target,title:({create:i18nT('m6ddd1eaccab1'),mkdir:i18nT('m84244abc71de'),rename:i18nT('m0d0cbac2eee5'),remove:i18nT('m88f47860e77d')} as Record<string,string>)[action]!,value:action==='rename'?entry!.name:'',detail:action==='remove'?i18nT('m000222df1847'):undefined};return}
  if(action==='properties'){await operate(async()=>{const p=await rpc<{path:string;size:number;modifiedAt:number;permissions:string;owner:string;kind:string}>('files.action',{sessionId:id,path:target,action},true);if(version!==generation)return;actionDialog.value={action,title:i18nT('m86de52d17820'),path:target,value:p.permissions,detail:i18nT('mbf08c476c2da', { p0: (p.kind==='directory'?i18nT('m7c7802d8adae'):i18nT('m39932f24fe11')), p1: (formatBytes(p.size)), p2: (new Date(p.modifiedAt).toLocaleString(displayLocale())), p3: (p.owner) })}});return}
  if(action==='download'){await runTransfer(i18nT('m4673a2306165'),target,signal=>downloadFile(props.sessionId,target,signal,report));return}
  await operate(async()=>{await rpc('files.startJob',{sessionId:props.sessionId,path:target,kind:['vscode','notepad'].includes(action)?'external':action,editor:action},true);await poll()})
}
async function confirmAction(){
  const form=actionDialog.value;if(!form||busy.value)return;busy.value=true;const id=props.sessionId,version=generation
  try{await rpc('files.action',{sessionId:id,path:form.path,action:form.action==='properties'?'chmod':form.action,name:form.value,mode:form.value,confirm:form.action==='remove'},true);if(version!==generation)return;actionDialog.value=undefined;busy.value=false;await load(page.value?.path,0,true);if(form.action==='create')await openFileEditor(id,remoteChild(form.path,form.value))}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:i18nT('mb3b75bd055c0')}finally{if(version===generation)busy.value=false}
}
function report(done:number,total:number,path:string){if(transfer.value)Object.assign(transfer.value,{done,total,path})}
async function runTransfer(verb:string,target:string,run:(signal:AbortSignal)=>Promise<void>){
  if(transfer.value||disabled.value)return;const version=generation;controller=new AbortController();transfer.value={done:0,total:0,path:target,verb};error.value=''
  try{await run(controller.signal);if(version===generation)notice.value=verb+i18nT('mc0b3fbff51cc')}catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:verb+i18nT('m28384d7afd2e')}finally{if(version===generation){transfer.value=undefined;controller=undefined;await load(page.value?.path,0,true)}}
}
async function upload(entries:UploadEntry[],target:string){const id=props.sessionId;await runTransfer(i18nT('m9e07e3c0532d'),target,signal=>uploadEntries(id,target,entries,signal,report))}
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
    if(following.value&&!busy.value&&!transfer.value){const cwd=await rpc<{path:string;revision:number}>('files.cwd',{sessionId:id});if(version!==generation||!following.value)return;if(cwd.path&&cwd.path!==lastDirectory){lastDirectory=cwd.path;if(cwd.path!==page.value?.path)await load(cwd.path)}else if(explicit&&!cwd.path)notice.value=i18nT('m89cb0af34e10')}
  }catch(cause){if(explicit&&version===generation)error.value=cause instanceof Error?cause.message:i18nT('m1fd0fc468e5a')}finally{pollBusy=false}
}
async function jobAction(job:RemoteFileJob,action:string){await operate(async()=>{if(action==='retry'&&job.state==='conflict'&&!confirm(i18nT('m99c93d079305')+job.path))return;await rpc('files.jobAction',{id:job.id,action,overwrite:job.state==='conflict'},true);await poll()})}
function keyboard(event:KeyboardEvent){const entry=page.value?.entries.find(item=>item.name===selected.value);if(event.key==='F5'){event.preventDefault();void load(page.value?.path,0,true)}else if(entry&&['F2','Delete','Enter','ContextMenu'].includes(event.key)){event.preventDefault();if(event.key==='Enter')void open(entry);else if(event.key==='ContextMenu'){const box=(event.target as HTMLElement).getBoundingClientRect();menu.value={x:box.left+20,y:box.top+20,entry}}else{menu.value={x:0,y:0,entry};void act(event.key==='F2'?'rename':'remove')}}}
watch(()=>[props.sessionId,props.ready,connectionState.value],()=>{generation++;controller?.abort();controller=undefined;transfer.value=undefined;page.value=undefined;path.value='.';busy.value=false;pollBusy=false;error.value='';notice.value='';menu.value=undefined;actionDialog.value=undefined;jobs.value=[];lastDirectory='';following.value=true;void load().then(()=>poll())},{immediate:true})
watch(()=>props.locateRequest,()=>{void locate()})
const timer=setInterval(()=>{void poll()},2000)
onBeforeUnmount(()=>{generation++;controller?.abort();clearInterval(timer)})
</script>
<template>
  <section class="ssh-files-panel" :class="{'is-file-drop':dragDepth>0}" :aria-label="i18nT('m9ed4806c0eed')" @contextmenu.prevent="context($event)" @dragenter="hasFiles($event)&&(dragDepth++,dragOver($event))" @dragover="dragOver" @dragleave="dragDepth=Math.max(0,dragDepth-1)" @drop="drop">
    <header class="inspector-header"><PhFolderOpen :size="16"/><strong>{{ i18nT('m39932f24fe11') }}</strong><div class="file-locate-buttons" :aria-label="i18nT('meae547b7ac26')"><PhCrosshair :size="14"/><button v-for="target in targets" :key="target.sessionId" :class="{active:target.sessionId===sessionId&&following}" :aria-label="i18nT('mee26a6a95049')+target.number+i18nT('m46b61d7427e9')" :title="i18nT('m767da265e610')+target.number+' · '+target.name" :disabled="!target.ready||!!transfer" @click="emit('locate',target.sessionId)">{{ target.number }}</button></div><button class="icon-button small" :title="following?i18nT('mb58656626305'):i18nT('m2532788db177')" :aria-label="following?i18nT('md7d48ab0cf46'):i18nT('me584abfe29d9')" @click="following?following=false:locate()"><PhLink v-if="following" :size="14"/><PhLinkBreak v-else :size="14"/></button><span class="inspector-target" :title="name">{{ name }}</span><button class="icon-button small" :aria-label="i18nT('mea8bd1b46629')" :title="i18nT('md8a6cb39e705')" :disabled="disabled||!page" @click="openRemoteEditor(sessionId,page?.path??path,name)"><PhCode :size="17"/></button><button class="icon-button small" :title="i18nT('mbb5caa9c5976')" :aria-label="i18nT('mbb5caa9c5976')" :disabled="disabled||!!transfer" @click="uploadTarget=page?.path??path;fileInput?.click()"><PhUploadSimple :size="16"/></button><button class="icon-button small" :aria-label="i18nT('ma79c9512ab99')" :title="i18nT('ma79c9512ab99')" @click="emit('close')"><PhX :size="16"/></button></header>
    <input ref="fileInput" type="file" multiple hidden :aria-label="i18nT('m61327ff6ad41')" @change="chosen"/><input ref="folderInput" type="file" webkitdirectory multiple hidden :aria-label="i18nT('m27c192314dc5')" @change="chosen"/>
    <form class="file-pathbar" @submit.prevent="load(path,0,false,true)"><button type="button" class="icon-button small" :aria-label="i18nT('m963f3b5d1c4f')" :title="i18nT('m963f3b5d1c4f')" :disabled="busy||disabled||!!transfer" @click="load((page?.path??path).replace(/\/$/,'')+'/..',0,false,true)"><PhArrowUp :size="16"/></button><input v-model="path" :aria-label="i18nT('m227061b3d512')" spellcheck="false" :disabled="disabled||!!transfer"/><button class="icon-button small" type="button" :aria-label="i18nT('me005e6e25e18')" :title="i18nT('maee887434131')" :disabled="busy||disabled||!!transfer" @click="load(page?.path,0,true)"><PhArrowClockwise :size="16"/></button></form>
    <p v-if="error" class="file-operation-error" role="alert">{{ error }}<button :aria-label="i18nT('m76d59174e47d')" @click="error=''">×</button></p><p v-if="notice" class="file-notice" role="status">{{ notice }}<button :aria-label="i18nT('m453274a6f188')" @click="notice=''">×</button></p>
    <div v-if="transfer" class="file-transfer-progress" role="status"><strong>{{ transfer.verb }} {{ transfer.total?Math.round(transfer.done/transfer.total*100):0 }}%</strong><code :title="transfer.path">{{ transfer.path }}</code><span>{{ formatBytes(transfer.done) }} / {{ formatBytes(transfer.total) }}</span><button class="icon-button small" :aria-label="i18nT('m9b1109512030')" @click="controller?.abort()"><PhX :size="14"/></button><progress :value="transfer.done" :max="transfer.total||1"/></div>
    <div v-if="jobs.length" class="file-job-list"><div v-for="job in jobs" :key="job.id" class="file-job" :class="job.state"><span :title="job.path">{{ job.path.split('/').pop() }}</span><span :title="job.localPath??job.message">{{ job.message }}</span><button v-if="job.localPath" @click="copy(job.localPath)">{{ i18nT('md6da06a1c1ff') }}</button><button v-if="job.kind==='external'&&['conflict','error'].includes(job.state)" @click="jobAction(job,'retry')">{{ job.state==='conflict'?i18nT('mb4153109ccd6'):i18nT('mb8784c8dd563') }}</button><button v-if="['working','watching','syncing','conflict','error'].includes(job.state)" @click="jobAction(job,'stop')">{{ i18nT('mca4d973c0b00') }}</button></div></div>
    <p v-if="!ready" class="inspector-state">{{ i18nT('m07f1b2611c59') }}</p><p v-else-if="busy&&!page" class="inspector-state">{{ i18nT('m36517d179e0f') }}</p>
    <div v-else class="file-table-scroll" tabindex="0" :aria-label="i18nT('md846847cc6c4')" @keydown="keyboard"><table class="remote-files-table"><thead><tr><th>{{ i18nT('md44e9b3d3b31') }}</th><th>{{ i18nT('m50db7447b966') }}</th><th>{{ i18nT('m257bbcc44c83') }}</th><th>{{ i18nT('m978cbca6265d') }}</th><th>{{ i18nT('mdd6f6a95c448') }}</th></tr></thead><tbody><tr v-for="entry in page?.entries" :key="entry.name" :class="{selected:selected===entry.name}" :data-folder-path="entry.kind==='directory'?itemPath(entry):undefined" @click="selected=entry.name" @contextmenu="context($event,entry)"><td><button :disabled="busy||disabled||!!transfer" :title="entry.name" @click="open(entry)"><component :is="entry.kind==='directory'?PhFolder:PhFile" :size="16"/><span>{{ entry.name }}</span></button></td><td>{{ entry.kind==='directory'?i18nT('m7c7802d8adae'):formatBytes(entry.size) }}</td><td>{{ new Date(entry.modifiedAt).toLocaleString(displayLocale(),{hour12:false}) }}</td><td><code>{{ entry.permissions }}</code></td><td>{{ entry.owner }}</td></tr></tbody></table><p v-if="page&&!page.entries.length" class="inspector-state">{{ i18nT('me3141cb009c8') }}</p></div>
    <footer v-if="page" class="file-pagination"><span>{{ i18nT('m6689d22e068f', { p0: (page.total), p1: (page.truncated?i18nT('mefa0ba80f932'):'') }) }}</span><span>{{ Math.floor(page.offset/100)+1 }} / {{ Math.max(1,Math.ceil(page.total/100)) }}</span><button class="icon-button small" :aria-label="i18nT('m9a16e696c8dc')" :disabled="busy||page.offset===0" @click="load(page.path,page.offset-100)"><PhCaretLeft :size="15"/></button><button class="icon-button small" :aria-label="i18nT('ma6406b12e724')" :disabled="busy||page.offset+100>=page.total" @click="load(page.path,page.offset+100)"><PhCaretRight :size="15"/></button></footer>
    <div v-if="dragDepth>0" class="file-drop-overlay"><PhUploadSimple :size="32"/><strong>{{ disabled?i18nT('m7302f0bf7073'):transfer?i18nT('m15c12db05436'):i18nT('m2c70ae14f671') }}</strong><span>{{ i18nT('m26fa005acb80') }}</span><code>{{ dragTarget||page?.path||path }}</code><small>{{ i18nT('m0c2db0ff876d') }}</small></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="actions" :label="i18nT('ma6a7e454cf11')" :extension="menuExtension" :execute="act" @close="menu=undefined"/>
    <Teleport to="body"><div v-if="actionDialog" class="file-action-backdrop"><form class="file-action-dialog" role="dialog" :aria-label="actionDialog.title" @submit.prevent="confirmAction"><header><strong>{{ actionDialog.title }}</strong><button type="button" class="icon-button" :aria-label="i18nT('m390d72a202bc')" :disabled="busy" @click="actionDialog=undefined"><PhX :size="18"/></button></header><code>{{ actionDialog.path }}</code><p v-if="actionDialog.detail">{{ actionDialog.detail }}</p><label v-if="actionDialog.action!=='remove'">{{ actionDialog.action==='properties'?i18nT('me3136f4f8a30'):i18nT('md44e9b3d3b31') }}<input v-model="actionDialog.value" :aria-label="actionDialog.action==='properties'?i18nT('m978cbca6265d'):i18nT('md44e9b3d3b31')" autofocus :disabled="busy"/></label><p v-if="error" role="alert">{{ error }}</p><footer><button type="button" class="button" :disabled="busy" @click="actionDialog=undefined">{{ i18nT('m2cd0f3be8738') }}</button><button class="button primary" :disabled="busy">{{ actionDialog.action==='remove'?i18nT('ma3ea3c17b401'):actionDialog.action==='properties'?i18nT('m6fb73fce60fc'):i18nT('mfac2a67ad878') }}</button></footer></form></div></Teleport>
  </section>
</template>
