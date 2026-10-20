<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { PhSquaresFour, PhStar, PhClock, PhFolderSimple, PhPlus, PhCaretDown, PhMagnifyingGlass, PhTShirt, PhGearSix, PhList, PhX, PhTerminalWindow, PhDesktop, PhGlobeHemisphereWest, PhCheck, PhHardDrives, PhArrowRight, PhSlidersHorizontal } from '@phosphor-icons/vue'
import ServerItem from './components/ServerItem.vue'
import ServerEditor from './components/ServerEditor.vue'
import ManagementPage from './components/ManagementPage.vue'
import AppearancePanel from './components/AppearancePanel.vue'
import { useAppearance } from './appearance'
import { groupDescendants, protocolNames, orderedGroups } from './catalog'
import type { Connection, Group, Protocol, Server } from './catalog'
import { serializeCatalog } from './catalog-management'
import { groups, servers, catalogLoaded, saveCatalog, connectionState, saving, startBackend, rpc } from './backend'
import BackendStatus from './components/BackendStatus.vue'
import VaultPanel from './components/VaultPanel.vue'
import VaultUnlock from './components/VaultUnlock.vue'
import CredentialPanel from './components/CredentialPanel.vue'
import WorkspaceTabs from './components/WorkspaceTabs.vue'
import TerminalWindow from './components/TerminalWindow.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import { createBackdropGuard } from './dialog-backdrop'

const appearance = useAppearance()
const selected = ref(location.hash === '#manage' ? 'manage' : 'all')
const managementTab = ref<'servers' | 'groups'>('servers')
const sidebarGroups = computed(() => orderedGroups(groups.value))
const query = ref('')
const protocol = ref<Protocol | 'all'>('all')
const viewMode = ref<'list' | 'grid'>('list')
const sort = ref('default')
const recent = ref<string[]>([])
const mobileOpen = ref(false)
const searchInput = ref<HTMLInputElement>()
const panelDialog = ref<HTMLDialogElement>()
const panel = ref<'appearance' | 'editor' | 'connection' | 'vault' | 'credentials' | 'history'>('appearance')
const dialogTitle = computed(() => ({ appearance: '让工作台，更像你。', editor: editingServer.value ? '编辑服务器' : '添加服务器', connection: '连接入口', vault: '全局设置', credentials: 'SSH 认证', history: '查看历史' })[panel.value])
const favoriteServers = computed(() => servers.value.filter(server => server.favorite))
const groupName = (id: string) => groups.value.find(group => group.id === id)?.name ?? '未分组'
const groupCount = (id: string) => {
  const ids = groupDescendants(id, groups.value)
  return servers.value.filter(server => ids.has(server.groupId)).length
}
const pageTitles = new Map([['all', '所有服务器'], ['favorites', '收藏夹'], ['recent', '最近使用'], ['manage', '管理中心']])
const pageName = computed(() => pageTitles.get(selected.value) ?? groupName(selected.value))
const filteredServers = computed(() => {
  const ids = groupDescendants(selected.value, groups.value)
  const text = query.value.trim().toLocaleLowerCase()
  const result = servers.value.filter(server => {
    const matchView = selected.value === 'all' || selected.value === 'manage' || (selected.value === 'favorites' ? server.favorite : selected.value === 'recent' ? recent.value.includes(server.id) : ids.has(server.groupId))
    const matchProtocol = protocol.value === 'all' || server.connections.some(connection => connection.type === protocol.value)
    const haystack = [server.name, server.host, server.note, groupName(server.groupId), ...server.tags, ...server.connections.map(connection => connection.name)].join(' ').toLocaleLowerCase()
    return matchView && matchProtocol && (!text || haystack.includes(text))
  })
  if (sort.value === 'name') result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  if (sort.value === 'group') result.sort((a, b) => groupName(a.groupId).localeCompare(groupName(b.groupId), 'zh-CN'))
  if (selected.value === 'recent' && sort.value === 'default') result.sort((a, b) => recent.value.indexOf(a.id) - recent.value.indexOf(b.id))
  return result
})

