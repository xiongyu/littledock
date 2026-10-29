<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { PhArrowClockwise, PhArrowSquareOut, PhCheckCircle, PhDownloadSimple, PhGitBranch, PhGearSix, PhInfo, PhPower, PhTrash, PhMagnifyingGlass, PhPuzzlePiece, PhShieldCheck, PhX } from '@phosphor-icons/vue'
import { pluginCategories, pluginRisk, serviceCapabilities, type PluginCategory, type PluginManifest, type PluginMarket, type PluginState, type PluginDetails, type PluginPreview } from '@webnav/shared'
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
const timestamp = (value: number | null) => value ? new Date(value).toLocaleString('zh-CN') : '尚未读取'
const platformName = (os: string) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[os] ?? os)
const platformsText = (platforms: PluginManifest['platforms']) => platforms.map(p => `${platformName(p.os)} ${p.arch}`).join(' · ')
const categoriesText = (manifest: PluginManifest) => [manifest.category, ...manifest.secondaryCategories].map(c => pluginCategories[c]).join(' / ')
const capabilityName = (id: string) => id === 'theme:appearance' ? '界面主题' : id.startsWith('service:') ? serviceCapabilities[id.slice(8) as keyof typeof serviceCapabilities] ?? id : id.startsWith('connector:') ? `${id.slice(10)} 连接器` : id.slice(10)
const installed = computed(() => state.value?.installed ?? [])
const cards = computed<Card[]>(() => {
  const builtin = (state.value?.builtins ?? []).map(p => ({ ...p.manifest, id: p.id, publisher: 'builtin' as const, iconDataUrl: p.iconDataUrl, manifest: p.manifest, readme: p.readme }))
  const bundled = (state.value?.bundled ?? []).filter(p => !installed.value.some(item => item.manifest.id === p.manifest.id && item.source !== 'bundled')).map(p => ({ ...p.manifest, publisher: 'official' as const, bundled: true, manifest: p.manifest, iconDataUrl: p.iconDataUrl, readme: p.readme }))
  const remotes = (market.value?.index.plugins ?? []).filter(p => !bundled.some(local => local.id === p.id)).map(entry => ({ ...entry, ...(metadata.value[entry.repository] ? { ...metadata.value[entry.repository]!.manifest, manifest: metadata.value[entry.repository]!.manifest, iconDataUrl: metadata.value[entry.repository]!.iconDataUrl, readme: metadata.value[entry.repository]!.readme } : {}) }))
  const extras = installed.value.filter(p => !remotes.some(r => r.id === p.manifest.id) && !bundled.some(r => r.id === p.manifest.id)).map(p => ({ ...p.manifest, ...(p.source === 'bundled' ? { bundled: true } : { repository: p.repository, ref: p.ref }), publisher: p.source === 'bundled' ? 'official' as const : 'community' as const, manifest: p.manifest, iconDataUrl: metadata.value[p.repository]?.iconDataUrl }))
  return tab.value === 'installed' ? [...bundled.filter(card => installed.value.some(p => p.manifest.id === card.id)), ...extras, ...remotes.filter(card => installed.value.some(p => p.manifest.id === card.id)), ...builtin] : [...bundled, ...builtin, ...remotes, ...extras]
})
const isCompatible = (card: Card) => !state.value || card.platforms.some(p => p.os === state.value!.host.os && p.arch === state.value!.host.arch)
const filtered = computed(() => cards.value.filter(card => {
  if (tab.value === 'installed' && card.publisher !== 'builtin' && !installed.value.some(p => p.manifest.id === card.id)) return false
  return (!category.value || card.category === category.value || card.secondaryCategories.includes(category.value as PluginCategory)) && (!source.value || card.publisher === source.value || (source.value === 'builtin' && card.bundled)) && (tab.value === 'installed' || !compatibleOnly.value || isCompatible(card)) && (!search.value || `${card.name} ${card.description} ${card.id}`.toLowerCase().includes(search.value.toLowerCase()))
}))
const visible = computed(() => filtered.value.slice(0, visibleLimit.value))
const current = computed(() => installed.value.find(p => p.manifest.id === details.value?.id))
const selectedManifest = computed(() => preview.value?.manifest ?? current.value?.manifest ?? details.value?.manifest)
const selectedRuntime = computed(() => current.value?.runtime ?? state.value?.builtins.find(p => p.id === details.value?.id)?.runtime)
const selectedIcon = computed(() => preview.value?.iconDataUrl ?? details.value?.iconDataUrl)
const selectedReadme = computed(() => preview.value?.readme ?? details.value?.readme ?? '')
const canWrite = computed(() => connectionState.value === 'ready' && !busy.value)
const previewStale = computed(() => !!preview.value && preview.value.registryRevision !== state.value?.revision)
const changeLabels = { install: '安装新插件', current: '已安装此提交', upgrade: '升级版本', rebuild: '版本号相同，代码提交有变化', downgrade: '目标版本较旧，将回退安装' }
function status(card: Card) {
  const pending = state.value?.pending.find(p => p.id === card.id)
  if(pending)return pending.kind==='restart'?'待重启':pending.kind==='waiting'?'等待使用结束':'更新未生效'
  if (card.manifest?.theme && card.publisher === 'builtin') return '内置主题'
  if (card.publisher === 'builtin') return card.manifest?.capabilities.some(cap => state.value?.providers[cap.id]) ? '备用实现' : '随宿主运行'
  const plugin = installed.value.find(p => p.manifest.id === card.id)
  if (!plugin) return '查看插件'
  if (card.manifest?.theme) return '主题已安装'
  if (plugin.error || plugin.reasons.length) return '不可用'
  return plugin.enabled ? plugin.running ? '已启用' : '尚未加载' : '未启用'
}
function resultNotice(id?: string) {
  const pending=state.value?.pending.find(p=>p.id===id)
  return pending ? `${pending.kind==='restart'?'待重启':pending.kind==='waiting'?'等待使用结束':'更新未生效'}：${pending.reason}` : '设置已生效，无需重启。'
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
    if (data.manifest.id !== card.id) throw new Error('仓库中的插件 ID 与索引不一致。')
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
  throw new Error('页面已关闭。操作可在插件中心重新核对。')
}
async function prepare(url = repository.value, refName = gitRef.value, expectedId?: string) {
  if (!canWrite.value) return
  busy.value = '正在读取安装说明…'; error.value = ''; accepted.value = false; preview.value = undefined
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
  busy.value = '正在安装…'; error.value = ''
  try {
    state.value = await job<PluginState>('plugins.install', { token: preview.value.token, commit: preview.value.commit, acceptRisk: true, expectedRevision: preview.value.registryRevision })
    pluginState.value = state.value; await loadPlugins(); const isTheme = !!preview.value?.manifest.theme, id = preview.value?.manifest.id; preview.value = undefined; accepted.value = false; notice.value = isTheme ? '主题已安装，可以立即应用；也能在右上角外观设置中选择。' : state.value.installed.find(p=>p.manifest.id===id)?.enabled ? '安装完成。' + resultNotice(id) + ' 替换内置功能请选择“设为默认实现”。' : '安装完成，请填写插件必需的配置后启用。'; tab.value = 'installed'
  } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
async function change(id: string, action: string) {
  if (!canWrite.value) return
  if (action === 'uninstall' && pluginTabs.some(tab => tab.key === `plugin-settings:${id}`) && !await closePluginTab(`plugin-settings:${id}`)) return
  busy.value = '正在保存插件设置…'; error.value = ''; notice.value = ''
  try {
    if (action === 'select' && selectedManifest.value?.theme) { await refreshThemes(); applyMarketTheme(id==='builtin.appearance'?id:'plugin:'+id); notice.value='主题已应用到当前浏览器，无需重启。可在右上角外观设置恢复默认。'; return }
    const isTheme = !!selectedManifest.value?.theme
    state.value = await rpc<PluginState>('plugins.change', { id, action, expectedRevision: state.value!.revision, ...(action === 'configure' ? { config: config.value } : {}) }, true)
    pluginState.value = state.value; await loadPlugins()
    if (action === 'restore-bundled') tab.value = 'installed'
    notice.value = action === 'uninstall' ? '卸载设置已保存，数据与仓库缓存保留。' + resultNotice(id) : isTheme ? '主题设置已保存，无需重启。重新应用后使用所选版本。' : resultNotice(id); uninstallId.value = ''
  }
  catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
onMounted(async () => { try { await refreshState() } catch (cause) { error.value = (cause as Error).message } })
watch(tab, value => { if (value === 'market' && !market.value && !loadingMarket.value) void refreshMarket() })
onBeforeUnmount(() => { disposed = true; metadataVersion++ })
</script>

<template>
  <section class="plugin-center" aria-label="插件中心">
    <header class="plugin-hero"><img src="/plugin-market-logo.png" alt="" class="plugin-market-logo" /><div><span class="plugin-eyebrow">WEBNAV · EXTENSIONS</span><h1>{{ tab === 'installed' ? '已安装的插件' : '发现新能力' }}</h1><p>查看运行状态，打开工具与设置。</p></div><button class="button primary" :aria-expanded="gitOpen" @click="gitOpen = !gitOpen"><PhGitBranch :size="18" />从 Git 安装</button></header>
    <p v-for="pending in state?.pending ?? []" :key="pending.id" class="plugin-notice" role="status"><strong>{{ pending.kind==='restart'?'待重启':pending.kind==='waiting'?'等待使用结束':'更新未生效' }} · {{ state?.installed.find(p=>p.manifest.id===pending.id)?.manifest.name ?? pending.id }}</strong><br />{{ pending.reason }}<span v-if="pending.kind==='restart'"> 可稍后从 WebNav 托盘重启，已有网页连接届时会断开。</span></p>
    <p v-for="message in state?.bundledErrors ?? []" :key="message" class="plugin-notice">{{ message }}</p>
    <p v-if="state?.safeMode" class="plugin-notice">当前处于恢复模式，第三方插件未加载。可在此修改默认实现和启用状态。</p>
    <p v-for="message in pluginLoadErrors" :key="message" class="form-error">{{ message }}</p>
    <form v-if="gitOpen" class="plugin-git" @submit.prevent="prepare()"><label class="form-field"><span>公开 Git 仓库地址</span><input v-model="repository" required type="url" placeholder="https://gitee.com/作者/插件.git" /></label><label class="form-field"><span>分支、标签或提交</span><input v-model="gitRef" placeholder="HEAD" /></label><button class="button" :disabled="!canWrite">读取安装说明</button></form>
    <div class="plugin-toolbar"><div class="segmented"><button :class="{active:tab==='market'}" @click="tab='market'">发现插件</button><button :class="{active:tab==='installed'}" @click="tab='installed'">已安装 <small>{{ installed.length + (state?.builtins.length ?? 0) }}</small></button></div><span class="plugin-spacer"></span><button class="icon-button" aria-label="刷新市场索引" title="刷新市场索引（保留插件详情缓存）" :disabled="loadingMarket" @click="refreshMarket(true)"><PhArrowClockwise :size="20" :class="{spinning:loadingMarket}" /></button></div>
    <div class="plugin-filters"><label class="plugin-search"><PhMagnifyingGlass :size="18" /><input v-model="search" aria-label="搜索插件" placeholder="搜索插件名称、能力或作者" /></label><select v-model="category" aria-label="插件分类"><option value="">全部分类</option><option v-for="(label,id) in pluginCategories" :key="id" :value="id">{{ label }}</option></select><select v-model="source" aria-label="插件来源"><option value="">全部来源</option><option value="builtin">内置 / 官方</option><option value="official">官方扩展</option><option value="community">第三方</option></select><label v-if="tab === 'market'" class="check-label"><input v-model="compatibleOnly" type="checkbox" />适合本机</label></div>
    <div class="plugin-source"><span>{{ state ? `${platformName(state.host.os)} / ${state.host.arch}` : '正在读取宿主平台…' }}<span v-if="market"> · 索引{{ market.cached ? '缓存' : '更新' }} {{ timestamp(market.fetchedAt) }}</span></span><a href="https://gitee.com/axisxy/webnavpluginsmarket" target="_blank" rel="noopener noreferrer">公开索引仓库 <PhArrowSquareOut :size="13" /></a></div>
    <p v-if="market?.error" class="plugin-notice">{{ market.error }}</p><p v-if="busy" class="plugin-notice" role="status">{{ busy }}</p><p v-if="error && !details" role="alert" class="form-error">{{ error }}</p>
    <div class="plugin-grid"><article v-for="card in visible" :key="card.id" class="plugin-card">
      <header class="plugin-card-heading"><img v-if="card.iconDataUrl" :src="card.iconDataUrl" alt="" /><PhPuzzlePiece v-else :size="28" /><div><h2>{{ card.name }}</h2><span>{{ card.bundled ? '官方 · 内置' : card.publisher === 'builtin' ? '内置' : card.publisher === 'official' ? '官方扩展' : '第三方' }} · {{ card.manifest?.version ?? '查看版本' }}</span></div></header>
      <div class="plugin-card-body"><p>{{ card.description }}</p><span class="plugin-run-state">{{ status(card) }}</span><footer><button v-if="card.bundled && !installedFor(card)" class="button primary" :disabled="!canWrite" @click="change(card.id, 'restore-bundled')">恢复安装</button><button class="icon-button" :aria-label="card.name + '详情'" :title="card.name + '详情'" @click="open(card)"><PhInfo :size="20" /></button><button v-if="toolFor(card)" class="button primary" @click="launch(card)">打开</button><button v-if="hasSettings(card) && (card.publisher === 'builtin' || installed.some(p => p.manifest.id === card.id))" class="icon-button" :aria-label="card.name + '设置'" :title="card.name + '设置'" @click="settings(card)"><PhGearSix :size="20" /></button><button v-if="installedFor(card) && !card.manifest?.theme" class="icon-button" :disabled="!canWrite" :aria-label="(installedFor(card)?.enabled ? '停用 ' : '启用 ') + card.name" :title="installedFor(card)?.enabled ? '停用插件' : '启用插件'" @click="change(card.id, installedFor(card)?.enabled ? 'disable' : 'enable')"><PhPower :size="18" /></button><button v-if="installedFor(card)" class="icon-button" :disabled="!canWrite" :aria-label="'卸载 ' + card.name" title="卸载插件，保留本地文件和配置" @click="askUninstall(card)"><PhTrash :size="18" /></button></footer></div>
    </article></div>
    <p v-if="!visible.length" class="plugin-empty">{{ state ? '没有符合筛选条件的插件。可以调整分类，或通过 Git 地址安装。' : '正在读取插件列表…' }}</p>
    <p v-if="visible.length < filtered.length"><button class="button" @click="visibleLimit += 48">显示更多（已显示 {{ visible.length }} / {{ filtered.length }}）</button></p>
    <p class="plugin-footnote">内置插件的图标与说明来自当前项目。其他插件详情首次从各自仓库读取并保存在本机；重新打开直接使用缓存，详情页可手动更新。来源标记不代表安全审核。</p>

    <dialog ref="detailDialog" class="plugin-detail-dialog" aria-labelledby="plugin-detail-title" @cancel.prevent="close"><div class="plugin-detail">
      <header><img v-if="selectedIcon" :src="selectedIcon" alt="" /><div><span class="plugin-badge" :class="details?.publisher">{{ details?.bundled?'官方 · 内置':details?.publisher==='builtin'?'内置 · 官方':details?.publisher==='official'?'官方':'第三方' }}</span><h2 id="plugin-detail-title">{{ selectedManifest?.name ?? details?.name }}</h2><p>{{ selectedManifest?.author }} <span v-if="selectedManifest">· v{{ selectedManifest.version }}</span></p></div><button class="icon-button" aria-label="关闭插件详情" :disabled="!!busy" @click="close"><PhX :size="22" /></button></header>
      <p v-if="detailLoading">正在读取仓库说明…</p><p>{{ selectedManifest?.description ?? details?.description }}</p>
      <p v-if="selectedRuntime" class="plugin-notice"><strong>运行位置：</strong>{{ selectedRuntime.backend === 'dedicated' ? '独占插件线程' : '共享插件线程' }}。{{ selectedRuntime.backend === 'dedicated' ? '该插件拥有独立执行线程。' : '与其他共享插件一起运行；其中一个无响应时可能影响同组插件。' }}</p>
      <p v-if="current" class="plugin-notice plugin-commit">已安装：v{{ current.manifest.version }} · {{ current.commit.slice(0, 12) }}<br /><template v-if="current.activeRelease">正在运行：v{{ current.activeRelease.version }} · {{ current.activeRelease.commit.slice(0, 12) }}</template><template v-else>{{ current.manifest.theme ? '静态主题，应用后生效。' : '当前没有运行实例。' }}</template></p>
      <p v-if="selectedManifest" class="plugin-notice"><strong>生效方式：</strong>{{ selectedManifest.theme ? '主题应用后立即生效。' : selectedManifest.reload === 'restart' ? '需要重启。' + (selectedManifest.reloadReason ?? '作者声明此插件包含无法在线替换的组件，可安装后稍后重启。') : '支持热插拔与热更新，无需重启。相关任务或连接使用中时，等待结束后自动切换。' }}</p>
      <section v-if="selectedManifest" class="plugin-risk"><h3>AI 能力</h3><p>{{ selectedManifest.automation?.description ?? '此插件未提供 AI 能力声明，原有功能可正常使用。' }}</p><p v-if="selectedManifest.automation">{{ selectedManifest.automation.tools.length ? selectedManifest.automation.tools.map(t=>t.title).join('、') : '没有开放可调用工具。' }}</p></section><dl v-if="selectedManifest" class="plugin-facts"><div><dt>支持的宿主平台</dt><dd>{{ platformsText(selectedManifest.platforms) }}</dd></div><div><dt>分类</dt><dd>{{ categoriesText(selectedManifest) }}</dd></div><div><dt>提供的能力</dt><dd>{{ selectedManifest.capabilities.map(c=>capabilityName(c.id)).join('、') }}</dd></div><div><dt>运行要求</dt><dd>WebNav {{ selectedManifest.webnav }} · Node {{ selectedManifest.node }}<span v-if="selectedManifest.commands?.length"> · {{ selectedManifest.commands.join('、') }}</span></dd></div><div v-if="selectedManifest.dependencies && Object.keys(selectedManifest.dependencies).length"><dt>插件依赖</dt><dd>{{ Object.entries(selectedManifest.dependencies).map(([id,range])=>`${id} ${range}`).join('、') }}</dd></div><div><dt>许可证</dt><dd>{{ selectedManifest.license }}</dd></div><div v-if="details?.repository"><dt>源码仓库</dt><dd><a :href="details.repository" target="_blank" rel="noopener noreferrer">{{ details.repository }}</a></dd></div></dl>
      <template v-if="details?.repository"><p class="plugin-cache-note">详情缓存：{{ timestamp(metadata[details.repository]?.fetchedAt ?? null) }} <button class="button" :disabled="!!busy || detailLoading" @click="detailLoading=true; metadataFor(details,true).then(()=>{details=cards.find(c=>c.id===details?.id);detailLoading=false})"><PhArrowClockwise :size="14" />更新说明与图标</button></p></template>
      <details class="plugin-readme" :open="!preview"><summary>插件使用说明</summary><pre>{{ selectedReadme || '作者尚未提供 README，可在源码仓库查看。' }}</pre></details>
      <div v-if="selectedManifest?.screenshots?.length" class="plugin-screenshots"><a v-for="url in selectedManifest.screenshots" :key="url" :href="url" target="_blank" rel="noopener noreferrer">查看作者截图 <PhArrowSquareOut :size="13" /></a></div>
      <p v-if="current?.error" class="form-error">{{ current.error }}</p><p v-for="reason in current?.reasons ?? []" :key="reason" class="form-error">{{ reason }}</p>
      <div v-if="details" class="plugin-detail-actions"><button v-if="toolFor(details)" class="button primary" @click="launch(details)">打开工具</button><button v-if="hasSettings(details) && (current || details.publisher === 'builtin')" class="button" @click="settings(details)"><PhGearSix :size="18" />插件设置</button></div>
      <section v-if="preview" class="plugin-install-review">
        <h3>{{ preview.change === 'current' ? '已安装此提交，无需重复安装。' : pluginRisk.title }}</h3>
        <p class="plugin-commit">{{ preview.repository }}<br />{{ changeLabels[preview.change] }}<template v-if="preview.installedRelease"><br />已安装：v{{ preview.installedRelease.version }} · {{ preview.installedRelease.commit }}</template><br />目标：v{{ preview.manifest.version }} · {{ preview.commit }}</p>
        <p v-for="reason in preview.reasons" :key="reason" class="form-error">{{ reason }}</p>
        <p v-if="previewStale" class="form-error" role="alert">插件设置已变化，请重新读取安装说明后确认。</p>
        <template v-if="preview.change !== 'current'">
          <ul v-if="preview.changes.length"><li v-for="change in preview.changes" :key="change">{{ change }}</li></ul>
          <p>{{ pluginRisk.body }}</p><p>{{ pluginRisk.index }}</p><strong class="plugin-ai-advice">{{ pluginRisk.ai }}</strong><p>{{ pluginRisk.privacy }}</p>
          <details v-if="preview.manifest.install?.length"><summary>此插件声明的安装步骤</summary><pre>{{ preview.manifest.install.map(s=>`${s.command} ${s.args.join(' ')}`).join('\n') }}</pre></details>
          <label class="check-label"><input v-model="accepted" type="checkbox" :disabled="previewStale || !preview.compatible || !!busy" />{{ pluginRisk.consent }}</label>
        </template>
        <div class="plugin-detail-actions">
          <button class="button" :disabled="!!busy" @click="preview=undefined;accepted=false">{{ preview.change === 'current' ? '返回详情' : '取消安装' }}</button>
          <button v-if="previewStale" class="button" :disabled="!canWrite" @click="prepare(preview.repository,preview.ref,preview.manifest.id)">重新读取安装说明</button>
          <button v-else-if="preview.change !== 'current'" class="button primary" :disabled="!canWrite || !accepted || !preview.compatible" @click="install"><PhDownloadSimple :size="17" />确认风险并{{ preview.change === 'downgrade' ? '回退安装' : preview.upgrading ? '更新' : '安装' }}</button>
        </div>
      </section>
      <div v-else class="plugin-detail-actions"><template v-if="details?.bundled"><button v-if="!current" class="button primary" :disabled="!canWrite" @click="change(details.id, 'restore-bundled')">恢复安装</button><template v-else><button class="button" :disabled="!canWrite" @click="change(current.manifest.id,current.enabled?'disable':'enable')">{{ current.enabled?'禁用':'启用' }}</button><button class="button" :disabled="!canWrite" @click="uninstallId=current.manifest.id">卸载</button></template><small>随 WebNav 提供和更新，无需下载</small></template><template v-else-if="details?.publisher==='builtin'"><button class="button primary" :disabled="!canWrite" @click="change(details.id,'select')"><PhCheckCircle :size="17" />使用内置实现</button><small>随 WebNav 发布，无需下载</small></template><template v-else-if="details"><button v-if="!current" class="button primary" :disabled="!canWrite" @click="prepare(details.repository!,details.ref??'HEAD',details.id)">读取安装说明</button><template v-else><button class="button primary" :disabled="!canWrite" @click="change(current.manifest.id,'select')">{{ selectedManifest?.theme?'应用主题':'设为默认实现' }}</button><button v-if="!selectedManifest?.theme" class="button" :disabled="!canWrite" @click="change(current.manifest.id,current.enabled?'disable':'enable')">{{ current.enabled?'禁用':'启用' }}</button><button class="button" :disabled="!canWrite" @click="prepare(current.repository,current.ref,current.manifest.id)">检查更新</button><button v-if="current.previousCommit" class="button" :disabled="!canWrite" @click="change(current.manifest.id,'rollback')">回退上一版</button><button class="button" :disabled="!canWrite" @click="uninstallId=current.manifest.id">卸载</button></template></template></div>
      <div v-if="uninstallId" class="plugin-notice"><p>卸载此插件？原有连接配置、插件数据与仓库缓存会保留。能在线卸载的立即停止；使用中的资源结束后自动卸载，无法在线卸载时显示待重启。</p><button class="button" :disabled="!canWrite" @click="uninstallId=''">取消</button> <button class="button" :disabled="!canWrite" @click="change(uninstallId,'uninstall')">确认卸载</button></div>
      <p v-if="busy" role="status" class="plugin-notice">{{ busy }}</p><p v-if="notice" role="status" class="plugin-notice">{{ notice }}</p><p v-if="error" role="alert" class="form-error">{{ error }}</p>
    </div></dialog>
  </section>
</template>

<style scoped>
.plugin-install-review li{font-size:var(--font-caption);line-height:1.9;overflow-wrap:anywhere}
.plugin-center{max-width:1280px;margin:auto;--plugin-warning:light-dark(#8a5017,#f6c383)}.plugin-hero{display:flex;align-items:center;gap:22px;padding:16px 0 30px;border-bottom:1px solid var(--border)}.plugin-market-logo{width:76px;height:76px;object-fit:contain}.plugin-eyebrow{font-size:var(--font-caption);letter-spacing:.16em;color:var(--muted)}.plugin-hero h1{font-size:var(--font-heading);font-weight:650;letter-spacing:-.04em;margin:5px 0 8px}.plugin-hero p{color:var(--muted);margin:0}.plugin-hero>.button{margin-left:auto;white-space:nowrap}.plugin-toolbar{display:flex;gap:14px;align-items:center;padding:24px 0 16px}.plugin-spacer{flex:1}.plugin-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.plugin-search{display:flex;align-items:center;gap:9px;flex:1;min-width:190px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0 12px}.plugin-search input{border:0;background:transparent;outline:none;width:100%;padding:10px 0}.plugin-filters select{padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;max-width:100%}.plugin-filters .check-label{font-size:var(--font-caption);white-space:nowrap}.plugin-source{display:flex;justify-content:space-between;gap:12px;font-size:var(--font-caption);color:var(--muted);margin:15px 0 22px;flex-wrap:wrap}.plugin-source a,.plugin-screenshots a{display:inline-flex;align-items:center;gap:5px}.plugin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,258px),1fr));gap:15px}.plugin-card{text-align:left;border:1px solid var(--border);background:var(--surface);padding:22px;border-radius:14px;color:var(--ink);cursor:pointer;display:flex;flex-direction:column;transition:border-color .15s,transform .15s;min-height:224px}.plugin-card:hover{border-color:var(--accent);transform:translateY(-2px)}.plugin-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.plugin-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.plugin-card-top img,.plugin-icon-placeholder{width:48px;height:48px;flex-shrink:0;object-fit:contain;border-radius:12px}.plugin-icon-placeholder{display:grid;place-items:center;background:var(--surface-soft);color:var(--muted)}.plugin-badge{font-size:var(--font-caption);display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);border-radius:5px;padding:3px 6px;color:var(--muted);white-space:nowrap}.plugin-badge.builtin,.plugin-badge.official{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 25%,var(--border));background:color-mix(in srgb,var(--accent) 7%,var(--surface))}.plugin-card h2{font-size:var(--font-body);font-weight:650;margin:16px 0 8px}.plugin-card p{font-size:var(--font-caption);color:var(--muted);line-height:1.7;margin:0 0 20px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.plugin-card footer{margin-top:auto;display:flex;justify-content:space-between;gap:10px;font-size:var(--font-caption);color:var(--muted)}.plugin-card footer>span:last-child{color:var(--ink)}.plugin-footnote{font-size:var(--font-caption);color:var(--muted);margin:26px 0;max-width:800px;line-height:1.8}.plugin-empty{padding:60px 20px;text-align:center;color:var(--muted)}.plugin-notice{background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:var(--font-caption);line-height:1.8;white-space:pre-line}.plugin-git{display:grid;grid-template-columns:minmax(150px,1fr) 160px auto;align-items:end;gap:12px;padding:20px;border:1px solid var(--border);border-radius:12px;margin-top:20px;background:var(--surface)}.plugin-git .form-field{margin:0}.plugin-detail-dialog{width:min(740px,calc(100vw - 28px));max-width:none;max-height:calc(100dvh - 28px);padding:0;border:1px solid var(--border);border-radius:18px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}.plugin-detail-dialog::backdrop{background:#0c181c70;backdrop-filter:blur(3px)}.plugin-detail{padding:28px}.plugin-detail>header{display:flex;align-items:center;gap:17px;margin-bottom:24px}.plugin-detail>header img{width:64px;height:64px;object-fit:contain;border-radius:15px}.plugin-detail h2{margin:6px 0 3px;font-size:var(--font-heading)}.plugin-detail>header p{margin:0;font-size:var(--font-caption);color:var(--muted)}.plugin-detail>header>.icon-button{margin-left:auto;align-self:flex-start}.plugin-detail>p{font-size:var(--font-caption);line-height:1.8}.plugin-facts{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:15px 0;margin:20px 0}.plugin-facts>div{display:grid;grid-template-columns:120px 1fr;gap:14px;margin:8px 0;font-size:var(--font-caption)}.plugin-facts dt{color:var(--muted)}.plugin-facts dd{margin:0;overflow-wrap:anywhere}.plugin-facts a{text-decoration:underline}.plugin-cache-note{display:flex;justify-content:space-between;gap:8px;align-items:center;color:var(--muted)}.plugin-cache-note .button{font-size:var(--font-caption);padding:5px 8px}.plugin-readme summary{font-weight:600;cursor:pointer;font-size:var(--font-caption)}.plugin-readme pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--font-caption);line-height:1.9;color:var(--muted);padding:12px 0}.plugin-screenshots{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0;font-size:var(--font-caption)}.plugin-detail-actions{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:24px}.plugin-detail-actions small{color:var(--muted)}.plugin-install-review{margin-top:24px;border:1px solid color-mix(in srgb,#d18c3a 55%,var(--border));background:color-mix(in srgb,#c18c4e 6%,var(--surface));border-radius:12px;padding:20px}.plugin-install-review h3{color:var(--plugin-warning);font-size:var(--font-body);margin:0 0 12px}.plugin-install-review p{font-size:var(--font-caption);line-height:1.9}.plugin-ai-advice{display:block;padding:14px;border-left:3px solid #c18c4e;background:color-mix(in srgb,#c18c4e 13%,var(--surface));font-size:var(--font-caption);line-height:1.8}.plugin-install-review .check-label{align-items:flex-start;font-size:var(--font-caption);line-height:1.8}.plugin-install-review input{margin-top:5px;flex-shrink:0}.plugin-commit{overflow-wrap:anywhere;color:var(--muted)}.plugin-config{margin-top:20px;padding:16px;border:1px solid var(--border);border-radius:10px}.plugin-config p{color:var(--muted);font-size:var(--font-caption)}.spinning{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:650px){.plugin-hero{flex-wrap:wrap;gap:14px}.plugin-market-logo{width:54px;height:54px}.plugin-hero>div{flex:1;min-width:180px}.plugin-hero>.button{margin-left:0}.plugin-git{grid-template-columns:1fr}.plugin-detail{padding:19px}.plugin-facts>div{grid-template-columns:1fr;gap:3px}.plugin-cache-note{flex-wrap:wrap}.plugin-install-review{padding:14px}.plugin-filters{gap:8px}.plugin-search{flex-basis:100%}.plugin-toolbar .segmented{font-size:var(--font-caption)}}
.plugin-card{padding:0;cursor:default;min-height:210px;overflow:hidden}.plugin-card:hover{transform:none}.plugin-card-heading{display:flex;align-items:center;gap:12px;padding:18px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.plugin-card-heading img{width:38px;height:38px;object-fit:contain}.plugin-card-heading h2{margin:0 0 6px}.plugin-card-heading span{font-size:var(--font-caption);color:var(--muted)}.plugin-card-body{display:flex;flex-direction:column;gap:14px;padding:18px;flex:1}.plugin-card-body p{margin:0}.plugin-card-body footer{justify-content:flex-start;align-items:center;flex-wrap:wrap;gap:6px}.plugin-card-body footer .icon-button{margin-left:0;width:32px;height:36px}.plugin-run-state{font-size:var(--font-caption);color:var(--accent)}
</style>
