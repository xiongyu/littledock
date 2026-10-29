<script setup lang="ts">
import { pluginI18n, pluginText, localizedManifest, currentLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { PhArrowClockwise, PhArrowSquareOut, PhCheckCircle, PhDownloadSimple, PhGitBranch, PhGearSix, PhInfo, PhPower, PhTrash, PhMagnifyingGlass, PhPuzzlePiece, PhShieldCheck, PhX } from '@phosphor-icons/vue'
import { pluginCategories as categoryDefaults, pluginRisk as riskDefaults, serviceCapabilities as capabilityDefaults, type PluginCategory, type PluginManifest, type PluginMarket, type PluginState, type PluginDetails, type PluginPreview } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
import { pluginState, pluginLoadErrors, refreshThemes, loadPlugins } from '../plugins'
import { applyMarketTheme } from '../theme-market'

import { pluginTools, pluginTabs, openPluginTool, openPluginSettings, closePluginTab } from '../plugin-workspace'
function hasSettings(card: Card) { const m = card.manifest; return !!(m?.contributes?.settings || m?.contributes?.fonts.length || m?.configFields?.length) }
function installedFor(card: Card) { return installed.value.find(item => item.manifest.id === card.id) }
async function askUninstall(card: Card) { await open(card); uninstallId.value = card.id }
function toolFor(card: Card) { return Object.values(pluginTools).find(t => t.pluginId === card.id) }
function settings(card: Card) { detailDialog.value?.close(); openPluginSettings(card.id) }
function launch(card: Card) { const tool = toolFor(card); if (tool) { detailDialog.value?.close(); openPluginTool(tool.key) } }

type Card = { bundled?: boolean; id: string; name: string; description: string; category: PluginCategory; secondaryCategories: PluginCategory[]; platforms: PluginManifest['platforms']; publisher: 'builtin' | 'official' | 'community'; repository?: string; ref?: string; iconDataUrl?: string; manifest?: PluginManifest; readme?: string }
const state = ref<PluginState>(), market = ref<PluginMarket>(), tab = ref<'market' | 'installed'>('installed')
watch(pluginState, value => {
  if (!value) return
  const wasPending = state.value?.pending.some(p => p.id === details.value?.id)
  state.value = value
  if (wasPending && notice.value) notice.value = resultNotice(details.value?.id)
})
const search = ref(''), category = ref(''), source = ref(''), compatibleOnly = ref(true)
const visibleLimit = ref(48)
const busy = ref(''), error = ref(''), notice = ref(''), loadingMarket = ref(false), gitOpen = ref(false)
const repository = ref(''), gitRef = ref('HEAD'), accepted = ref(false), preview = ref<PluginPreview>()
const details = ref<Card>(), detailDialog = ref<HTMLDialogElement>(), detailLoading = ref(false)
const metadata = ref<Record<string, PluginDetails>>({}), failedMetadata = new Set<string>()
const config = ref<Record<string, string | number | boolean>>({}), uninstallId = ref('')
let disposed = false, metadataVersion = 0
const timestamp = (value: number | null) => value ? new Date(value).toLocaleString(currentLocale.value) : i18nT('mc4cf69f358b6')
const platformName = (os: string) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[os] ?? os)
const platformsText = (platforms: PluginManifest['platforms']) => platforms.map(p => `${platformName(p.os)} ${p.arch}`).join(' · ')
const pluginCategories = computed(() => Object.fromEntries(Object.entries(categoryDefaults).map(([id, label]) => [id, pluginText('core', `categories.${id}`, label)])))
const pluginRisk = computed(() => Object.fromEntries(Object.entries(riskDefaults).map(([id, label]) => [id, pluginText('core', `risk.${id}`, label)])))
const serviceCapabilities = computed(() => Object.fromEntries(Object.entries(capabilityDefaults).map(([id, label]) => [id, pluginText('core', `capabilities.${id}`, label)])))
const categoriesText = (manifest: PluginManifest) => [manifest.category, ...manifest.secondaryCategories].map(c => pluginCategories.value[c]).join(' / ')
const capabilityName = (id: string) => id === 'theme:appearance' ? i18nT('m8f29293906e7') : id.startsWith('service:') ? serviceCapabilities.value[id.slice(8)] ?? id : id.startsWith('connector:') ? i18nT('m83b3bd340c24', { p0: (id.slice(10)) }) : id.slice(10)
const installed = computed(() => state.value?.installed ?? [])
const cards = computed<Card[]>(() => {
  const builtin = (state.value?.builtins ?? []).map(p => ({ ...p.manifest, id: p.id, publisher: 'builtin' as const, iconDataUrl: p.iconDataUrl, manifest: p.manifest, readme: p.readme }))
  const bundled = (state.value?.bundled ?? []).filter(p => !installed.value.some(item => item.manifest.id === p.manifest.id && item.source !== 'bundled')).map(p => ({ ...p.manifest, publisher: 'official' as const, bundled: true, manifest: p.manifest, iconDataUrl: p.iconDataUrl, readme: p.readme }))
  const remotes = (market.value?.index.plugins ?? []).filter(p => !bundled.some(local => local.id === p.id)).map(entry => ({ ...entry, ...(metadata.value[entry.repository] ? { ...metadata.value[entry.repository]!.manifest, manifest: metadata.value[entry.repository]!.manifest, iconDataUrl: metadata.value[entry.repository]!.iconDataUrl, readme: metadata.value[entry.repository]!.readme } : {}) }))
  const extras = installed.value.filter(p => !remotes.some(r => r.id === p.manifest.id) && !bundled.some(r => r.id === p.manifest.id)).map(p => ({ ...p.manifest, ...(p.source === 'bundled' ? { bundled: true } : { repository: p.repository, ref: p.ref }), publisher: p.source === 'bundled' ? 'official' as const : 'community' as const, manifest: p.manifest, iconDataUrl: metadata.value[p.repository]?.iconDataUrl }))
  const result = tab.value === 'installed' ? [...bundled.filter(card => installed.value.some(p => p.manifest.id === card.id)), ...extras, ...remotes.filter(card => installed.value.some(p => p.manifest.id === card.id)), ...builtin] : [...bundled, ...builtin, ...remotes, ...extras]
  return result.map(card => ({ ...card, name: pluginText(card.id, 'metadata.name', card.name), description: pluginText(card.id, 'metadata.description', card.description), ...(card.manifest ? { manifest: localizedManifest(card.manifest) } : {}) }))
})
const isCompatible = (card: Card) => !state.value || card.platforms.some(p => p.os === state.value!.host.os && p.arch === state.value!.host.arch)
const filtered = computed(() => cards.value.filter(card => {
  if (tab.value === 'installed' && card.publisher !== 'builtin' && !installed.value.some(p => p.manifest.id === card.id)) return false
  return (!category.value || card.category === category.value || card.secondaryCategories.includes(category.value as PluginCategory)) && (!source.value || card.publisher === source.value || (source.value === 'builtin' && card.bundled)) && (tab.value === 'installed' || !compatibleOnly.value || isCompatible(card)) && (!search.value || `${card.name} ${card.description} ${card.id}`.toLowerCase().includes(search.value.toLowerCase()))
}))
const visible = computed(() => filtered.value.slice(0, visibleLimit.value))
const current = computed(() => installed.value.find(p => p.manifest.id === details.value?.id))
const selectedManifest = computed(() => { const manifest = preview.value?.manifest ?? current.value?.manifest ?? details.value?.manifest; return manifest ? localizedManifest(manifest) : undefined })
const selectedRuntime = computed(() => current.value?.runtime ?? state.value?.builtins.find(p => p.id === details.value?.id)?.runtime)
const selectedIcon = computed(() => preview.value?.iconDataUrl ?? details.value?.iconDataUrl)
const selectedReadme = computed(() => preview.value?.readme ?? details.value?.readme ?? '')
const canWrite = computed(() => connectionState.value === 'ready' && !busy.value)
const previewStale = computed(() => !!preview.value && preview.value.registryRevision !== state.value?.revision)
const changeLabels = { get install() { return i18nT('m1d50c750fc47') }, get current() { return i18nT('m48794ae77e97') }, get upgrade() { return i18nT('mbc975d6b0733') }, get rebuild() { return i18nT('m5096d3d5dc44') }, get downgrade() { return i18nT('m0fdee8d7c0af') } }
function status(card: Card) {
  const pending = state.value?.pending.find(p => p.id === card.id)
  if(pending)return pending.kind==='restart'?i18nT('m4ae418c95643'):pending.kind==='waiting'?i18nT('mbbd6faa39ade'):i18nT('mc552117c20f1')
  if (card.manifest?.theme && card.publisher === 'builtin') return i18nT('m79144fb50781')
  if (card.publisher === 'builtin') return card.manifest?.capabilities.some(cap => state.value?.providers[cap.id]) ? i18nT('mbae1f8f8bf68') : i18nT('mdaa0be513325')
  const plugin = installed.value.find(p => p.manifest.id === card.id)
  if (!plugin) return i18nT('mcb5fd27c41e9')
  if (card.manifest?.theme) return i18nT('m3a81d6463403')
  if (plugin.error || plugin.reasons.length) return i18nT('m460b3574e4bd')
  return plugin.enabled ? plugin.running ? i18nT('mdfb802238b38') : i18nT('m63c1fe8533a0') : i18nT('mf95ea7f4c063')
}
function resultNotice(id?: string) {
  const pending=state.value?.pending.find(p=>p.id===id)
  return pending ? `${pending.kind==='restart'?i18nT('m4ae418c95643'):pending.kind==='waiting'?i18nT('mbbd6faa39ade'):i18nT('mc552117c20f1')}：${pending.reason}` : i18nT('m64351c5cf3fb')
}
async function refreshState() { state.value = await rpc<PluginState>('plugins.state'); pluginState.value = state.value }
async function refreshMarket(refresh = false) {
  loadingMarket.value = true
  try { market.value = await rpc<PluginMarket>('plugins.market', { refresh }, false, 150_000) }
  catch (cause) { error.value = (cause as Error).message }
  finally { loadingMarket.value = false }
}
async function metadataFor(card: Card, refresh = false) {
  if (card.bundled || !card.repository || (!refresh && (metadata.value[card.repository] || failedMetadata.has(card.repository)))) return
  try {
    const data = await rpc<PluginDetails>('plugins.details', { repository: card.repository, ref: card.ref ?? 'HEAD', refresh }, false, 150_000)
    if (data.manifest.id !== card.id) throw new Error(i18nT('me64480423399'))
    metadata.value[card.repository] = data
  } catch (cause) { failedMetadata.add(card.repository); if (details.value?.id === card.id) error.value = (cause as Error).message }
}
// Only visible cards are hydrated, two repositories at a time. Backend metadata persists across restarts.
async function hydrate() {
  const version = ++metadataVersion, queue = visible.value.filter(c => c.repository && !metadata.value[c.repository] && !failedMetadata.has(c.repository))
  await Promise.all([0, 1].map(async () => { while (!disposed && version === metadataVersion && queue.length) await metadataFor(queue.shift()!) }))
}
watch(() => [tab.value, search.value, category.value, source.value, compatibleOnly.value], () => { visibleLimit.value = 48 })
watch(() => [tab.value, search.value, category.value, source.value, compatibleOnly.value, visibleLimit.value, market.value?.fetchedAt, state.value?.revision], () => { void hydrate() })
async function open(card: Card) {
  error.value = ''; notice.value = ''; preview.value = undefined; accepted.value = false; uninstallId.value = ''; details.value = card; config.value = { ...(installed.value.find(p => p.manifest.id === card.id)?.config ?? {}) }
  detailDialog.value?.showModal()
  if (!card.manifest && card.repository) { detailLoading.value = true; await metadataFor(card); details.value = cards.value.find(c => c.id === card.id) ?? card; detailLoading.value = false }
}
function close() { if (busy.value) return; detailDialog.value?.close(); preview.value = undefined; accepted.value = false; error.value = ''; details.value = undefined }
async function job<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { jobId } = await rpc<{ jobId: string }>(method, params, true)
  while (!disposed) {
    const result = await rpc<{ state: string; message: string; result?: T; error?: string }>('plugins.job', { jobId })
    busy.value = result.message
    if (result.state === 'succeeded') return result.result as T
    if (result.state === 'failed') throw new Error(result.error)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(i18nT('m02719be37005'))
}
async function prepare(url = repository.value, refName = gitRef.value, expectedId?: string) {
  if (!canWrite.value) return
  busy.value = i18nT('mbcbe73357845'); error.value = ''; accepted.value = false; preview.value = undefined
  try {
    await refreshState()
    const value = await job<PluginPreview>('plugins.prepare', { repository: url, ref: refName || 'HEAD', ...(expectedId ? { expectedId } : {}) })
    preview.value = value
    details.value = { ...value.manifest, publisher: cards.value.find(c => c.id === value.manifest.id)?.publisher ?? 'community', repository: value.repository, ref: value.ref, manifest: value.manifest, readme: value.readme, iconDataUrl: value.iconDataUrl }
    if (!detailDialog.value?.open) detailDialog.value?.showModal()
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
async function install() {
  if (!preview.value || !accepted.value || !canWrite.value || previewStale.value) return
  busy.value = i18nT('mfc08f57a54c0'); error.value = ''
  try {
    state.value = await job<PluginState>('plugins.install', { token: preview.value.token, commit: preview.value.commit, acceptRisk: true, expectedRevision: preview.value.registryRevision })
    pluginState.value = state.value; await loadPlugins(); const isTheme = !!preview.value?.manifest.theme, id = preview.value?.manifest.id; preview.value = undefined; accepted.value = false; notice.value = isTheme ? i18nT('m551040030236') : state.value.installed.find(p=>p.manifest.id===id)?.enabled ? i18nT('m1d53fec8eb98') + resultNotice(id) + i18nT('mb855b73c74a3') : i18nT('m07102c8f1e5c'); tab.value = 'installed'
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
async function change(id: string, action: string) {
  if (!canWrite.value) return
  if (action === 'uninstall' && pluginTabs.some(tab => tab.key === `plugin-settings:${id}`) && !await closePluginTab(`plugin-settings:${id}`)) return
  busy.value = i18nT('mabf77612145b'); error.value = ''; notice.value = ''
  try {
    if (action === 'select' && selectedManifest.value?.theme) { await refreshThemes(); applyMarketTheme(id==='builtin.appearance'?id:'plugin:'+id); notice.value=i18nT('m9a7cecfce8a8'); return }
    const isTheme = !!selectedManifest.value?.theme
    state.value = await rpc<PluginState>('plugins.change', { id, action, expectedRevision: state.value!.revision, ...(action === 'configure' ? { config: config.value } : {}) }, true)
    pluginState.value = state.value; await loadPlugins()
    if (action === 'restore-bundled') tab.value = 'installed'
    notice.value = action === 'uninstall' ? i18nT('m58b0f2a803cc') + resultNotice(id) : isTheme ? i18nT('me398bc16dc4a') : resultNotice(id); uninstallId.value = ''
  }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
onMounted(async () => { try { await refreshState() } catch (cause) { error.value = (cause as Error).message } })
watch(tab, value => { if (value === 'market' && !market.value && !loadingMarket.value) void refreshMarket() })
onBeforeUnmount(() => { disposed = true; metadataVersion++ })
</script>

<template>
  <section class="plugin-center" :aria-label="i18nT('mb1e1262a1205')">
    <header class="plugin-hero"><img src="/brand/littledock-otter.png" alt="" class="plugin-market-logo" /><div><span class="plugin-eyebrow">LITTLEDOCK · EXTENSIONS</span><h1>{{ tab === 'installed' ? i18nT('m7e58a7fa3def') : i18nT('m810e3924c3ab') }}</h1><p>{{ i18nT('m83de121e6daa') }}</p></div><button class="button primary" :aria-expanded="gitOpen" @click="gitOpen = !gitOpen"><PhGitBranch :size="18" />{{ i18nT('m4eb33f143984') }}</button></header>
    <p v-for="pending in state?.pending ?? []" :key="pending.id" class="plugin-notice" role="status"><strong>{{ pending.kind==='restart'?i18nT('m4ae418c95643'):pending.kind==='waiting'?i18nT('mbbd6faa39ade'):i18nT('mc552117c20f1') }} · {{ state?.installed.find(p=>p.manifest.id===pending.id)?.manifest.name ?? pending.id }}</strong><br />{{ pending.reason }}<span v-if="pending.kind==='restart'">{{ i18nT('mcf71f81513ec') }}</span></p>
    <p v-for="message in state?.bundledErrors ?? []" :key="message" class="plugin-notice">{{ message }}</p>
    <p v-if="state?.safeMode" class="plugin-notice">{{ i18nT('ma1dbcb6e87ad') }}</p>
    <p v-for="message in pluginLoadErrors" :key="message" class="form-error">{{ message }}</p>
    <form v-if="gitOpen" class="plugin-git" @submit.prevent="prepare()"><label class="form-field"><span>{{ i18nT('m02c0c245fb8e') }}</span><input v-model="repository" required type="url" :placeholder="i18nT('md458d3eed80d')" /></label><label class="form-field"><span>{{ i18nT('m0fa9920a5b5f') }}</span><input v-model="gitRef" placeholder="HEAD" /></label><button class="button" :disabled="!canWrite">{{ i18nT('m7f1b2bd011d4') }}</button></form>
    <div class="plugin-toolbar"><div class="segmented"><button :class="{active:tab==='market'}" @click="tab='market'">{{ i18nT('mc28fc3f4689d') }}</button><button :class="{active:tab==='installed'}" @click="tab='installed'">{{ i18nT('ma8b6c39dcabf') }}<small>{{ installed.length + (state?.builtins.length ?? 0) }}</small></button></div><span class="plugin-spacer"></span><button class="icon-button" :aria-label="i18nT('mc01d3f2887f7')" :title="i18nT('mf3ce46fbdceb')" :disabled="loadingMarket" @click="refreshMarket(true)"><PhArrowClockwise :size="20" :class="{spinning:loadingMarket}" /></button></div>
    <div class="plugin-filters"><label class="plugin-search"><PhMagnifyingGlass :size="18" /><input v-model="search" :aria-label="i18nT('m44891fe35f04')" :placeholder="i18nT('m61a6dbc0d5ab')" /></label><select v-model="category" :aria-label="i18nT('m0e280a6bf437')"><option value="">{{ i18nT('ma1054434857f') }}</option><option v-for="(label,id) in pluginCategories" :key="id" :value="id">{{ label }}</option></select><select v-model="source" :aria-label="i18nT('m39c12f146533')"><option value="">{{ i18nT('m9f357adb6100') }}</option><option value="builtin">{{ i18nT('me8526b0d97fb') }}</option><option value="official">{{ i18nT('m8306ae9f03c7') }}</option><option value="community">{{ i18nT('m376cbd8cfc85') }}</option></select><label v-if="tab === 'market'" class="check-label"><input v-model="compatibleOnly" type="checkbox" />{{ i18nT('m4cfeba0c990f') }}</label></div>
    <div class="plugin-source"><span>{{ state ? `${platformName(state.host.os)} / ${state.host.arch}` : i18nT('m266a323a961d') }}<span v-if="market">{{ i18nT('m3c684427bbdb', { p0: (market.cached ? i18nT('me3ca04a9cb13') : i18nT('m3055a035f0eb')), p1: (timestamp(market.fetchedAt)) }) }}</span></span><a href="https://gitee.com/axisxy/webnavpluginsmarket" target="_blank" rel="noopener noreferrer">{{ i18nT('mb31759760dab') }}<PhArrowSquareOut :size="13" /></a></div>
    <p v-if="market?.error" class="plugin-notice">{{ market.error }}</p><p v-if="busy" class="plugin-notice" role="status">{{ busy }}</p><p v-if="error && !details" role="alert" class="form-error">{{ error }}</p>
    <div class="plugin-grid"><article v-for="card in visible" :key="card.id" class="plugin-card">
      <header class="plugin-card-heading"><img v-if="card.iconDataUrl" :src="card.iconDataUrl" alt="" /><PhPuzzlePiece v-else :size="28" /><div><h2>{{ card.name }}</h2><span>{{ card.bundled ? i18nT('mad37a7de374c') : card.publisher === 'builtin' ? i18nT('m95e35aabd9a9') : card.publisher === 'official' ? i18nT('m8306ae9f03c7') : i18nT('m376cbd8cfc85') }} · {{ card.manifest?.version ?? i18nT('m9b28f62eacdf') }}</span></div></header>
      <div class="plugin-card-body"><p>{{ card.description }}</p><span class="plugin-run-state">{{ status(card) }}</span><footer><button v-if="card.bundled && !installedFor(card)" class="button primary" :disabled="!canWrite" @click="change(card.id, 'restore-bundled')">{{ i18nT('m54c8408ea343') }}</button><button class="icon-button" :aria-label="i18nT('pluginCard.details', { name: card.name })" :title="i18nT('pluginCard.details', { name: card.name })" @click="open(card)"><PhInfo :size="20" /></button><button v-if="toolFor(card)" class="button primary" @click="launch(card)">{{ i18nT('mc771248e511f') }}</button><button v-if="hasSettings(card) && (card.publisher === 'builtin' || installed.some(p => p.manifest.id === card.id))" class="icon-button" :aria-label="i18nT('pluginCard.settings', { name: card.name })" :title="i18nT('pluginCard.settings', { name: card.name })" @click="settings(card)"><PhGearSix :size="20" /></button><button v-if="installedFor(card) && !card.manifest?.theme" class="icon-button" :disabled="!canWrite" :aria-label="(installedFor(card)?.enabled ? i18nT('md4bc3529f56f') : i18nT('m99d63ea41429')) + card.name" :title="installedFor(card)?.enabled ? i18nT('m079b5363199b') : i18nT('m6ee356116241')" @click="change(card.id, installedFor(card)?.enabled ? 'disable' : 'enable')"><PhPower :size="18" /></button><button v-if="installedFor(card)" class="icon-button" :disabled="!canWrite" :aria-label="i18nT('mf2d2f0ff36de') + card.name" :title="i18nT('m8159886199ad')" @click="askUninstall(card)"><PhTrash :size="18" /></button></footer></div>
    </article></div>
    <p v-if="!visible.length" class="plugin-empty">{{ state ? i18nT('m11bb004c3db8') : i18nT('mfb76ec7c9c31') }}</p>
    <p v-if="visible.length < filtered.length"><button class="button" @click="visibleLimit += 48">{{ i18nT('m8673fd6169e0', { p0: (visible.length), p1: (filtered.length) }) }}</button></p>
    <p class="plugin-footnote">{{ i18nT('m91668aad4206') }}</p>

    <dialog ref="detailDialog" class="plugin-detail-dialog" aria-labelledby="plugin-detail-title" @cancel.prevent="close"><div class="plugin-detail">
      <header><img v-if="selectedIcon" :src="selectedIcon" alt="" /><div><span class="plugin-badge" :class="details?.publisher">{{ details?.bundled?i18nT('mad37a7de374c'):details?.publisher==='builtin'?i18nT('m37e216a416b2'):details?.publisher==='official'?i18nT('me73e38c1f65d'):i18nT('m376cbd8cfc85') }}</span><h2 id="plugin-detail-title">{{ selectedManifest?.name ?? details?.name }}</h2><p>{{ selectedManifest?.author }} <span v-if="selectedManifest">· v{{ selectedManifest.version }}</span></p></div><button class="icon-button" :aria-label="i18nT('m30c12e9980c0')" :disabled="!!busy" @click="close"><PhX :size="22" /></button></header>
      <p v-if="detailLoading">{{ i18nT('m0a577d719b81') }}</p><p>{{ selectedManifest?.description ?? details?.description }}</p>
      <p v-if="selectedRuntime" class="plugin-notice"><strong>{{ i18nT('m5ce89ff191a4') }}</strong>{{ selectedRuntime.backend === 'dedicated' ? i18nT('m3fb174f7ca90') : i18nT('mdfb8387ca7b9') }}。{{ selectedRuntime.backend === 'dedicated' ? i18nT('mb66d50af1d6c') : i18nT('ma2f8cb68077f') }}</p>
      <p v-if="current" class="plugin-notice plugin-commit">{{ i18nT('m1688a1547e77', { p0: (current.manifest.version), p1: (current.commit.slice(0, 12)) }) }}<br /><template v-if="current.activeRelease">{{ i18nT('m17736b884d3b', { p0: (current.activeRelease.version), p1: (current.activeRelease.commit.slice(0, 12)) }) }}</template><template v-else>{{ current.manifest.theme ? i18nT('m72cb74a14840') : i18nT('m93fdb07ec2ae') }}</template></p>
      <p v-if="selectedManifest" class="plugin-notice"><strong>{{ i18nT('mb085ca651678') }}</strong>{{ selectedManifest.theme ? i18nT('m0574276a8a47') : selectedManifest.reload === 'restart' ? i18nT('mcbb3aa6daa16') + (selectedManifest.reloadReason ?? i18nT('ma6f4f10c4966')) : i18nT('m2625065e31ca') }}</p>
      <section v-if="selectedManifest" class="plugin-risk"><h3>{{ i18nT('m809d89459633') }}</h3><p>{{ selectedManifest.automation?.description ?? i18nT('m78d2ce7665f2') }}</p><p v-if="selectedManifest.automation">{{ selectedManifest.automation.tools.length ? selectedManifest.automation.tools.map(t=>t.title).join('、') : i18nT('m5e500b5af885') }}</p></section><dl v-if="selectedManifest" class="plugin-facts"><div><dt>{{ i18nT('m3e31822c57ab') }}</dt><dd>{{ platformsText(selectedManifest.platforms) }}</dd></div><div><dt>{{ i18nT('m515559957fd3') }}</dt><dd>{{ categoriesText(selectedManifest) }}</dd></div><div><dt>{{ i18nT('m19a040d1d8ea') }}</dt><dd>{{ selectedManifest.capabilities.map(c=>capabilityName(c.id)).join('、') }}</dd></div><div><dt>{{ i18nT('m6cb4b77b817b') }}</dt><dd>LittleDock {{ selectedManifest.webnav }} · Node {{ selectedManifest.node }}<span v-if="selectedManifest.commands?.length"> · {{ selectedManifest.commands.join('、') }}</span></dd></div><div v-if="selectedManifest.dependencies && Object.keys(selectedManifest.dependencies).length"><dt>{{ i18nT('m15ce9a546132') }}</dt><dd>{{ Object.entries(selectedManifest.dependencies).map(([id,range])=>`${id} ${range}`).join('、') }}</dd></div><div><dt>{{ i18nT('m1b2ad79bbbda') }}</dt><dd>{{ selectedManifest.license }}</dd></div><div v-if="details?.repository"><dt>{{ i18nT('m908a5a92dc38') }}</dt><dd><a :href="details.repository" target="_blank" rel="noopener noreferrer">{{ details.repository }}</a></dd></div></dl>
      <template v-if="details?.repository"><p class="plugin-cache-note">{{ i18nT('m37465d251f06', { p0: (timestamp(metadata[details.repository]?.fetchedAt ?? null)) }) }}<button class="button" :disabled="!!busy || detailLoading" @click="detailLoading=true; metadataFor(details,true).then(()=>{details=cards.find(c=>c.id===details?.id);detailLoading=false})"><PhArrowClockwise :size="14" />{{ i18nT('mfb57dff20662') }}</button></p></template>
      <details class="plugin-readme" :open="!preview"><summary>{{ i18nT('m754bb4d862c8') }}</summary><pre>{{ selectedReadme || i18nT('mb8fbc67a3290') }}</pre></details>
      <div v-if="selectedManifest?.screenshots?.length" class="plugin-screenshots"><a v-for="url in selectedManifest.screenshots" :key="url" :href="url" target="_blank" rel="noopener noreferrer">{{ i18nT('mcbee431ac1d2') }}<PhArrowSquareOut :size="13" /></a></div>
      <p v-if="current?.error" class="form-error">{{ current.error }}</p><p v-for="reason in current?.reasons ?? []" :key="reason" class="form-error">{{ reason }}</p>
      <div v-if="details" class="plugin-detail-actions"><button v-if="toolFor(details)" class="button primary" @click="launch(details)">{{ i18nT('m0101bc1c6e1e') }}</button><button v-if="hasSettings(details) && (current || details.publisher === 'builtin')" class="button" @click="settings(details)"><PhGearSix :size="18" />{{ i18nT('mb1bc554af446') }}</button></div>
      <section v-if="preview" class="plugin-install-review">
        <h3>{{ preview.change === 'current' ? i18nT('m8b3cfc40563f') : pluginRisk.title }}</h3>
        <p class="plugin-commit">{{ preview.repository }}<br />{{ changeLabels[preview.change] }}<template v-if="preview.installedRelease"><br />{{ i18nT('m1688a1547e77', { p0: (preview.installedRelease.version), p1: (preview.installedRelease.commit) }) }}</template><br />{{ i18nT('m5e017652d963', { p0: (preview.manifest.version), p1: (preview.commit) }) }}</p>
        <p v-for="reason in preview.reasons" :key="reason" class="form-error">{{ reason }}</p>
        <p v-if="previewStale" class="form-error" role="alert">{{ i18nT('mea30b01d1c7a') }}</p>
        <template v-if="preview.change !== 'current'">
          <ul v-if="preview.changes.length"><li v-for="change in preview.changes" :key="change">{{ change }}</li></ul>
          <p>{{ pluginRisk.body }}</p><p>{{ pluginRisk.index }}</p><strong class="plugin-ai-advice">{{ pluginRisk.ai }}</strong><p>{{ pluginRisk.privacy }}</p>
          <details v-if="preview.manifest.install?.length"><summary>{{ i18nT('mbd3ae5b7d32e') }}</summary><pre>{{ preview.manifest.install.map(s=>`${s.command} ${s.args.join(' ')}`).join('\n') }}</pre></details>
          <label class="check-label"><input v-model="accepted" type="checkbox" :disabled="previewStale || !preview.compatible || !!busy" />{{ pluginRisk.consent }}</label>
        </template>
        <div class="plugin-detail-actions">
          <button class="button" :disabled="!!busy" @click="preview=undefined;accepted=false">{{ preview.change === 'current' ? i18nT('m6f804505c90f') : i18nT('m191a09e32e31') }}</button>
          <button v-if="previewStale" class="button" :disabled="!canWrite" @click="prepare(preview.repository,preview.ref,preview.manifest.id)">{{ i18nT('m057930f57805') }}</button>
          <button v-else-if="preview.change !== 'current'" class="button primary" :disabled="!canWrite || !accepted || !preview.compatible" @click="install"><PhDownloadSimple :size="17" />{{ i18nT('m9a5d6d3a4b81', { p0: (preview.change === 'downgrade' ? i18nT('me20facfd31c0') : preview.upgrading ? i18nT('m3055a035f0eb') : i18nT('me8f88f51ccb0')) }) }}</button>
        </div>
      </section>
      <div v-else class="plugin-detail-actions"><template v-if="details?.bundled"><button v-if="!current" class="button primary" :disabled="!canWrite" @click="change(details.id, 'restore-bundled')">{{ i18nT('m54c8408ea343') }}</button><template v-else><button class="button" :disabled="!canWrite" @click="change(current.manifest.id,current.enabled?'disable':'enable')">{{ current.enabled?i18nT('m7df5c456c765'):i18nT('mf4f0ead1116b') }}</button><button class="button" :disabled="!canWrite" @click="uninstallId=current.manifest.id">{{ i18nT('m06bc14b60f35') }}</button></template><small>{{ i18nT('m33e3c859dbf4') }}</small></template><template v-else-if="details?.publisher==='builtin'"><button class="button primary" :disabled="!canWrite" @click="change(details.id,'select')"><PhCheckCircle :size="17" />{{ i18nT('m59fb8dbd28b7') }}</button><small>{{ i18nT('m3a5b241a37cb') }}</small></template><template v-else-if="details"><button v-if="!current" class="button primary" :disabled="!canWrite" @click="prepare(details.repository!,details.ref??'HEAD',details.id)">{{ i18nT('m7f1b2bd011d4') }}</button><template v-else><button class="button primary" :disabled="!canWrite" @click="change(current.manifest.id,'select')">{{ selectedManifest?.theme?i18nT('m0e61f173997c'):i18nT('m683dffe62e1c') }}</button><button v-if="!selectedManifest?.theme" class="button" :disabled="!canWrite" @click="change(current.manifest.id,current.enabled?'disable':'enable')">{{ current.enabled?i18nT('m7df5c456c765'):i18nT('mf4f0ead1116b') }}</button><button class="button" :disabled="!canWrite" @click="prepare(current.repository,current.ref,current.manifest.id)">{{ i18nT('m7f68ebad19ba') }}</button><button v-if="current.previousCommit" class="button" :disabled="!canWrite" @click="change(current.manifest.id,'rollback')">{{ i18nT('me700bc424c4a') }}</button><button class="button" :disabled="!canWrite" @click="uninstallId=current.manifest.id">{{ i18nT('m06bc14b60f35') }}</button></template></template></div>
      <div v-if="uninstallId" class="plugin-notice"><p>{{ i18nT('m8de0c7ac6c96') }}</p><button class="button" :disabled="!canWrite" @click="uninstallId=''">{{ i18nT('m2cd0f3be8738') }}</button> <button class="button" :disabled="!canWrite" @click="change(uninstallId,'uninstall')">{{ i18nT('m4fec200ac3f7') }}</button></div>
      <p v-if="busy" role="status" class="plugin-notice">{{ busy }}</p><p v-if="notice" role="status" class="plugin-notice">{{ notice }}</p><p v-if="error" role="alert" class="form-error">{{ error }}</p>
    </div></dialog>
  </section>
</template>

<style scoped>
.plugin-install-review li{font-size:var(--font-caption);line-height:1.9;overflow-wrap:anywhere}
.plugin-center{max-width:1280px;margin:auto;--plugin-warning:light-dark(#8a5017,#f6c383)}.plugin-hero{display:flex;align-items:center;gap:22px;padding:16px 0 30px;border-bottom:1px solid var(--border)}.plugin-market-logo{width:76px;height:76px;object-fit:contain}.plugin-eyebrow{font-size:var(--font-caption);letter-spacing:.16em;color:var(--muted)}.plugin-hero h1{font-size:var(--font-heading);font-weight:650;letter-spacing:-.04em;margin:5px 0 8px}.plugin-hero p{color:var(--muted);margin:0}.plugin-hero>.button{margin-left:auto;white-space:nowrap}.plugin-toolbar{display:flex;gap:14px;align-items:center;padding:24px 0 16px}.plugin-spacer{flex:1}.plugin-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.plugin-search{display:flex;align-items:center;gap:9px;flex:1;min-width:190px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0 12px}.plugin-search input{border:0;background:transparent;outline:none;width:100%;padding:10px 0}.plugin-filters select{padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;max-width:100%}.plugin-filters .check-label{font-size:var(--font-caption);white-space:nowrap}.plugin-source{display:flex;justify-content:space-between;gap:12px;font-size:var(--font-caption);color:var(--muted);margin:15px 0 22px;flex-wrap:wrap}.plugin-source a,.plugin-screenshots a{display:inline-flex;align-items:center;gap:5px}.plugin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,258px),1fr));gap:15px}.plugin-card{text-align:left;border:1px solid var(--border);background:var(--surface);padding:22px;border-radius:14px;color:var(--ink);cursor:pointer;display:flex;flex-direction:column;transition:border-color .15s,transform .15s;min-height:224px}.plugin-card:hover{border-color:var(--accent);transform:translateY(-2px)}.plugin-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.plugin-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.plugin-card-top img,.plugin-icon-placeholder{width:48px;height:48px;flex-shrink:0;object-fit:contain;border-radius:12px}.plugin-icon-placeholder{display:grid;place-items:center;background:var(--surface-soft);color:var(--muted)}.plugin-badge{font-size:var(--font-caption);display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);border-radius:5px;padding:3px 6px;color:var(--muted);white-space:nowrap}.plugin-badge.builtin,.plugin-badge.official{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 25%,var(--border));background:color-mix(in srgb,var(--accent) 7%,var(--surface))}.plugin-card h2{font-size:var(--font-body);font-weight:650;margin:16px 0 8px}.plugin-card p{font-size:var(--font-caption);color:var(--muted);line-height:1.7;margin:0 0 20px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.plugin-card footer{margin-top:auto;display:flex;justify-content:space-between;gap:10px;font-size:var(--font-caption);color:var(--muted)}.plugin-card footer>span:last-child{color:var(--ink)}.plugin-footnote{font-size:var(--font-caption);color:var(--muted);margin:26px 0;max-width:800px;line-height:1.8}.plugin-empty{padding:60px 20px;text-align:center;color:var(--muted)}.plugin-notice{background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:var(--font-caption);line-height:1.8;white-space:pre-line}.plugin-git{display:grid;grid-template-columns:minmax(150px,1fr) 160px auto;align-items:end;gap:12px;padding:20px;border:1px solid var(--border);border-radius:12px;margin-top:20px;background:var(--surface)}.plugin-git .form-field{margin:0}.plugin-detail-dialog{width:min(740px,calc(100vw - 28px));max-width:none;max-height:calc(100dvh - 28px);padding:0;border:1px solid var(--border);border-radius:18px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}.plugin-detail-dialog::backdrop{background:#0c181c70;backdrop-filter:blur(3px)}.plugin-detail{padding:28px}.plugin-detail>header{display:flex;align-items:center;gap:17px;margin-bottom:24px}.plugin-detail>header img{width:64px;height:64px;object-fit:contain;border-radius:15px}.plugin-detail h2{margin:6px 0 3px;font-size:var(--font-heading)}.plugin-detail>header p{margin:0;font-size:var(--font-caption);color:var(--muted)}.plugin-detail>header>.icon-button{margin-left:auto;align-self:flex-start}.plugin-detail>p{font-size:var(--font-caption);line-height:1.8}.plugin-facts{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:15px 0;margin:20px 0}.plugin-facts>div{display:grid;grid-template-columns:120px 1fr;gap:14px;margin:8px 0;font-size:var(--font-caption)}.plugin-facts dt{color:var(--muted)}.plugin-facts dd{margin:0;overflow-wrap:anywhere}.plugin-facts a{text-decoration:underline}.plugin-cache-note{display:flex;justify-content:space-between;gap:8px;align-items:center;color:var(--muted)}.plugin-cache-note .button{font-size:var(--font-caption);padding:5px 8px}.plugin-readme summary{font-weight:600;cursor:pointer;font-size:var(--font-caption)}.plugin-readme pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--font-caption);line-height:1.9;color:var(--muted);padding:12px 0}.plugin-screenshots{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;font-size:var(--font-caption)}.plugin-detail-actions{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:24px}.plugin-detail-actions small{color:var(--muted)}.plugin-install-review{margin-top:24px;border:1px solid color-mix(in srgb,#d18c3a 55%,var(--border));background:color-mix(in srgb,#c18c4e 6%,var(--surface));border-radius:12px;padding:20px}.plugin-install-review h3{color:var(--plugin-warning);font-size:var(--font-body);margin:0 0 12px}.plugin-install-review p{font-size:var(--font-caption);line-height:1.9}.plugin-ai-advice{display:block;padding:14px;border-left:3px solid #c18c4e;background:color-mix(in srgb,#c18c4e 13%,var(--surface));font-size:var(--font-caption);line-height:1.8}.plugin-install-review .check-label{align-items:flex-start;font-size:var(--font-caption);line-height:1.8}.plugin-install-review input{margin-top:5px;flex-shrink:0}.plugin-commit{overflow-wrap:anywhere;color:var(--muted)}.plugin-config{margin-top:20px;padding:16px;border:1px solid var(--border);border-radius:10px}.plugin-config p{color:var(--muted);font-size:var(--font-caption)}.spinning{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:650px){.plugin-hero{flex-wrap:wrap;gap:14px}.plugin-market-logo{width:54px;height:54px}.plugin-hero>div{flex:1;min-width:180px}.plugin-hero>.button{margin-left:0}.plugin-git{grid-template-columns:1fr}.plugin-detail{padding:19px}.plugin-facts>div{grid-template-columns:1fr;gap:3px}.plugin-cache-note{flex-wrap:wrap}.plugin-install-review{padding:14px}.plugin-filters{gap:8px}.plugin-search{flex-basis:100%}.plugin-toolbar .segmented{font-size:var(--font-caption)}}
.plugin-card{padding:0;cursor:default;min-height:210px;overflow:hidden}.plugin-card:hover{transform:none}.plugin-card-heading{display:flex;align-items:center;gap:12px;padding:18px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.plugin-card-heading img{width:38px;height:38px;object-fit:contain}.plugin-card-heading h2{margin:0 0 6px}.plugin-card-heading span{font-size:var(--font-caption);color:var(--muted)}.plugin-card-body{display:flex;flex-direction:column;gap:14px;padding:18px;flex:1}.plugin-card-body p{margin:0}.plugin-card-body footer{justify-content:flex-start;align-items:center;flex-wrap:wrap;gap:6px}.plugin-card-body footer .icon-button{margin-left:0;width:32px;height:36px}.plugin-run-state{font-size:var(--font-caption);color:var(--accent)}
</style>
