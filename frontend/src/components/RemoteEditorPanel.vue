<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.remoteEditor')

import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { PhCode, PhX, PhArrowSquareOut, PhDownloadSimple, PhStop, PhArrowClockwise } from '@phosphor-icons/vue'
import type { RemoteEditorStatus } from '@webnav/shared'
import { connectionState, rpc, vaultStatus } from '../backend'
import { remoteEditorRequest } from '../remote-editor'
const status=ref<RemoteEditorStatus>(),error=ref(''),busy=ref(false),accepted=ref(false)
const dialog=ref<HTMLDialogElement>()
let generation=0,polling=false
async function prepare(){const target=remoteEditorRequest.value;if(!target)return;const turn=++generation;status.value=undefined;error.value='';accepted.value=false;busy.value=true
  try{const result=await rpc<RemoteEditorStatus>('editor.prepare',{sessionId:target.sessionId,folder:target.folder},true);if(turn===generation)status.value=result}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:i18nT('m475e8f72b962')}finally{if(turn===generation)busy.value=false}
}
async function action(method:'editor.install'|'editor.stop'){if(!status.value||busy.value)return;const turn=generation;busy.value=true;error.value=''
  try{await rpc(method,{id:status.value.id,acceptLicense:accepted.value},true);if(turn===generation)await poll()}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:i18nT('mb3b75bd055c0')}finally{if(turn===generation)busy.value=false}
}
async function poll(){if(polling||!status.value||connectionState.value!=='ready')return;const turn=generation,id=status.value.id;polling=true
  try{const result=await rpc<RemoteEditorStatus>('editor.status',{id});if(turn===generation){status.value=result;error.value=''}}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:i18nT('m702275568df2')}finally{polling=false}
}
function close(){generation++;dialog.value?.close();remoteEditorRequest.value=undefined;status.value=undefined;error.value=''}
watch(remoteEditorRequest,async()=>{if(remoteEditorRequest.value){await nextTick();dialog.value?.showModal();void prepare()}})
watch(()=>vaultStatus.value?.unlocked,unlocked=>{if(unlocked===false)close()})
const timer=setInterval(()=>{if(remoteEditorRequest.value)void poll()},1500)
onBeforeUnmount(()=>{generation++;clearInterval(timer)})
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="remote-editor-dialog" aria-labelledby="remote-editor-title" @cancel.prevent="close">
    <section v-if="remoteEditorRequest" class="remote-editor-panel">
      <header><span class="remote-editor-symbol"><PhCode :size="24"/></span><div><h2 id="remote-editor-title">{{ i18nT('md8a6cb39e705') }}</h2><p>{{ remoteEditorRequest.name }}</p></div><button class="icon-button" :aria-label="i18nT('m7cbb50cd65a9')" :title="i18nT('m90bb34c2f1de')" @click="close"><PhX :size="20"/></button></header>
      <code class="remote-editor-folder">{{ status?.folder??remoteEditorRequest.folder }}</code>
      <div class="remote-editor-status" role="status"><strong>{{ status?.product??i18nT('mabb93c55f560') }}<small v-if="status?.version">{{ status.version }}</small></strong><p v-if="status?.state!=='error'">{{ status?.message??i18nT('mc736bac0b6c3') }}</p><progress v-if="status&&['downloading','uploading'].includes(status.state)" :value="status.progress" max="100"/><small v-if="status?.progress!==undefined">{{ status.progress }}%</small></div>
      <p v-if="error||status?.state==='error'" class="field-error" role="alert">{{ error||status?.message }}</p>
      <template v-if="status?.state==='needs-install'"><p class="field-hint">{{ i18nT('m3c747325cf69') }}</p><label v-if="status.licenseUrl" class="remote-editor-license"><input v-model="accepted" type="checkbox"/>{{ i18nT('me2af8d3bfffa') }}<a :href="status.licenseUrl" target="_blank" rel="noopener noreferrer">{{ i18nT('m7012f396a6b8') }}</a></label></template>
      <p v-if="status?.state==='ready'" class="field-hint">{{ i18nT('m65acfd20cb72') }}</p>
      <footer><button v-if="status&&!['stopped','error'].includes(status.state)" class="button subtle" :disabled="busy||connectionState!=='ready'" @click="action('editor.stop')"><PhStop :size="16"/>{{ i18nT('mca4d973c0b00') }}</button><span></span><button v-if="status?.state==='needs-install'" class="button primary" :disabled="busy||connectionState!=='ready'||!!status.licenseUrl&&!accepted" @click="action('editor.install')"><PhDownloadSimple :size="17"/>{{ i18nT('m4cd94a10b5f4') }}</button><a v-else-if="status?.state==='ready'&&status.url&&connectionState==='ready'" class="button primary" :href="status.url" target="_blank" rel="noopener noreferrer"><PhArrowSquareOut :size="17"/>{{ i18nT('m4bffc7dd28dc') }}</a><button v-else-if="error||status&&['error','stopped'].includes(status.state)" class="button" :disabled="busy||connectionState!=='ready'" @click="prepare"><PhArrowClockwise :size="17"/>{{ i18nT('mb8784c8dd563') }}</button></footer>
    </section>
  </dialog></Teleport>
</template>
