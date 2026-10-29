<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

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
    <button class="button" @click="$emit('back')"><PhArrowLeft :size="16" />{{ i18nT('md00bfe7c685c') }}</button>
    <h3>{{ i18nT('m50303a8bf686') }}</h3>
    <p v-if="!state">{{ i18nT('md6462cebf70c') }}</p>
    <template v-else>
      <p>{{ i18nT('m837bc9576721') }}<strong>{{ state.currentVersion }}</strong><span v-if="state.targetVersion && state.targetVersion !== state.currentVersion"> → {{ state.targetVersion }}</span></p>
      <p role="status">{{ connectionState !== 'ready' ? i18nT('me736eeb87edd') : state.message }}</p>
      <progress v-if="state.phase === 'downloading'" :value="state.progress ?? 0" max="100" :aria-label="i18nT('m738c565439e5', { p0: (state.progress ?? 0) })" />
      <p v-if="state.phase === 'downloading'">{{ state.progress ?? 0 }}%</p>
      <p v-if="state.notes" class="release-notes">{{ state.notes }}</p>
      <ul v-if="state.blockers?.length"><li v-for="reason in state.blockers" :key="reason">{{ reason }}</li></ul>
      <p v-if="state.checkedAt" class="muted">{{ i18nT('md4c6f685e7f9', { p0: (new Date(state.checkedAt).toLocaleString(displayLocale())) }) }}</p>
      <template v-if="state.mode === 'installed'">
        <p v-if="['ready','waiting'].includes(state.phase)">{{ i18nT('md327bc974fc7') }}</p>
        <label v-if="['ready','waiting'].includes(state.phase)" class="check-label"><input v-model="interrupt" type="checkbox" />{{ i18nT('m3c6dc4aa9167') }}</label>
        <div class="update-actions">
          <button v-if="['idle','available','failed','succeeded'].includes(state.phase)" class="button" :disabled="busy || connectionState !== 'ready'" @click="act('check')"><PhArrowClockwise :size="16" />{{ i18nT('m7f68ebad19ba') }}</button>
          <button v-if="state.targetVersion && ['available','failed'].includes(state.phase)" class="button primary" :disabled="busy || connectionState !== 'ready'" @click="act('download')"><PhDownloadSimple :size="16" />{{ i18nT('ma78b542de282') }}</button>
          <button v-if="state.phase === 'ready' || (state.phase === 'waiting' && interrupt)" class="button primary" :disabled="busy || connectionState !== 'ready'" @click="act('install')">{{ interrupt ? i18nT('m87e199e64570') : i18nT('mdf9a685fcae3') }}</button>
          <button v-if="['downloading','waiting'].includes(state.phase)" class="button" :disabled="busy || connectionState !== 'ready'" @click="act('cancel')">{{ state.phase === 'waiting' ? i18nT('m191a09e32e31') : i18nT('m14d1e349b140') }}</button>
        </div>
      </template>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.update-panel{display:grid;gap:14px;min-width:0}.update-panel>.button{justify-self:start}.update-panel h3,.update-panel p{margin:0;line-height:1.8}.update-panel progress{width:100%;accent-color:var(--accent)}.release-notes{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-soft);padding:14px;border-radius:9px}.update-actions{display:flex;flex-wrap:wrap;gap:10px}.muted{color:var(--muted);font-size:12px}.check-label{align-items:flex-start;line-height:1.8}
</style>
