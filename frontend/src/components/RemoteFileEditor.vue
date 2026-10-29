<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.sshFiles')

import { onMounted,onBeforeUnmount,ref,watch } from 'vue'
import { EditorView,keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { basicSetup } from 'codemirror'
import { PhFloppyDisk,PhX,PhArrowsOut,PhDownloadSimple } from '@phosphor-icons/vue'
import { type FileEditorDocument,closeFileEditor,raiseFileEditor } from '../file-editors'
import { rpc,connectionState } from '../backend'
import { dragDimension } from '../workspace-preferences'
const props=defineProps<{document:FileEditorDocument}>()
const host=ref<HTMLElement>(),element=ref<HTMLElement>(),dirty=ref(false),saving=ref(false),error=ref(''),maximized=ref(false)
const encoding=ref(props.document.file.encoding),lineEnding=ref(props.document.file.lineEnding)
const position=ref({left:Math.max(12,(innerWidth-800)/2),top:Math.max(64,(innerHeight-520)/2)})
let editor:EditorView|undefined,baseline=props.document.file.text.replace(/\r\n/g,'\n'),version=props.document.file.version,disposed=false
let savedEncoding=encoding.value,savedLineEnding=lineEnding.value
function updateDirty(){dirty.value=(editor?.state.doc.toString()??baseline)!==baseline||encoding.value!==savedEncoding||lineEnding.value!==savedLineEnding}
async function language(path:string){const ext=path.split('.').pop()?.toLowerCase();if(['js','ts','jsx','tsx'].includes(ext??''))return (await import('@codemirror/lang-javascript')).javascript({typescript:ext==='ts'||ext==='tsx',jsx:ext==='jsx'||ext==='tsx'});if(ext==='json')return (await import('@codemirror/lang-json')).json();if(ext==='py')return (await import('@codemirror/lang-python')).python();if(ext==='html'||ext==='vue')return (await import('@codemirror/lang-html')).html();if(ext==='css')return (await import('@codemirror/lang-css')).css();if(ext==='yaml'||ext==='yml')return (await import('@codemirror/lang-yaml')).yaml();if(ext==='md')return (await import('@codemirror/lang-markdown')).markdown();return []}
async function save(){
  if(!editor||saving.value)return;saving.value=true;error.value='';const text=editor.state.doc.toString(),nextEncoding=encoding.value,nextLineEnding=lineEnding.value
  try{const result=await rpc<{version:string}>('files.save',{sessionId:props.document.sessionId,...props.document.file,text,version,encoding:nextEncoding,lineEnding:nextLineEnding},true);if(disposed)return;version=result.version;baseline=text;savedEncoding=nextEncoding;savedLineEnding=nextLineEnding;updateDirty()}
  catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:i18nT('mcf1487e7aa89')}finally{if(!disposed)saving.value=false}
}
function close(){if(saving.value)return;if(dirty.value&&!confirm(i18nT('m1dc658748ce3')))return;closeFileEditor(props.document.id)}
function move(event:PointerEvent){if(maximized.value||(event.target as HTMLElement).closest('button'))return;const x=event.clientX,y=event.clientY,start={...position.value};dragDimension(event,p=>{position.value={left:Math.max(0,Math.min(innerWidth-100,start.left+p.clientX-x)),top:Math.max(0,Math.min(innerHeight-40,start.top+p.clientY-y))}})}
function download(){if(!editor)return;const blob=new Blob([editor.state.doc.toString()],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=props.document.file.path.split('/').pop()??'file.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function clampPosition(){position.value={left:Math.max(0,Math.min(position.value.left,innerWidth-(element.value?.offsetWidth??340))),top:Math.max(0,Math.min(position.value.top,innerHeight-100))}}
function unload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue=''}}
watch([encoding,lineEnding],updateDirty)
onMounted(async()=>{window.addEventListener('beforeunload',unload);window.addEventListener('resize',clampPosition);const syntax=await language(props.document.file.path);if(disposed)return;editor=new EditorView({parent:host.value,state:EditorState.create({doc:baseline,extensions:[basicSetup,syntax,keymap.of([{key:'Mod-s',run:()=>{void save();return true}},indentWithTab]),EditorView.contentAttributes.of({'aria-label':i18nT('mf4ed6b721553')+props.document.file.path}),EditorView.updateListener.of(update=>{if(update.docChanged)updateDirty()}),EditorView.theme({'&':{height:'100%',backgroundColor:'var(--surface)',color:'var(--ink)'},'.cm-scroller':{overflow:'auto',fontFamily:'Consolas, monospace',fontSize:'13px'},'.cm-gutters':{backgroundColor:'var(--surface-soft)',color:'var(--muted)',borderColor:'var(--border)'},'.cm-activeLine,.cm-activeLineGutter':{backgroundColor:'var(--hover)'},'.cm-cursor':{borderLeftColor:'var(--ink)'},'.cm-selectionBackground':{backgroundColor:'var(--hover) !important'}})]})});editor.focus()})
onBeforeUnmount(()=>{disposed=true;editor?.destroy();window.removeEventListener('beforeunload',unload);window.removeEventListener('resize',clampPosition)})
</script>
<template>
  <Teleport to="body"><section ref="element" class="remote-file-editor" :class="{maximized}" role="dialog" :aria-label="i18nT('m20146c2fc82b')+document.file.path" :style="{left:position.left+'px',top:position.top+'px',zIndex:100+document.order}" @pointerdown="raiseFileEditor(document.id)">
    <header @pointerdown="move"><strong>{{ document.file.path.split('/').pop() }}<i v-if="dirty" :title="i18nT('m6a1be012c99c')"></i></strong><button class="button primary" :disabled="saving||connectionState!=='ready'" @click="save"><PhFloppyDisk :size="16"/>{{ saving?i18nT('ma1a1720d3eb5'):i18nT('ma3030bf8f16d') }}</button><button class="icon-button small" :title="i18nT('maee85e3f3d22')" :aria-label="i18nT('mf5b9b072fb67')" @click="download"><PhDownloadSimple :size="17"/></button><button class="icon-button small" :title="i18nT('m9949b1fb5f67')" :aria-label="i18nT('mee24b5e13ab2')" @click="maximized=!maximized"><PhArrowsOut :size="17"/></button><button class="icon-button small" :aria-label="i18nT('maea978624ec4')" :disabled="saving" @click="close"><PhX :size="17"/></button></header>
    <div class="file-editor-path" :title="document.file.path">{{ document.file.path }}</div><p v-if="error" class="file-operation-error" role="alert">{{ error }}</p><div ref="host" class="file-editor-content"></div>
    <footer><span>{{ i18nT('m47666a2f73db', { p0: (dirty?i18nT('m6a1be012c99c'):i18nT('m1bd91a7d0c53')) }) }}</span><label>{{ i18nT('me66883ffd17e') }}<select v-model="encoding" :disabled="saving" :aria-label="i18nT('m8d8d870b4d84')"><option value="utf8">UTF-8</option><option value="utf16le">UTF-16 LE</option><option value="utf16be">UTF-16 BE</option><option value="gb18030">GB18030</option></select></label><select v-model="lineEnding" :disabled="saving" :aria-label="i18nT('m58872d805504')"><option>LF</option><option>CRLF</option></select></footer>
  </section></Teleport>
</template>
