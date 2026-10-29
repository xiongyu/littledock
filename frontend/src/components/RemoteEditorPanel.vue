<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { PhCode, PhX, PhArrowSquareOut, PhDownloadSimple, PhStop, PhArrowClockwise } from '@phosphor-icons/vue'
import type { RemoteEditorStatus } from '@webnav/shared'
import { connectionState, rpc, vaultStatus } from '../backend'
import { remoteEditorRequest } from '../remote-editor'
const status=ref<RemoteEditorStatus>(),error=ref(''),busy=ref(false),accepted=ref(false)
const dialog=ref<HTMLDialogElement>()
let generation=0,polling=false
async function prepare(){const target=remoteEditorRequest.value;if(!target)return;const turn=++generation;status.value=undefined;error.value='';accepted.value=false;busy.value=true
  try{const result=await rpc<RemoteEditorStatus>('editor.prepare',{sessionId:target.sessionId,folder:target.folder},true);if(turn===generation)status.value=result}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:'无法准备编辑器。'}finally{if(turn===generation)busy.value=false}
}
async function action(method:'editor.install'|'editor.stop'){if(!status.value||busy.value)return;const turn=generation;busy.value=true;error.value=''
  try{await rpc(method,{id:status.value.id,acceptLicense:accepted.value},true);if(turn===generation)await poll()}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:'操作失败。'}finally{if(turn===generation)busy.value=false}
}
async function poll(){if(polling||!status.value||connectionState.value!=='ready')return;const turn=generation,id=status.value.id;polling=true
  try{const result=await rpc<RemoteEditorStatus>('editor.status',{id});if(turn===generation){status.value=result;error.value=''}}catch(cause){if(turn===generation)error.value=cause instanceof Error?cause.message:'状态读取失败。'}finally{polling=false}
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
      <header><span class="remote-editor-symbol"><PhCode :size="24"/></span><div><h2 id="remote-editor-title">远程 VS Code</h2><p>{{ remoteEditorRequest.name }}</p></div><button class="icon-button" aria-label="关闭编辑器面板" title="收起面板" @click="close"><PhX :size="20"/></button></header>
      <code class="remote-editor-folder">{{ status?.folder??remoteEditorRequest.folder }}</code>
      <div class="remote-editor-status" role="status"><strong>{{ status?.product??'检测服务器' }}<small v-if="status?.version">{{ status.version }}</small></strong><p v-if="status?.state!=='error'">{{ status?.message??'检查远端环境…' }}</p><progress v-if="status&&['downloading','uploading'].includes(status.state)" :value="status.progress" max="100"/><small v-if="status?.progress!==undefined">{{ status.progress }}%</small></div>
      <p v-if="error||status?.state==='error'" class="field-error" role="alert">{{ error||status?.message }}</p>
      <template v-if="status?.state==='needs-install'"><p class="field-hint">安装到当前 SSH 用户目录，无需管理员权限。同版本安装包只下载一次，后续从本机缓存上传。</p><label v-if="status.licenseUrl" class="remote-editor-license"><input v-model="accepted" type="checkbox"/>我已阅读并接受 <a :href="status.licenseUrl" target="_blank" rel="noopener noreferrer">VS Code Server 使用条款</a></label></template>
      <p v-if="status?.state==='ready'" class="field-hint">在独立浏览器页面编辑，保存直接写入远端。停止编辑器、关闭所属 SSH 或锁定主密码后，编辑器连接会关闭。</p>
      <footer><button v-if="status&&!['stopped','error'].includes(status.state)" class="button subtle" :disabled="busy||connectionState!=='ready'" @click="action('editor.stop')"><PhStop :size="16"/>停止</button><span></span><button v-if="status?.state==='needs-install'" class="button primary" :disabled="busy||connectionState!=='ready'||!!status.licenseUrl&&!accepted" @click="action('editor.install')"><PhDownloadSimple :size="17"/>安装并启动</button><a v-else-if="status?.state==='ready'&&status.url&&connectionState==='ready'" class="button primary" :href="status.url" target="_blank" rel="noopener noreferrer"><PhArrowSquareOut :size="17"/>打开编辑器</a><button v-else-if="error||status&&['error','stopped'].includes(status.state)" class="button" :disabled="busy||connectionState!=='ready'" @click="prepare"><PhArrowClockwise :size="17"/>重试</button></footer>
    </section>
  </dialog></Teleport>
</template>
