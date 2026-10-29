<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.webBookmarks')

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowLeft, PhCopy, PhTrash, PhArrowClockwise } from '@phosphor-icons/vue'
import type { ExtensionStatus } from '@webnav/shared'
import { connectionState, rpc, vaultStatus } from '../backend'
defineEmits<{ back: [] }>()
const state = ref<ExtensionStatus>({ devices: [] }), name = ref(i18nT('mb55f21752e33')), password = ref(''), busy = ref(false), error = ref(''), message = ref('')
const pairing = ref<{ id: string; code: string; expiresAt: number }>(), now = ref(Date.now())
const enabled = computed(() => connectionState.value === 'ready' && vaultStatus.value?.unlocked)
const seconds = computed(() => Math.max(0, Math.ceil(((pairing.value?.expiresAt ?? 0) - now.value) / 1000)))
let alive = true, generation = 0, polling = false, timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  if (!enabled.value || polling) return
  polling = true; const expected = generation
  try {
    const next = await rpc<ExtensionStatus>('extensions.status')
    if (!alive || !enabled.value || expected !== generation) return
    state.value = next
    if (pairing.value && next.devices.some(d => d.id === pairing.value!.id)) { pairing.value = undefined; message.value = i18nT('meeaa9848bb24') }
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : i18nT('m70d575e3ee6c') }
  finally { polling = false }
}
function cancel() {
  const old = pairing.value; pairing.value = undefined; password.value = ''; generation++
  if (old && connectionState.value === 'ready') void rpc('extensions.cancelPairing', { id: old.id }, true).catch(() => {})
}
async function begin() {
  if (busy.value || !enabled.value) return
  const masterPassword = password.value
  cancel(); const expected = generation; busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await rpc<{ id: string; code: string; expiresAt: number }>('extensions.beginPairing', { name: name.value, masterPassword }, true)
    if (!alive || !enabled.value || expected !== generation) { void rpc('extensions.cancelPairing', { id: result.id }, true).catch(() => {}); return }
    pairing.value = result
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : i18nT('ma444762ee3e0') }
  finally { password.value = ''; busy.value = false }
}
async function copy() { if (!pairing.value) return; try { await navigator.clipboard.writeText(pairing.value.code); message.value = i18nT('m82d4cc66967c') } catch { error.value = i18nT('m872e1026735e') } }
async function revoke(id: string, bookmarkId?: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { state.value = await rpc<ExtensionStatus>(bookmarkId ? 'extensions.revokeGrant' : 'extensions.revoke', { id, ...(bookmarkId ? { bookmarkId } : {}) }, true); message.value = bookmarkId ? i18nT('mea4608c0a683') : i18nT('me3dcc80c5b78') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('m821ea94f6bb0') }
  finally { busy.value = false }
}
watch(enabled, value => { if (!value) { cancel(); state.value = { devices: [] } } else void refresh() })
onMounted(() => { void refresh(); timer = setInterval(() => { now.value = Date.now(); if (pairing.value && !seconds.value) cancel(); if (pairing.value) void refresh() }, 1000) })
onBeforeUnmount(() => { alive = false; clearInterval(timer); cancel() })
</script>
<template>
  <section class="extension-panel">
    <button class="button extension-back" @click="$emit('back')"><PhArrowLeft :size="16" />{{ i18nT('m3f754f38a654') }}</button>
    <p class="field-hint">{{ i18nT('mfcdd48cfe3c8') }}</p>
    <div class="extension-downloads"><a class="button" href="/extensions/webnav-chrome.zip" download>{{ i18nT('mf0eeb536feff') }}</a><a class="button" href="/extensions/webnav-edge.zip" download>{{ i18nT('m1683bdadc9c6') }}</a><a class="button" href="/extensions/webnav-firefox.zip" download>{{ i18nT('mee2d4160699c') }}</a></div>
    <details class="extension-help"><summary>{{ i18nT('m88cd0b468166') }}</summary><p>{{ i18nT('m00517e85b222') }}</p><p>{{ i18nT('m33789356c620') }}</p></details>
    <form class="extension-pairing" @submit.prevent="begin">
      <h3>{{ i18nT('mc04e505ac16a') }}</h3>
      <label class="form-field"><span>{{ i18nT('mbf19dceae87d') }}</span><input v-model="name" maxlength="60" required :disabled="busy || !enabled" :placeholder="i18nT('m69536b1b7a3e')" /></label>
      <label v-if="vaultStatus?.mode === 'master'" class="form-field"><span>{{ i18nT('mdecc928ee46e') }}</span><input v-model="password" type="password" autocomplete="current-password" required :disabled="busy || !enabled" /></label>
      <p class="field-hint">{{ i18nT('mb9f9eb987905') }}</p>
      <button class="button primary" type="submit" :disabled="busy || !enabled">{{ busy ? i18nT('m574ec7517de1') : i18nT('me7f1d27e6563') }}</button>
    </form>
    <div v-if="pairing" class="extension-code"><div><strong>{{ i18nT('m1deb9540ecc2', { p0: (seconds) }) }}</strong><button class="icon-button" :title="i18nT('m43e714e6d1a6')" :aria-label="i18nT('m43e714e6d1a6')" @click="copy"><PhCopy :size="18" /></button></div><textarea :value="pairing.code" readonly :aria-label="i18nT('m46af9f1b315f')" rows="3" spellcheck="false" /><button class="button" @click="cancel">{{ i18nT('ma3ed03ecc809') }}</button></div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><p v-if="message" class="field-hint" role="status">{{ message }}</p>
    <div class="extension-heading"><h3>{{ i18nT('mac86c5c9a766') }}</h3><button class="icon-button" :title="i18nT('m7abeb2be7c41')" :aria-label="i18nT('m7abeb2be7c41')" :disabled="!enabled" @click="refresh"><PhArrowClockwise :size="18" /></button></div>
    <p v-if="!state.devices.length" class="field-hint">{{ enabled ? i18nT('m64a5756b1f3b') : i18nT('m36ea6e555466') }}</p>
    <article v-for="device in state.devices" :key="device.id" class="extension-device"><div class="extension-heading"><div><strong>{{ device.name }}</strong><small>{{ i18nT('m5ab60dd59988', { p0: (new Date(device.lastUsedAt).toLocaleString(displayLocale())) }) }}</small></div><button class="icon-button" :title="i18nT('m995bc388ecbc', { p0: (device.name) })" :aria-label="i18nT('m995bc388ecbc', { p0: (device.name) })" :disabled="busy || !enabled" @click="revoke(device.id)"><PhTrash :size="18" /></button></div>
      <p v-if="!device.grants.length" class="field-hint">{{ i18nT('m3b307fb10e8f') }}</p>
      <div v-for="grant in device.grants" :key="grant.bookmarkId" class="extension-grant"><div><strong>{{ grant.name }}</strong><small>{{ grant.origin }} · {{ grant.automatic ? i18nT('m74ec8b9ba0f9') : i18nT('m0d96e1cda48f') }}</small></div><button class="icon-button" :title="i18nT('m7e9ba868e0a9', { p0: (grant.name) })" :aria-label="i18nT('m7e9ba868e0a9', { p0: (grant.name) })" :disabled="busy || !enabled" @click="revoke(device.id, grant.bookmarkId)"><PhTrash :size="16" /></button></div>
    </article>
  </section>
</template>
<style scoped>
.extension-panel{display:grid;gap:16px}.extension-back{justify-self:start;display:flex;align-items:center;gap:8px}.extension-panel h3,.extension-panel p{margin:0}.extension-downloads{display:flex;flex-wrap:wrap;gap:8px}.extension-downloads a{text-decoration:none}.extension-help{font-size:13px;color:var(--muted);line-height:1.7}.extension-help p{margin-top:10px}.extension-pairing{display:grid;gap:14px;padding-top:12px;border-top:1px solid var(--border)}.extension-pairing .primary{justify-self:start}.extension-code{display:grid;gap:10px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.extension-code>div,.extension-heading,.extension-grant{display:flex;align-items:center;justify-content:space-between;gap:12px}.extension-code textarea{width:100%;resize:vertical;word-break:break-all;background:var(--page);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:10px}.extension-device{border:1px solid var(--border);border-radius:12px;padding:14px;display:grid;gap:12px}.extension-device small{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.extension-heading>div,.extension-grant>div{min-width:0}.extension-grant{padding-top:10px;border-top:1px solid var(--border)}.extension-grant strong{font-size:13px}
</style>
