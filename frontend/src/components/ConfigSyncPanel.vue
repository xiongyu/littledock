<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.configSync')

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { SyncChoice, SyncHistory, SyncPreview, SyncSettings, SyncStatus } from '@webnav/shared'
import { configSyncStatus as status, connectionState, rpc, vaultStatus } from '../backend'

defineEmits<{ back: [] }>()
defineProps<{ embedded?: boolean }>()
const newId = () => crypto.randomUUID().replaceAll('-', '')
const settings = reactive<SyncSettings>({ provider: 'github', repository: '', branch: 'webnav-sync', spaceId: newId(), username: '', includeSecrets: false, includePlugins: false, autoSync: false })
const token = ref(''), saveToken = ref(false), account = ref(''), password = ref(''), confirmation = ref(''), create = ref(true), minutes = ref(30)
const busy = ref(false), error = ref(''), notice = ref(''), expected = ref('null'), preview = ref<SyncPreview>(), choices = reactive<Record<string, SyncChoice>>({}), mode = ref<'merge' | 'local' | 'remote'>('merge')
const history = ref<SyncHistory>(), restoreVersion = ref(''), oldAccount = ref(''), oldPassword = ref(''), acceptHistory = ref(false), discontinuity = ref(false), rotating = ref(false)
const nextAccount = ref(''), nextPassword = ref(''), nextConfirmation = ref('')
let disposed = false, generation = 0
const enabled = computed(() => connectionState.value === 'ready' && !busy.value && !status.value?.busy)
const canSync = computed(() => enabled.value && status.value?.unlocked && !status.value.pending)
const stable = (value: SyncSettings | null) => value === null ? 'null' : JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString(displayLocale()) : i18nT('m439e864e8324')
function clearSecrets() { token.value = ''; password.value = ''; confirmation.value = ''; oldPassword.value = ''; nextPassword.value = ''; nextConfirmation.value = '' }
async function refresh(fill = false) {
  const version = generation, result = await rpc<SyncStatus>('configSync.watch')
  if (disposed || version !== generation || connectionState.value !== 'ready') return
  status.value = result
  if (fill) { expected.value = stable(result.settings); if (result.settings) { Object.assign(settings, result.settings); create.value = false }; saveToken.value = result.tokenSaved }
}
async function action(work: () => Promise<unknown>) {
  if (!enabled.value) return
  busy.value = true; error.value = ''; notice.value = ''; const version = generation
  try { await work(); if (!disposed && version === generation && connectionState.value === 'ready') await refresh() }
  catch (cause) { if (!disposed && version === generation) error.value = cause instanceof Error ? cause.message : i18nT('m156ca5914574') }
  finally { busy.value = false }
}
function resetPreview() { preview.value = undefined; restoreVersion.value = ''; for (const key of Object.keys(choices)) delete choices[key] }
async function save() {
  const submitted = token.value; token.value = ''
  await action(async () => { await rpc('configSync.configure', { settings: { ...settings }, expected: expected.value, ...(submitted ? { token: submitted } : {}), saveToken: saveToken.value }, true); resetPreview(); await refresh(true); notice.value = i18nT('m356f18adb987') })
}
async function unlock() {
  account.value = account.value.normalize('NFC').trim()
  if (create.value && password.value !== confirmation.value) { error.value = i18nT('mb0c33a2aedd5'); return }
  const submitted = password.value, submittedToken = token.value; password.value = ''; confirmation.value = ''; token.value = ''
  await action(() => rpc('configSync.unlock', { account: account.value, password: submitted, minutes: minutes.value, create: create.value, ...(submittedToken ? { token: submittedToken } : {}) }, true, 120_000))
  if (status.value?.unlocked) create.value = false
}
async function compare() {
  const old = oldPassword.value; oldPassword.value = ''
  await action(async () => { const result = await rpc<SyncPreview>('configSync.preview', { mode: restoreVersion.value ? 'restore' : mode.value, choices: { ...choices }, acceptDiscontinuity: discontinuity.value, ...(restoreVersion.value ? { version: restoreVersion.value } : {}), ...(old ? { oldAccount: oldAccount.value, oldPassword: old } : {}) }, true, 120_000); if (!disposed && connectionState.value === 'ready') preview.value = result })
}
async function commit() { await action(async () => { await rpc('configSync.apply', { token: preview.value!.token }, true, 180_000); resetPreview(); notice.value = i18nT('mdb088733b051') }) }
async function loadHistory(more = false) { await action(async () => { const result = await rpc<SyncHistory>('configSync.history', more && history.value?.cursor ? { cursor: history.value.cursor } : {}, false, 120_000); if (!disposed) history.value = { versions: [...(more ? history.value?.versions ?? [] : []), ...result.versions], cursor: result.cursor } }) }
async function rotate() {
  if (nextPassword.value !== nextConfirmation.value) { error.value = i18nT('m441bc4543c73'); return }
  const secret = nextPassword.value; nextPassword.value = ''; nextConfirmation.value = ''
  await action(async () => { await rpc('configSync.rotatePassword', { account: nextAccount.value, password: secret, acceptHistory: acceptHistory.value }, true, 180_000); account.value = nextAccount.value.normalize('NFC').trim(); rotating.value = false; resetPreview() })
}
watch(connectionState, state => { generation++; clearSecrets(); preview.value = undefined; if (state === 'ready') void refresh(true).catch(() => {}); else { history.value = undefined; error.value = '' } })
watch(() => status.value?.unlocked, unlocked => { if (!unlocked) { clearSecrets(); preview.value = undefined; history.value = undefined } })
onMounted(() => { void refresh(true).catch(cause => { error.value = cause.message }) })
onBeforeUnmount(() => { disposed = true; generation++; clearSecrets(); preview.value = undefined; history.value = undefined })
</script>