const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function notify(message: string) {
  clearTimeout(toastTimer)
  toast.value = message
  toastTimer = setTimeout(() => { toast.value = '' }, 3600)
}
function navigate(target: string) { activeTerminal.value = ''; selected.value = target; mobileOpen.value = false; query.value = ''; protocol.value = 'all'; if (target === 'manage') managementTab.value = 'servers'; history.replaceState(null, '', target === 'manage' ? '#manage' : location.pathname) }
async function favorite(id: string) {
  const server = servers.value.find(item => item.id === id)
  if (server) {
    const nextServers = servers.value.map(item => item.id === id ? { ...item, favorite: !item.favorite } : item)
    try { serializeCatalog(groups.value, nextServers) } catch (cause) { notify(cause instanceof Error ? cause.message : '配置超出容量限制。'); return }
    try { await saveCatalog(groups.value, nextServers) } catch (cause) { notify(cause instanceof Error ? cause.message : '保存失败。'); return }; notify(!server.favorite ? `已收藏 ${server.name}` : `已取消收藏 ${server.name}`)
  }
}
async function showPanel(target: typeof panel.value) {
  mobileOpen.value = false
  panel.value = target
  await nextTick()
  panelDialog.value?.showModal()
}
function openPanel(target: typeof panel.value) { requestPanelAction(() => { void showPanel(target) }) }
function closePanelImmediately() {
  panelDialog.value?.close()
  panel.value = 'appearance'
}
function closePanel() { requestPanelAction(closePanelImmediately) }
const backdropEvents = createBackdropGuard(closePanel)

const editingServer = ref<Server>()
const editorSaveError = ref('')
const editorRevision = ref(0)
const editor = ref<InstanceType<typeof ServerEditor>>()
const editorBusy = ref(false)
const unsavedDialog = ref<HTMLDialogElement>()
let pendingPanelAction: (() => void) | undefined
function requestPanelAction(action: () => void) {
  if (editorBusy.value || unsavedDialog.value?.open) return
  if (panelDialog.value?.open && panel.value === 'editor' && editor.value?.dirty) {
    pendingPanelAction = action
    unsavedDialog.value?.showModal()
    return
  }
  action()
}
function continueEditing() {
  pendingPanelAction = undefined
  unsavedDialog.value?.close()
}
function discardAndLeave() {
  const action = pendingPanelAction
  continueEditing()
  action?.()
}
async function saveAndLeave() {
  const action = pendingPanelAction
  // Reveal the editor before validation so invalid fields can receive focus.
  continueEditing()
  const server = editor.value?.getValidatedServer()
  if (server && await persistServer(server)) action?.()
}
function edit(server?: Server) {
  requestPanelAction(() => {
    editorSaveError.value = ''
    editingServer.value = server
    editorRevision.value++
    void showPanel('editor')
  })
}
async function persistServer(server: Server): Promise<boolean> {
  if (editorBusy.value) return false
  editorSaveError.value = ''
  const index = servers.value.findIndex(item => item.id === server.id)
  const nextServers = index >= 0 ? servers.value.map(item => item.id === server.id ? server : item) : [...servers.value, server]
  try { serializeCatalog(groups.value, nextServers) } catch (cause) { editorSaveError.value = cause instanceof Error ? cause.message : '配置超出容量限制。'; return false }
  editorBusy.value = true
  try { await saveCatalog(groups.value, nextServers, editor.value?.getRdpPasswordUpdates()) }
  catch (cause) { editorSaveError.value = cause instanceof Error ? cause.message : '保存失败。'; return false }
  finally { editorBusy.value = false }
  notify('已保存到本机数据库。')
  return true
}
async function saveServer(server: Server) { if (await persistServer(server)) closePanelImmediately() }
async function deleteServer(id: string) {
  if (editorBusy.value) return
  editorBusy.value = true
  try { await saveCatalog(groups.value, servers.value.filter(server => server.id !== id)) } catch (cause) { notify(cause instanceof Error ? cause.message : '删除失败。'); return }
  finally { editorBusy.value = false }
  recent.value = recent.value.filter(item => item !== id)
  closePanelImmediately(); notify('已删除服务器。')
}
function manageGroups() { navigate('manage'); managementTab.value = 'groups' }

