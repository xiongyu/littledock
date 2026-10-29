<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { PhArrowLeft, PhArrowClockwise, PhDownloadSimple } from '@phosphor-icons/vue'
import type { UpdateState } from '@webnav/shared'
import { rpc, connectionState } from '../backend'
defineEmits<{ back: [] }>()
const state = ref<UpdateState>(), error = ref(''), busy = ref(false), interrupt = ref(false)
let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
async function refresh() {
  try { if (connectionState.value === 'ready') { state.value = await rpc<UpdateState>('updates.status'); error.value = '' } }
  catch (cause) { error.value = (cause as Error).message }
  finally { if (!disposed) timer = setTimeout(refresh, 1500) }
}
async function act(action: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { state.value = await rpc<UpdateState>('updates.' + action, { ...(state.value?.targetVersion ? { targetVersion: state.value.targetVersion } : {}), ...(action === 'install' ? { interrupt: interrupt.value } : {}) }, action !== 'check'); interrupt.value = false }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = false }
}
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>
<template>
  <section class="update-panel">
    <button class="button" @click="$emit('back')"><PhArrowLeft :size="16" />返回设置</button>
    <h3>工作台更新</h3>
    <p v-if="!state">正在读取更新状态…</p>
    <template v-else>
      <p>当前版本 <strong>{{ state.currentVersion }}</strong><span v-if="state.targetVersion && state.targetVersion !== state.currentVersion"> → {{ state.targetVersion }}</span></p>
      <p role="status">{{ connectionState !== 'ready' ? '正在等待工作台重新连接，更新进度将在连接后恢复。' : state.message }}</p>
      <progress v-if="state.phase === 'downloading'" :value="state.progress ?? 0" max="100" :aria-label="`下载进度 ${state.progress ?? 0}%`" />
      <p v-if="state.phase === 'downloading'">{{ state.progress ?? 0 }}%</p>
      <p v-if="state.notes" class="release-notes">{{ state.notes }}</p>
      <ul v-if="state.blockers?.length"><li v-for="reason in state.blockers" :key="reason">{{ reason }}</li></ul>
      <p v-if="state.checkedAt" class="muted">上次检查：{{ new Date(state.checkedAt).toLocaleString('zh-CN') }}</p>
      <template v-if="state.mode === 'installed'">
        <p v-if="['ready','waiting'].includes(state.phase)">安装会重启工作台。默认等待连接和任务结束；更新失败时会尝试恢复上一版。</p>
        <label v-if="['ready','waiting'].includes(state.phase)" class="check-label"><input v-model="interrupt" type="checkbox" />结束现有连接与任务后安装（未完成工作会中断）</label>
        <div class="update-actions">
          <button v-if="['idle','available','failed','succeeded'].includes(state.phase)" class="button" :disabled="busy || connectionState !== 'ready'" @click="act('check')"><PhArrowClockwise :size="16" />检查更新</button>
          <button v-if="state.targetVersion && ['available','failed'].includes(state.phase)" class="button primary" :disabled="busy || connectionState !== 'ready'" @click="act('download')"><PhDownloadSimple :size="16" />下载更新</button>
          <button v-if="state.phase === 'ready' || (state.phase === 'waiting' && interrupt)" class="button primary" :disabled="busy || connectionState !== 'ready'" @click="act('install')">{{ interrupt ? '确认结束任务并安装' : '空闲后安装并重启' }}</button>
          <button v-if="['downloading','waiting'].includes(state.phase)" class="button" :disabled="busy || connectionState !== 'ready'" @click="act('cancel')">{{ state.phase === 'waiting' ? '取消安装' : '取消下载' }}</button>
        </div>
      </template>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.update-panel{display:grid;gap:14px;min-width:0}.update-panel>.button{justify-self:start}.update-panel h3,.update-panel p{margin:0;line-height:1.8}.update-panel progress{width:100%;accent-color:var(--accent)}.release-notes{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-soft);padding:14px;border-radius:9px}.update-actions{display:flex;flex-wrap:wrap;gap:10px}.muted{color:var(--muted);font-size:12px}.check-label{align-items:flex-start;line-height:1.8}
</style>