<template>
  <div class="sync-panel">
    <button v-if="!embedded" class="button sync-back" @click="$emit('back')">{{ i18nT('m0cec99ee0b8d') }}</button>
    <p class="sync-intro">{{ i18nT('m71911723650f') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice" class="sync-notice" role="status">{{ notice }}</p>
    <section class="sync-status" aria-live="polite"><strong>{{ status?.unlocked ? i18nT('m2c3f03d514bf') : i18nT('m1b2c8dbae370') }}</strong><p>{{ status?.message ?? i18nT('m9ee695637140') }}</p><small>{{ i18nT('m585941ca9105', { p0: (time(status?.lastSuccess)) }) }}<template v-if="status?.expiresAt">{{ i18nT('md5e87661ee06', { p0: (time(status.expiresAt)) }) }}</template></small></section>
    <details :open="!status?.settings" class="sync-section"><summary>{{ i18nT('m7b73fda8837b') }}</summary>
      <div class="sync-fields"><label>{{ i18nT('md948637881a7') }}<select v-model="settings.provider"><option value="github">GitHub</option><option value="gitee">Gitee</option></select></label><label>{{ i18nT('me6161ef37a62') }}<input v-model="settings.repository" type="url" :placeholder="i18nT('m4fe12e42f190')" autocomplete="off" /></label><label>{{ i18nT('mb421c0b078ca') }}<input v-model="settings.username" autocomplete="off" :placeholder="i18nT('m8cdfe83891b1')" /></label><label>{{ i18nT('maaa6b1f2cd48') }}<input v-model="token" type="password" autocomplete="new-password" :placeholder="status?.hasToken ? i18nT('mc824fd694750') : i18nT('m4b22191a41bf')" /></label><label>{{ i18nT('ma251448a845f') }}<input v-model="settings.branch" autocomplete="off" /></label><label>{{ i18nT('mab5ab7707c08') }}<input v-model="settings.spaceId" maxlength="32" autocomplete="off" /><small>{{ i18nT('mc2be9ef8ac6e') }}<button class="sync-text-button" @click="settings.spaceId=newId()">{{ i18nT('mec1ba146f080') }}</button>。</small></label></div>
      <label class="check-label"><input v-model="saveToken" type="checkbox" :disabled="vaultStatus?.mode!=='master'" />{{ i18nT('md1e9723a66da') }}</label>
      <p>{{ i18nT('mf868755ee01a') }}</p>
      <label class="check-label"><input v-model="settings.includeSecrets" type="checkbox" />{{ i18nT('m192088d26c19') }}</label>
      <label class="check-label"><input v-model="settings.includePlugins" type="checkbox" />{{ i18nT('m92aa7183235a') }}</label>
      <label class="check-label"><input v-model="settings.autoSync" type="checkbox" :disabled="!status?.hasBaseline" />{{ i18nT('m9e2de75685af') }}</label>
      <div class="sync-actions"><button class="button primary" :disabled="!enabled" @click="save">{{ i18nT('mc8550237ba70') }}</button><button class="button" :disabled="!enabled || !status?.settings" @click="action(()=>rpc('configSync.check',{},false,120000))">{{ i18nT('m9fada042cf88') }}</button></div>
    </details>
    <section v-if="!status?.unlocked" class="sync-section"><h3>{{ i18nT('m08dd664ceb9f') }}</h3>
      <div class="sync-fields"><label>{{ i18nT('m14b2da2d58f3') }}<select v-model="create"><option :value="false">{{ i18nT('maf68d67fdd18') }}</option><option :value="true">{{ i18nT('m39e49d8b5c89') }}</option></select></label><label>{{ i18nT('m89043790d8ad') }}<input v-model="account" autocomplete="off" maxlength="256" /></label><label>{{ i18nT('m0cc6e7d5d23a') }}<input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" :placeholder="i18nT('m5a2b4598c78c')" @keyup.enter="unlock" /></label><label v-if="create">{{ i18nT('m1402acaedac9') }}<input v-model="confirmation" type="password" autocomplete="new-password" /></label><label>{{ i18nT('m758edb728b3e') }}<select v-model="minutes"><option :value="30">{{ i18nT('ma01a28d147ac') }}</option><option :value="240">{{ i18nT('m5f90852bb321') }}</option><option :value="0">{{ i18nT('m418a469b9cfd') }}</option></select></label></div>
      <p class="sync-hint">{{ i18nT('m24e2fd272722') }}</p>
      <button class="button primary" :disabled="!enabled || !status?.settings || !account || password.length<12" @click="unlock">{{ i18nT('mb159a233c2f3') }}</button>
    </section>
    <section v-else class="sync-section"><div class="sync-actions"><button class="button primary" :disabled="!canSync" @click="resetPreview();compare()">{{ i18nT('m298e070dbe44') }}</button><button class="button" :disabled="!canSync" @click="loadHistory()">{{ i18nT('m6fd29579ab66') }}</button><button class="button" :disabled="!canSync" @click="rotating=!rotating">{{ i18nT('m7d475811754f') }}</button><button class="button" :disabled="connectionState!=='ready'" @click="rpc('configSync.lock',{},true).catch(cause=>error=cause.message)">{{ i18nT('mff9872a023e3') }}</button></div>
      <label>{{ i18nT('m1722b54d9ca8') }}<select v-model="mode" @change="resetPreview()"><option value="merge">{{ i18nT('mc32b6eeadf06') }}</option><option value="local">{{ i18nT('m4ad03cdf3d27') }}</option><option value="remote">{{ i18nT('mcb6c0058ff68') }}</option></select></label>
      <details><summary>{{ i18nT('mf9061418a230') }}</summary><label class="check-label"><input v-model="discontinuity" type="checkbox" />{{ i18nT('m52eace9e3639') }}</label></details>
    </section>
    <section v-if="status?.pending" class="sync-section"><h3>{{ i18nT('m03ad054afc00') }}</h3><p>{{ i18nT('m353575ac53b1') }}</p><div class="sync-actions"><button class="button" :disabled="!enabled || !status.unlocked" @click="action(()=>rpc('configSync.recover',{},true,180000))">{{ i18nT('m11acad2cd394') }}</button><button class="button" :disabled="!enabled || !status.unlocked" @click="action(()=>rpc('configSync.recover',{retry:true},true,180000))">{{ i18nT('m44aaa769e1a1') }}</button></div></section>
    <section v-if="preview" class="sync-section sync-preview"><h3>{{ preview.first ? i18nT('mbd40ba89dfee') : preview.mode==='restore' ? i18nT('m10328a6f1af8') : i18nT('me44a5ab7d1c2') }}</h3><p>{{ i18nT('mf75e63d73d70', { p0: (preview.changeCount), p1: (preview.conflicts) }) }}</p><p v-for="warning in preview.warnings" :key="warning" class="sync-hint">{{ warning }}</p><p v-if="preview.hasDeletions" class="form-error">{{ i18nT('m25ce59dac4af') }}</p>
      <details v-for="change in preview.changes" :key="change.key" :open="change.conflict"><summary>{{ change.kind }} · {{ change.name }} <strong v-if="change.conflict">{{ i18nT('mc00884cf7707') }}</strong><span v-else>{{ change.action==='delete'?i18nT('m13909fb90468'):change.action==='add'?i18nT('m0006d696d8e1'):i18nT('m37090f456516') }}</span></summary><div class="sync-comparison"><div><b>{{ i18nT('m8a94c4a1cdbd') }}</b><pre>{{ change.local }}</pre></div><div><b>{{ i18nT('m45a38d424be7') }}</b><pre>{{ change.remote }}</pre></div></div><label v-if="change.conflict || choices[change.key]">{{ i18nT('m1d59606c1968') }}<select v-model="choices[change.key]"><option :value="undefined" disabled>{{ i18nT('mda590a8fe3ce') }}</option><option value="local">{{ i18nT('m8a94c4a1cdbd') }}</option><option value="remote">{{ i18nT('m45a38d424be7') }}</option></select></label></details>
      <p v-if="preview.changeCount>preview.changes.length">{{ i18nT('me5c2d3360af8', { p0: (preview.changes.length) }) }}</p>
      <div class="sync-actions"><button class="button" :disabled="!canSync" @click="compare">{{ i18nT('m4a05c9ce7654') }}</button><button class="button primary" :disabled="!canSync || preview.conflicts>0" @click="commit">{{ i18nT('m45eb6acd028e') }}</button><button class="button" @click="resetPreview">{{ i18nT('m2cd0f3be8738') }}</button></div>
    </section>
    <section v-if="history" class="sync-section"><h3>{{ i18nT('m13411f7e3ff9') }}</h3><p v-if="!history.versions.length">{{ i18nT('me692b28782a0') }}</p><div v-for="item in history.versions" :key="item.version" class="sync-history-row"><span>{{ time(item.time) }} · {{ item.version.slice(0,8) }}</span><button class="button" :disabled="!canSync" @click="restoreVersion=item.version;preview=undefined">{{ i18nT('m8609e2fc38f4') }}</button></div><button v-if="history.cursor" class="button" :disabled="!canSync" @click="loadHistory(true)">{{ i18nT('mf947dc4c8d79') }}</button>
      <div v-if="restoreVersion"><p>{{ i18nT('md9e9879365ee', { p0: (restoreVersion.slice(0,8)) }) }}</p><details><summary>{{ i18nT('mc586b106fddf') }}</summary><div class="sync-fields"><label>{{ i18nT('ma9261b540f65') }}<input v-model="oldAccount" autocomplete="off" /></label><label>{{ i18nT('me1493dcd7769') }}<input v-model="oldPassword" type="password" autocomplete="new-password" /></label></div></details><button class="button primary" :disabled="!canSync" @click="compare">{{ i18nT('m55e4fb4e789b') }}</button></div>
    </section>
    <section v-if="rotating && status?.unlocked" class="sync-section"><h3>{{ i18nT('m7d475811754f') }}</h3><div class="sync-fields"><label>{{ i18nT('m8034ae3362a7') }}<input v-model="nextAccount" autocomplete="off" /></label><label>{{ i18nT('mde4f06851a11') }}<input v-model="nextPassword" type="password" autocomplete="new-password" /></label><label>{{ i18nT('m6fde05a916c6') }}<input v-model="nextConfirmation" type="password" autocomplete="new-password" /></label></div><label class="check-label"><input v-model="acceptHistory" type="checkbox" />{{ i18nT('me85eb3ee4036') }}</label><button class="button primary" :disabled="!canSync || !acceptHistory || !nextAccount || nextPassword.length<12" @click="rotate">{{ i18nT('m4e5a94fe1893') }}</button></section>
    <section v-if="status?.bindings.length" class="sync-section"><h3>{{ i18nT('mcd37a404492c') }}</h3><p>{{ i18nT('m3c298494382d') }}</p><div v-for="binding in status.bindings" :key="binding.serverId+binding.connectionId" class="sync-history-row"><span>{{ binding.name }}</span><button class="button" :disabled="!enabled" @click="action(()=>rpc('configSync.confirmBinding',{...binding,confirm:true},true))">{{ i18nT('m8b7b0790802c') }}</button></div></section>
    <section v-if="status?.pluginPlan.length" class="sync-section"><h3>{{ i18nT('m61453179458f') }}</h3><p>{{ i18nT('m6247063bdd9a') }}</p><div v-for="plugin in status.pluginPlan" :key="plugin.id"><strong>{{ plugin.id }}</strong><p class="sync-repository">{{ plugin.repository }} · {{ plugin.commit.slice(0,8) }}</p></div></section>
  </div>
</template>

<style scoped>
.sync-panel{display:grid;gap:16px;min-width:0}.sync-back{justify-self:start}.sync-intro,.sync-hint{color:var(--muted);line-height:1.7}.sync-status,.sync-section{padding:18px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}.sync-status p,.sync-section p{line-height:1.7;margin:10px 0}.sync-section h3{margin:0 0 14px}.sync-section summary{cursor:pointer;font-weight:600;padding:6px 0}.sync-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0}.sync-panel label{display:flex;flex-direction:column;gap:7px;min-width:0}.sync-panel input:not([type=checkbox]),.sync-panel select{width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink)}.sync-panel .check-label{flex-direction:row;align-items:flex-start;margin:12px 0;line-height:1.6}.check-label input{margin-top:5px}.sync-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.sync-comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sync-comparison>div{min-width:0}.sync-comparison pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;font-size:12px;line-height:1.5;padding:10px;background:var(--surface-soft)}.sync-preview>details{border-top:1px solid var(--border);padding:10px 0}.sync-preview summary span,.sync-preview summary strong{margin-left:10px}.sync-history-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0}.sync-repository{overflow-wrap:anywhere;font-size:12px}.sync-notice{color:var(--accent)}.sync-text-button{border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;padding:0 3px}.sync-panel small{color:var(--muted);line-height:1.5}@media(max-width:640px){.sync-fields,.sync-comparison{grid-template-columns:1fr}.sync-section{padding:12px}.sync-history-row{align-items:flex-start;flex-direction:column}}
</style>