const previewConnection = ref<{ server: Server; connection: Connection }>()
const credentialTarget = ref<{ serverId: string; connectionId: string }>()
const historyServer = ref('')
const terminals = ref<{sessionId:string;attachToken:string;name:string;serverId:string;status:string;floating:boolean;order:number;focusRequest:number}[]>([])
const activeTerminal = ref(''), openingConnection = ref(false)
function credentials(serverId:string, connectionId:string) { credentialTarget.value={serverId,connectionId};void openPanel('credentials') }
function showHistory(serverId:string) { historyServer.value=serverId;void openPanel('history') }
function closeTerminal(id:string) {
  const index = terminals.value.findIndex(item => item.sessionId === id)
  terminals.value = terminals.value.filter(item => item.sessionId !== id)
  if (activeTerminal.value === id) activeTerminal.value = terminals.value.slice(index).find(item => !item.floating)?.sessionId ?? terminals.value.slice(0, index).filter(item => !item.floating).at(-1)?.sessionId ?? ''
}
function raiseTerminal(id: string) {
  const others = terminals.value.filter(item => item.floating && item.sessionId !== id).sort((a, b) => a.order - b.order)
  others.forEach((item, index) => { item.order = index + 1 })
  const target = terminals.value.find(item => item.sessionId === id)
  if (target) { target.order = others.length + 1; target.focusRequest++ }
}
function selectTerminal(id: string) {
  const target = terminals.value.find(item => item.sessionId === id)
  if (target?.floating) raiseTerminal(id)
  else activeTerminal.value = id
}
function floatTerminal(id: string) {
  const target = terminals.value.find(item => item.sessionId === id)
  if (!target) return
  target.floating = true
  raiseTerminal(id)
  if (activeTerminal.value === id) activeTerminal.value = terminals.value.filter(item => !item.floating).at(-1)?.sessionId ?? ''
}
function dockTerminal(id: string) {
  const target = terminals.value.find(item => item.sessionId === id)
  if (!target) return
  target.floating = false
  activeTerminal.value = id
}
function searchServers() {
  if (!activeTerminal.value) return
  activeTerminal.value = ''
  selected.value = 'all'
  protocol.value = 'all'
  history.replaceState(null, '', location.pathname)
}
async function connect(server: Server, connection: Connection) {
  if(openingConnection.value)return
  openingConnection.value=true
  try {
    if(connection.type==='web') { previewConnection.value={server,connection};void openPanel('connection');return }
    if(connection.type==='ssh') {
      const credential=await rpc<{configured:boolean}>('credentials.describe',{serverId:server.id,connectionId:connection.id})
      if(!credential.configured){credentials(server.id,connection.id);return}
      if(terminals.value.length>=8)throw new Error('请先关闭一个终端，最多保留 8 个终端标签。')
      const opened=await rpc<{sessionId:string;attachToken:string}>('connections.open',{serverId:server.id,connectionId:connection.id},true)
      terminals.value.push({...opened,name:server.name,serverId:server.id,status:'连接中',floating:false,order:0,focusRequest:0});activeTerminal.value=opened.sessionId
    } else {
      await rpc('connections.open',{serverId:server.id,connectionId:connection.id},true);notify('远程桌面客户端已启动。')
    }
    recent.value=[server.id,...recent.value.filter(id=>id!==server.id)]
  } catch(cause){notify(cause instanceof Error?cause.message:'无法打开连接。')} finally {openingConnection.value=false}
}
function keyboard(event: KeyboardEvent) {
  if (connectionState.value !== 'ready') return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    requestPanelAction(() => { closePanelImmediately(); mobileOpen.value = false; searchInput.value?.focus() })
  }
  if (event.key === 'Escape') { mobileOpen.value = false; if (!panelDialog.value?.open) query.value = '' }
}
let stopBackend: (() => void) | undefined
onMounted(() => { window.addEventListener('keydown', keyboard); stopBackend = startBackend() })
onBeforeUnmount(() => { stopBackend?.(); window.removeEventListener('keydown', keyboard); clearTimeout(toastTimer) })
</script>

<template>
  <div class="app-shell">
    <VaultUnlock />
    <button v-if="mobileOpen" class="nav-scrim" aria-label="关闭导航" @click="mobileOpen = false"></button>
    <aside :class="['sidebar', { 'mobile-open': mobileOpen }]" :style="{ '--page': appearance.settings.value.left.color }" :data-theme="appearance.sidebarDark.value ? 'dark' : 'light'" aria-label="工作空间导航">
      <img v-if="appearance.backgroundImages.value.left" class="region-background" :src="appearance.backgroundImages.value.left" alt="" />
      <a href="#" class="brand" @click.prevent="navigate('all')"><span class="brand-mark"><i></i><i></i><i></i></span><span><strong>WebNav</strong></span></a>
      <button class="icon-button mobile-close" aria-label="收起导航" @click="mobileOpen = false"><PhX :size="21" /></button>
      <nav class="main-navigation">
        <p class="nav-label">工作空间</p>
        <button v-for="item in [{ id: 'all', name: '所有服务器', icon: PhHardDrives }, { id: 'favorites', name: '收藏夹', icon: PhStar }, { id: 'recent', name: '最近使用', icon: PhClock }]" :key="item.id" :class="['nav-item', { active: selected === item.id }]" :aria-current="selected === item.id ? 'page' : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="20" /><span>{{ item.name }}</span><small v-if="item.id === 'all' && catalogLoaded">{{ servers.length }}</small></button>
        <div class="nav-divider"></div>
        <div class="group-label"><p class="nav-label">服务器分组</p><button class="icon-button small" aria-label="管理分组" @click="manageGroups"><PhPlus :size="17" /></button></div>
        <button v-for="group in sidebarGroups" :key="group.id" :class="['nav-item', { active: selected === group.id }]" :style="{ paddingLeft: `${14 + group.depth * 14}px` }" :aria-current="selected === group.id ? 'page' : undefined" @click="navigate(group.id)"><PhFolderSimple :size="group.depth ? 17 : 20" /><span>{{ group.name }}</span><small>{{ groupCount(group.id) }}</small></button>
        <button v-if="servers.some(server => !server.groupId)" :class="['nav-item', { active: selected === '' }]" @click="navigate('')"><PhFolderSimple :size="20" /><span>未分组</span><small>{{ servers.filter(server => !server.groupId).length }}</small></button>
      </nav>
      <div class="sidebar-bottom"><div class="nav-divider"></div><button :class="['nav-item', { active: selected === 'manage' }]" @click="navigate('manage')"><PhGearSix :size="20" /><span>管理中心</span></button></div>
    </aside>

    <div class="workspace" :class="{ 'has-terminal-tabs': terminals.length, 'terminal-active': activeTerminal }" :inert="mobileOpen || undefined">
      <div class="workspace-background" aria-hidden="true"><img v-if="appearance.backgroundImages.value.right" class="region-background" :src="appearance.backgroundImages.value.right" alt="" /></div>
      <header class="topbar"><button class="icon-button mobile-menu" aria-label="展开导航" @click="mobileOpen = true"><PhList :size="22" /></button><WorkspaceTabs v-if="terminals.length" :terminals="terminals" :active-id="activeTerminal" :directory-name="pageName" @select="selectTerminal" @close="closeTerminal" /><div v-else class="breadcrumb"><span>工作空间</span><span class="breadcrumb-separator">/</span><strong>{{ pageName }}</strong></div><div class="topbar-actions"><label class="global-search"><PhMagnifyingGlass :size="19" /><input ref="searchInput" v-model="query" @input="searchServers" aria-label="搜索服务器、IP 或标签" placeholder="搜索服务器" /><button v-if="query" class="search-clear" aria-label="清空搜索" @click="query = ''"><PhX :size="14" /></button><kbd v-else>Ctrl K</kbd></label><button class="icon-button" aria-label="全局设置" title="全局设置" :disabled="connectionState !== 'ready'" @click="openPanel('vault')"><PhGearSix :size="21" /></button><button class="icon-button appearance-shortcut" aria-label="打开外观设置" title="外观设置" @click="openPanel('appearance')"><PhTShirt :size="21" /></button><span class="preview-label">{{ connectionState === 'ready' ? '本机' : '离线' }}</span></div></header>
      <main id="workspace-catalog" v-show="!activeTerminal" class="main-content" :role="terminals.length ? 'tabpanel' : undefined" :aria-labelledby="terminals.length ? 'workspace-tab-catalog' : undefined">
        <BackendStatus />
        <section class="page-heading"><div><h1>{{ pageName }}<span v-if="selected !== 'manage' && catalogLoaded" class="heading-count">{{ filteredServers.length }}</span></h1></div><div v-if="selected !== 'manage'" class="heading-actions"><button class="button icon-only" title="管理分组" aria-label="管理分组" @click="manageGroups"><PhFolderSimple :size="20" /></button><button class="button primary icon-only" title="添加服务器" aria-label="添加服务器" :disabled="connectionState !== 'ready'" @click="edit()"><PhPlus :size="22" /></button></div></section>

        <div v-if="catalogLoaded" :inert="connectionState !== 'ready' || undefined"><section v-if="selected === 'all' && !query && favoriteServers.length" class="favorites-section" aria-labelledby="favorite-title"><div class="section-title"><h2 id="favorite-title">收藏夹</h2><span>{{ favoriteServers.length }}</span></div><div class="favorite-grid"><ServerItem v-for="server in favoriteServers" :key="server.id" :server="server" :group-name="groupName(server.groupId)" card @favorite="favorite" @connect="connect" @edit="edit" /></div></section>

        <ManagementPage v-if="selected === 'manage'" :servers="servers" :groups="groups" :query="query" :initial-tab="managementTab" @edit="edit" :commit="saveCatalog" @notify="notify" @clear-search="query = ''" />
        <section v-else class="directory-section" aria-labelledby="directory-title"><div class="directory-heading"><div class="section-title"><h2 id="directory-title">{{ query ? '搜索结果' : pageName === '所有服务器' || selected === 'manage' ? '全部服务器' : pageName }}</h2><span class="result-count">{{ filteredServers.length }}</span></div></div><div class="directory-toolbar"><div class="segmented protocol-filter" aria-label="按连接方式筛选"><button v-for="item in ['all', 'ssh', 'rdp', 'web'] as const" :key="item" :class="{ active: protocol === item }" :aria-pressed="protocol === item" @click="protocol = item">{{ item === 'all' ? '全部' : protocolNames[item] }}</button></div><div class="toolbar-right"><div class="segmented view-toggle" aria-label="显示方式"><button :class="{ active: viewMode === 'list' }" :aria-pressed="viewMode === 'list'" aria-label="列表视图" @click="viewMode = 'list'"><PhList :size="18" /></button><button :class="{ active: viewMode === 'grid' }" :aria-pressed="viewMode === 'grid'" aria-label="卡片视图" @click="viewMode = 'grid'"><PhSquaresFour :size="18" /></button></div><label class="sort-select"><span class="visually-hidden">服务器排序</span><select v-model="sort"><option value="default">默认排序</option><option value="name">按名称排序</option><option value="group">按分组排序</option></select><PhCaretDown :size="13" /></label></div></div>
          <div v-if="filteredServers.length" :class="['server-directory', { 'grid-directory': viewMode === 'grid' }]"><div v-if="viewMode === 'list'" class="table-header"><span>服务器</span><span>所属分组</span><span>连接方式</span><span class="visually-hidden">操作</span></div><ServerItem v-for="server in filteredServers" :key="server.id" :server="server" :group-name="groupName(server.groupId)" :card="viewMode === 'grid'" @favorite="favorite" @connect="connect" @edit="edit" /><p v-if="viewMode === 'grid'" class="grid-edit-hint"><PhSlidersHorizontal :size="15" />编辑配置请切换列表视图。</p></div>
          <div v-else class="empty-state"><PhMagnifyingGlass v-if="query" :size="36" /><PhStar v-else-if="selected === 'favorites'" :size="36" /><PhClock v-else-if="selected === 'recent'" :size="36" /><PhFolderSimple v-else :size="36" /><h3>{{ query ? '没有找到匹配的服务器' : selected === 'favorites' ? '收藏夹还是空的' : selected === 'recent' ? '还没有最近使用记录' : !servers.length ? '还没有服务器' : '这个分组还没有服务器' }}</h3><p>{{ query ? '试试名称、IP、标签或分组名称。' : selected === 'favorites' ? '点击服务器的星标，即可加入收藏夹。' : selected === 'recent' ? '打开一个连接预览后，会显示在这里。' : '添加服务器，或切换其他筛选条件。' }}</p><button v-if="!servers.length" class="button" @click="navigate('manage')">打开管理中心</button><button v-else class="button" @click="navigate('all')">查看全部服务器<PhArrowRight :size="16" /></button></div>
        </section>
        </div><section v-else class="empty-state catalog-pending" role="status"><PhHardDrives :size="36" /><h3>目录尚未加载</h3><p>连接本地服务后，才会读取已保存的服务器和分组。</p></section><footer class="workspace-footer"><span><kbd>Ctrl K</kbd>快速搜索</span><span>{{ saving ? '正在保存…' : connectionState === 'ready' ? '本机数据库' : '服务未连接' }}</span></footer>
      </main>
      <section v-if="terminals.length" class="terminal-workspace" :class="{ idle: !activeTerminal }" aria-label="SSH 终端工作区">
        <TerminalWindow v-for="item in terminals" :key="item.sessionId" :session-id="item.sessionId" :attach-token="item.attachToken" :name="item.name" :active="activeTerminal === item.sessionId" :floating="item.floating" :order="item.order" :focus-request="item.focusRequest" @status="item.status = $event" @history="showHistory(item.serverId)" @float="floatTerminal(item.sessionId)" @dock="dockTerminal(item.sessionId)" @close="closeTerminal(item.sessionId)" @raise="raiseTerminal(item.sessionId)" />
      </section>
    </div>

    <dialog aria-labelledby="panel-title" ref="panelDialog" :class="['panel-dialog', { 'connection-dialog': panel === 'connection', 'history-dialog': panel === 'history' }]" v-on="backdropEvents" @cancel.prevent="closePanel"><div class="panel-shell"><header class="panel-header"><div><span class="panel-kicker">{{ panel === 'appearance' ? '外观设置' : panel === 'connection' ? 'WebNav' : '管理中心' }}</span><h2 id="panel-title">{{ dialogTitle }}</h2></div><button class="icon-button" aria-label="关闭面板" :disabled="editorBusy" @click="closePanel"><PhX :size="22" /></button></header><div class="panel-body">
      <AppearancePanel v-if="panel === 'appearance'" :appearance="appearance" />

      <ServerEditor v-else-if="panel === 'editor'" ref="editor" :key="editorRevision" :server="editingServer" :groups="groups" :save-error="editorSaveError" :busy="editorBusy" @save="saveServer" @cancel="closePanel" @remove="deleteServer" @credentials="credentials" @history="showHistory" />

      <VaultPanel v-else-if="panel === 'vault'" />
      <CredentialPanel v-else-if="panel === 'credentials' && credentialTarget" :key="credentialTarget.serverId + credentialTarget.connectionId" :server-id="credentialTarget.serverId" :connection-id="credentialTarget.connectionId" @saved="closePanel(); notify('认证信息已保存。')" />
      <HistoryPanel v-else-if="panel === 'history'" :key="historyServer" :server-id="historyServer" />
      <div v-else-if="panel === 'connection' && previewConnection" class="connection-preview"><span class="connection-preview-icon"><PhTerminalWindow v-if="previewConnection.connection.type === 'ssh'" :size="35" /><PhDesktop v-else-if="previewConnection.connection.type === 'rdp'" :size="35" /><PhGlobeHemisphereWest v-else :size="35" /></span><h3>{{ previewConnection.server.name }}</h3><p class="server-address">{{ previewConnection.connection.type === 'web' ? previewConnection.connection.url : `${previewConnection.server.host}:${previewConnection.connection.port}` }}</p><div class="connection-summary"><span>连接类型<strong>{{ protocolNames[previewConnection.connection.type] }}</strong></span><span v-if="previewConnection.connection.username">用户名<strong>{{ previewConnection.connection.username }}</strong></span><span>当前状态<strong>尚未连接</strong></span></div><a v-if="previewConnection.connection.type === 'web'" class="button primary" :href="previewConnection.connection.url" target="_blank" rel="noopener noreferrer">打开网页</a><button class="button" @click="closePanel">返回工作台</button></div>
    </div></div></dialog>
    <dialog ref="unsavedDialog" class="management-dialog unsaved-dialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-description" @cancel.prevent="continueEditing">
      <header><h2 id="unsaved-title">保存修改？</h2><button class="icon-button" aria-label="继续编辑" title="继续编辑" @click="continueEditing"><PhX :size="20" /></button></header>
      <p id="unsaved-description">服务器信息有未保存的修改。</p>
      <div class="unsaved-actions">
        <button type="button" class="button" autofocus @click="continueEditing">继续编辑</button>
        <button type="button" class="button" @click="discardAndLeave">不保存</button>
        <button type="button" class="button primary" @click="saveAndLeave"><PhCheck :size="17" />保存</button>
      </div>
    </dialog>
    <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><PhCheck :size="17" />{{ toast }}</div></Transition>
  </div>
</template>
