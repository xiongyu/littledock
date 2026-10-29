<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fileEditors } from './file-editors'
import { workspaceSnapshot } from './backend'
import type { WorkspaceView } from '@webnav/shared'
import RemoteEditorPanel from './components/RemoteEditorPanel.vue'
const RemoteFileEditor=defineAsyncComponent(()=>import('./components/RemoteFileEditor.vue'))
import { PhSquaresFour, PhStar, PhClock, PhFolderSimple, PhPlus, PhCaretDown, PhMagnifyingGlass, PhTShirt, PhGearSix, PhList, PhX, PhTerminalWindow, PhDesktop, PhGlobeHemisphereWest, PhCheck, PhHardDrives, PhArrowRight, PhSlidersHorizontal } from '@phosphor-icons/vue'
import TerminalSplitPicker from './components/TerminalSplitPicker.vue'
import SshSystemPanel from './components/SshSystemPanel.vue'
import SshFilesPanel from './components/SshFilesPanel.vue'
import { PhCpu, PhFolderOpen, PhSidebarSimple, PhActivity } from '@phosphor-icons/vue'
import { useWorkspacePreferences, dragDimension } from './workspace-preferences'
import ContextMenu from './components/ContextMenu.vue'
import { menuBinding, pluginMenuNotice } from './plugin-menus'
watch(pluginMenuNotice, value => { if (value) notify(value.message) })
import TerminalThemesPanel from './components/TerminalThemesPanel.vue'
import TerminalConnectionThemePanel from './components/TerminalConnectionThemePanel.vue'
import { openSessionPage, type SessionPage } from './session-page'
import { filterLayout, joinPane, layoutGeometry, paneIds, removePane, replacePane, setSplitRatio, type LayoutRect, type SplitDirection, type SplitHandle, type TerminalGroup } from './terminal-workspace'
import ServerItem from './components/ServerItem.vue'
import ServerEditor from './components/ServerEditor.vue'
import ManagementPage from './components/ManagementPage.vue'
import AppearancePanel from './components/AppearancePanel.vue'
import PluginCenter from './components/PluginCenter.vue'
import BrowserExtensionPanel from './components/BrowserExtensionPanel.vue'
import UpdatePanel from './components/UpdatePanel.vue'
import PluginWorkspacePage from './components/PluginWorkspacePage.vue'
import { activePluginTab, pluginTabs, pluginTools, openPluginTool, openPluginSettings, closePluginTab, setPluginSettingsOpener, openSettingsTab } from './plugin-workspace'
import PluginSettingsPage from './components/PluginSettingsPage.vue'
import { pluginViews, pluginState, connectorProvider } from './plugins'
import { useAppearance } from './appearance'
import { groupDescendants, protocolNames, orderedGroups } from './catalog'
import type { Connection, Group, Protocol, Server } from './catalog'
import { serializeCatalog } from './catalog-management'
import { groups, servers, catalogLoaded, saveCatalog, connectionState, saving, startBackend, rpc, automationTasks } from './backend'
import BackendStatus from './components/BackendStatus.vue'
import VaultPanel from './components/VaultPanel.vue'
import VaultUnlock from './components/VaultUnlock.vue'
import CredentialPanel from './components/CredentialPanel.vue'
import WorkspaceTabs from './components/WorkspaceTabs.vue'
import TerminalWindow from './components/TerminalWindow.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import WebBookmarks from './components/WebBookmarks.vue'
import { createBackdropGuard } from './dialog-backdrop'
import { opensInWorkspace } from './connectors'
import { useSessionPreviews } from './session-previews'

const appearance = useAppearance()
setPluginSettingsOpener((id, section) => {
  const manifest = pluginState.value?.installed.find(plugin => plugin.manifest.id === id)?.manifest ?? pluginState.value?.builtins.find(plugin => plugin.id === id)?.manifest
  if (!manifest) throw new Error('插件尚未安装。')
  openSettingsTab(id, manifest.name, PluginSettingsPage, section)
})
const workspacePreferences = useWorkspacePreferences()
const navigationPeek = ref(false)
function trackNavigationPointer(event: PointerEvent) {
  // Track coordinates rather than a thin overlay or the animated sidebar boundary.
  if (event.pointerType !== 'mouse' || event.buttons !== 0) return
  if (mobileOpen.value || (!workspacePreferences.value.navigationClosed && window.innerWidth >= 768)) return
  if (event.target instanceof Element && event.target.closest('dialog, [role="dialog"]')) return
  const boundary = navigationPeek.value ? workspacePreferences.value.navigationWidth : 20
  navigationPeek.value = event.clientX >= 0 && event.clientX <= boundary
}
function hideNavigationPeek() { navigationPeek.value = false }
function toggleNavigation(){navigationPeek.value=false;if(window.innerWidth<768)mobileOpen.value=!mobileOpen.value;else workspacePreferences.value.navigationClosed=!workspacePreferences.value.navigationClosed}
function resizeNavigation(event:PointerEvent){dragDimension(event,event=>{workspacePreferences.value.navigationWidth=Math.max(164,Math.min(400,window.innerWidth-360,event.clientX))})}
function resizeSystemPanel(event: PointerEvent) {
  const box = (event.currentTarget as HTMLElement).closest('.session-workbench')!.getBoundingClientRect()
  const max = Math.max(200, Math.min(420, box.width - (window.innerWidth < 768 ? 48 : 160)))
  dragDimension(event, pointer => { workspacePreferences.value.systemWidth = Math.max(200, Math.min(max, pointer.clientX - box.left)) })
}
function resizeFiles(event:PointerEvent){const box=(event.currentTarget as HTMLElement).parentElement!.parentElement!.getBoundingClientRect();dragDimension(event,event=>{workspacePreferences.value.filesHeight=Math.max(140,Math.min(420,box.height-120,box.bottom-event.clientY))})}
const previews = useSessionPreviews()
watch(servers, value => previews.prune(new Set(value.map(server => server.id))))
function previewFrame(sessionId: string, serverId: string, blob: Blob) { if (servers.value.some(server => server.id === serverId)) previews.frame(sessionId, blob) }
const selected = ref(location.hash === '#manage' ? 'manage' : location.hash === '#plugins' ? '@plugins' : 'all')

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
const panel = ref<'appearance' | 'editor' | 'connection' | 'vault' | 'credentials' | 'history' | 'terminalThemes' | 'terminalConnectionTheme' | 'browserExtension' | 'updates'>('appearance')
const themeTarget = ref<{ serverId: string; connectionId: string }>()
const dialogTitle = computed(() => ({ appearance: '让工作台，更像你。', editor: editingServer.value ? '编辑服务器' : '添加服务器', connection: '连接入口', vault: '全局设置', credentials: 'SSH 认证', history: '查看历史', terminalThemes: '终端配色', terminalConnectionTheme: '终端配色', browserExtension: '浏览器自动填写', updates: '工作台更新' })[panel.value])
const favoriteServers = computed(() => servers.value.filter(server => server.favorite))
const groupName = (id: string) => groups.value.find(group => group.id === id)?.name ?? '未分组'
const groupCount = (id: string) => {
  const ids = groupDescendants(id, groups.value)
  return servers.value.filter(server => ids.has(server.groupId)).length
}
const pageTitles = new Map([['all', '所有服务器'], ['favorites', '收藏夹'], ['recent', '最近使用'], ['manage', '管理中心'], ['@plugins', '插件中心']])
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
function navigate(target: string) { activePluginTab.value = ''; activeTerminal.value = ''; selected.value = target; mobileOpen.value = false; query.value = ''; protocol.value = 'all'; if (target === 'manage') managementTab.value = 'servers'; history.replaceState(null, '', target === 'manage' ? '#manage' : target === '@plugins' ? '#plugins' : location.pathname) }
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
function openCapabilitySettings(capability: string) {
  const state = pluginState.value
  const provider = state?.runningProviders[capability]
  const installed = state?.installed.find(item => item.manifest.id === provider && item.manifest.contributes?.settings)
  const builtin = state?.builtins.find(item => item.manifest.capabilities.some(cap => cap.id === capability) && item.manifest.contributes?.settings)
  const id = installed?.manifest.id ?? builtin?.id
  if (id) requestPanelAction(() => { closePanelImmediately(); openPluginSettings(id) })
}
function closePanelImmediately() {
  panelDialog.value?.close()
  panel.value = 'appearance'
}
function closePanel() { requestPanelAction(closePanelImmediately) }
const backdropEvents = createBackdropGuard(closePanel)

const editingServer = ref<Server>()
const editorGroupId = ref('')
const editorSaveError = ref('')
const editorRevision = ref(0)
const editor = ref<InstanceType<typeof ServerEditor>>()
const themeEditor = ref<InstanceType<typeof TerminalThemesPanel> | InstanceType<typeof TerminalConnectionThemePanel>>()
const editorBusy = ref(false)
const unsavedDialog = ref<HTMLDialogElement>()
let pendingPanelAction: (() => void) | undefined
function requestPanelAction(action: () => void) {
  if (editorBusy.value || themeEditor.value?.busy || unsavedDialog.value?.open) return
  if (panelDialog.value?.open && ((panel.value === 'editor' && editor.value?.dirty) || (['terminalThemes', 'terminalConnectionTheme'].includes(panel.value) && themeEditor.value?.dirty))) {
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
  if (['terminalThemes', 'terminalConnectionTheme'].includes(panel.value)) { if (await themeEditor.value?.save()) action?.(); return }
  const server = editor.value?.getValidatedServer()
  if (server && await persistServer(server)) action?.()
}
function edit(server?: Server, initialGroupId = selected.value) {
  requestPanelAction(() => {
    editorSaveError.value = ''
    editingServer.value = server
    editorGroupId.value = groups.value.some(group => group.id === initialGroupId) ? initialGroupId : ''
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
const terminals = ref<{sessionId:string;attachToken:string;name:string;serverId:string;connectionId:string;ai?:boolean;page?:SessionPage;protocol:'ssh'|'rdp'|'vnc'|'local'|'adb'|'wdb';display?:Connection['rdpDisplay'];status:string;floating:boolean;order:number;focusRequest:number}[]>([])
const activeTerminal = ref(''), openingConnection = ref(false)
watch(activeTerminal, id => { if(id) activePluginTab.value = '' })
watch(activePluginTab, id => { if (id) { activeTerminal.value = ''; mobileOpen.value = false } })
const dismissedAi=new Set<string>()
watch(automationTasks,tasks=>{
  for(const item of terminals.value.filter(t=>t.ai&&!tasks.some(task=>task.sessionId===t.sessionId)))closeTerminal(item.sessionId,false)
  for(const task of tasks){
    const existing=terminals.value.find(t=>t.sessionId===task.sessionId)
    if(existing){existing.status=task.message;continue}
    if(dismissedAi.has(task.sessionId))continue
    terminals.value.push({sessionId:task.sessionId,attachToken:'',name:task.name,serverId:task.serverId,connectionId:task.connectionId,protocol:'ssh',ai:true,status:task.message,floating:false,order:0,focusRequest:0})
    addTerminalGroup(task.sessionId)
  }
})
const workspaceArea = ref<HTMLElement>()
const terminalGroups = ref<TerminalGroup[]>([])
function groupFor(id:string){return terminalGroups.value.find(group=>paneIds(group.layout).includes(id))}
function docked(id:string){const item=terminals.value.find(item=>item.sessionId===id);return !!item&&!item.floating&&!item.page}
const activeGroup = computed(()=>groupFor(activeTerminal.value))
const minimized = ref(new Set<string>())
let restoredEpoch='',workspaceRevision=0,restoringWorkspace=false,savingWorkspace=false,workspaceDirty=false
let workspaceSaveTimer:ReturnType<typeof setTimeout>|undefined
const workspaceView=computed<WorkspaceView>(()=>({groups:terminalGroups.value.filter(g=>paneIds(g.layout).some(id=>terminals.value.some(t=>t.sessionId===id&&!t.ai))),active:activeTerminal.value,floating:terminals.value.filter(t=>t.floating&&!t.ai).map(t=>t.sessionId),minimized:[...minimized.value]}))
async function saveWorkspace(){
  if(restoringWorkspace||!restoredEpoch||connectionState.value!=='ready')return
  workspaceDirty=true;if(savingWorkspace)return
  savingWorkspace=true
  try{
    while(workspaceDirty&&connectionState.value==='ready'){
      workspaceDirty=false
      const result=await rpc<{revision:number}>('workspace.save',{expectedRevision:workspaceRevision,view:JSON.parse(JSON.stringify(workspaceView.value))},true)
      workspaceRevision=result.revision
    }
  }catch(cause){workspaceDirty=false;notify(cause instanceof Error?cause.message:'工作区布局保存失败。')}
  finally{savingWorkspace=false}
}
watch(workspaceView,()=>{if(restoringWorkspace)return;clearTimeout(workspaceSaveTimer);workspaceSaveTimer=setTimeout(()=>{void saveWorkspace()},80)},{deep:true})
watch(workspaceSnapshot,snapshot=>{
  if(!snapshot)return
  workspaceRevision=snapshot.revision
  if(restoredEpoch===snapshot.epoch)return
  restoredEpoch=snapshot.epoch;restoringWorkspace=true
  const existing=new Set(terminals.value.map(t=>t.sessionId))
  for(const session of snapshot.sessions)if(!existing.has(session.sessionId)){
    const connection=servers.value.find(s=>s.id===session.serverId)?.connections.find(c=>c.id===session.connectionId)
    terminals.value.push({...session,attachToken:'',display:connection?.rdpDisplay,status:'正在恢复…',floating:snapshot.view.floating.includes(session.sessionId),order:0,focusRequest:0})
    previews.add(session.sessionId,session.serverId,session.protocol)
  }
  const available=new Set(terminals.value.map(t=>t.sessionId))
  const saved=snapshot.view.groups.flatMap(group=>{const layout=filterLayout(group.layout,id=>available.has(id));return layout?[{...group,layout}]:[]})
  const grouped=new Set(saved.flatMap(group=>paneIds(group.layout)))
  for(const item of terminals.value)if(!grouped.has(item.sessionId))saved.push({id:crypto.randomUUID(),focusedId:item.sessionId,layout:{kind:'pane',sessionId:item.sessionId}})
  terminalGroups.value=saved;minimized.value=new Set(snapshot.view.minimized.filter(id=>available.has(id)))
  activeTerminal.value=available.has(snapshot.view.active)?snapshot.view.active:snapshot.sessions[0]?.sessionId??activeTerminal.value
  void nextTick(()=>{restoringWorkspace=false})
})
const inspectorTerminal = computed(()=>{const item=terminals.value.find(item=>item.sessionId===activeTerminal.value);return item?.protocol==='ssh'&&!item.page&&!item.ai?item:undefined})
const terminalNumbers=computed(()=>new Map(terminalGroups.value.flatMap(group=>{const ids=paneIds(group.layout);return terminals.value.filter(item=>ids.includes(item.sessionId)&&item.protocol==='ssh').map((item,index)=>[item.sessionId,index+1] as const)})))
const fileSources=ref<Record<string,string>>({}),fileLocateRequest=ref(0)
const paneLocatePulse=ref<{id:string;request:number}>()
const fileTargets=computed(()=>{const ids=activeGroup.value?paneIds(activeGroup.value.layout):[];return terminals.value.filter(item=>ids.includes(item.sessionId)&&item.protocol==='ssh').map(item=>({sessionId:item.sessionId,name:item.name,number:terminalNumbers.value.get(item.sessionId)??1,ready:item.status==='已连接'}))})
const fileTerminal=computed(()=>fileTargets.value.find(item=>item.sessionId===fileSources.value[activeGroup.value?.id??''])??fileTargets.value[0])
function locateFilePane(id:string){if(activeGroup.value){fileSources.value[activeGroup.value.id]=id;fileLocateRequest.value++;paneLocatePulse.value={id,request:fileLocateRequest.value}}}
watch(connectionState,state=>{if(state==='locked')fileEditors.value=[]})
function minimizeTerminal(id:string){if(minimized.value.has(id))minimized.value.delete(id);else minimized.value.add(id)}
function collapsedRail(id:string){const rect=geometry.value.panes.get(id);return minimized.value.has(id)&&!!rect&&rect.width<=36&&rect.height>36}
const workspaceSize = ref({width:0,height:0})
watch(workspaceArea,(area,_,cleanup)=>{
  if(!area)return
  let frame=0
  const observer=new ResizeObserver(([entry])=>{
    if(!entry)return
    cancelAnimationFrame(frame)
    frame=requestAnimationFrame(()=>{workspaceSize.value={width:entry.contentRect.width,height:entry.contentRect.height}})
  })
  observer.observe(area)
  cleanup(()=>{cancelAnimationFrame(frame);observer.disconnect()})
})
const geometry = computed(()=>layoutGeometry(activeGroup.value && filterLayout(activeGroup.value.layout,docked),workspaceSize.value.width,workspaceSize.value.height,minimized.value))
const workspaceTabs = computed(()=>terminalGroups.value.flatMap(group=>{
  const members=terminals.value.filter(item=>paneIds(group.layout).includes(item.sessionId))
  const first=members[0]
  if(!first||members.every(item=>item.page))return []
  const focused=members.find(item=>item.sessionId===group.focusedId)??first
  return [{sessionId:group.id,name:first.name,status:focused.status,protocol:first.protocol,floating:members.every(item=>item.floating||item.page),paneCount:members.length,ai:members.some(m=>m.ai),paneIds:paneIds(group.layout)}]
}))
const detaching = ref(new Set<string>())
const allWorkspaceTabs = computed(() => [...workspaceTabs.value, ...pluginTabs.map(tab => ({ sessionId: tab.key, name: tab.title, status: tab.status, protocol: 'plugin' as const, floating: false, paneCount: 1 }))])
const tabMenu = ref<{id:string;groupId?:string;x:number;y:number;owner?:Document}>()
const tabMenuExtension = menuBinding('builtin.sessions', 'workspace', () => { const item = terminals.value.find(item => item.sessionId === tabMenu.value?.id); return { sessionId: item?.sessionId ?? '', protocol: item?.protocol ?? '', groupId: tabMenu.value?.groupId ?? '' } }, () => !!tabMenu.value && terminals.value.some(item => item.sessionId === tabMenu.value?.id))
const splitPicker = ref<{id:string;direction:SplitDirection}>()
function otherPanes(id:string){const members=groupFor(id);const ids=members?paneIds(members.layout):[id];return terminals.value.filter(item=>item.protocol==='ssh'&&!item.page&&!ids.includes(item.sessionId))}
const splitCandidates = computed(()=>otherPanes(splitPicker.value?.id??''))
const tabMenuItems = computed(()=>{
  const item=terminals.value.find(item=>item.sessionId===tabMenu.value?.id)
  const group=item&&groupFor(item.sessionId)
  const multiple=!!group&&paneIds(group.layout).length>1
  const scoped=multiple&&tabMenu.value?.groupId
  return [
    {id:'reconnect',label:scoped?'重连当前终端':'重新连接',disabled:openingConnection.value||connectionState.value!=='ready'},
    {id:'configure',label:scoped?'当前终端配置…':'连接配置…',disabled:connectionState.value!=='ready'},
    ...(item?.protocol==='ssh'&&!item.page?[{id:'page',label:'移到独立页面',separator:true,disabled:detaching.value.has(item.sessionId)}]:[]),
    {id:item?.floating||item?.page?'dock':'float',label:item?.floating||item?.page?'收回工作区':'悬浮窗口'},
    ...(item?.protocol==='ssh'&&!item.page?[{id:'horizontal',label:'左右分屏',separator:true,disabled:openingConnection.value},{id:'vertical',label:'上下分屏',disabled:openingConnection.value},...(multiple?[{id:'unsplit',label:'移到单独标签'}]:[])]:[]),
    ...(multiple&&item&&!item.floating&&!item.page?[{id:'minimize',label:minimized.value.has(item.sessionId)?'还原终端':'最小化终端'}]:[]),
    {id:'close',label:scoped?'关闭整组终端':multiple?'关闭当前终端':'关闭',separator:true,danger:true},
  ]
})
function focusMain(){window.focus()}
function menuTerminal(id:string,event:MouseEvent){tabMenu.value={id,x:event.clientX,y:event.clientY,owner:(event.currentTarget as HTMLElement)?.ownerDocument}}
function menuGroup(id:string,event:MouseEvent){
  const group=terminalGroups.value.find(group=>group.id===id)
  if(!group)return
  const target=paneIds(group.layout).includes(group.focusedId)?group.focusedId:paneIds(group.layout)[0]!
  menuTerminal(target,event);tabMenu.value!.groupId=id
}
function configureTerminal(id:string){
  window.focus()
  const item=terminals.value.find(item=>item.sessionId===id)
  const server=servers.value.find(server=>server.id===item?.serverId)
  if(server)edit(server);else notify('这个服务器入口已被删除。')
}
function terminalTheme(id:string){const item=terminals.value.find(item=>item.sessionId===id);return servers.value.find(server=>server.id===item?.serverId)?.connections.find(connection=>connection.id===item?.connectionId)?.terminalThemeId}
function openTerminalColors(id?: string) {
  focusMain()
  requestPanelAction(() => {
    const item = terminals.value.find(item => item.sessionId === id)
    themeTarget.value = item ? { serverId: item.serverId, connectionId: item.connectionId } : undefined
    void showPanel(item ? 'terminalConnectionTheme' : 'terminalThemes')
  })
}
function inWorkspace(id:string){return geometry.value.panes.has(id)}
function rectStyle(rect:LayoutRect){return {left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'}}
function paneStyle(id:string){const rect=geometry.value.panes.get(id);return docked(id)&&rect?rectStyle(rect):undefined}
function hasPaneHeader(id:string){const group=groupFor(id);return !!group&&paneIds(group.layout).length>1}
function applySplit(second:string,picker=splitPicker.value){
  if(!picker)return
  try{
    terminalGroups.value=joinPane(terminalGroups.value,terminals.value.map(item=>({...item,detached:!!item.page})),picker.id,second,picker.direction,crypto.randomUUID())
    for(const item of terminals.value)if(item.sessionId===picker.id||item.sessionId===second)item.floating=false
    selectTerminal(picker.id);splitPicker.value=undefined
  }catch(cause){notify(cause instanceof Error?cause.message:'无法分屏')}
}
async function newSplit(picker=splitPicker.value){
  if(!picker || openingConnection.value)return
  const item=terminals.value.find(item=>item.sessionId===picker.id)
  const server=servers.value.find(server=>server.id===item?.serverId),connection=server?.connections.find(connection=>connection.id===item?.connectionId)
  if(!server||!connection)return
  await connect(server,connection,picker)
}
function startSplit(id:string,direction:SplitDirection){
  if(openingConnection.value)return
  const picker={id,direction}
  const candidates=otherPanes(id)
  if(candidates.length===1)applySplit(candidates[0]!.sessionId,picker)
  else if(!candidates.length)void newSplit(picker)
  else splitPicker.value=picker
}
function adjustSplit(id:string,ratio:number){if(activeGroup.value)setSplitRatio(activeGroup.value.layout,id,ratio)}
function resizeSplit(event:PointerEvent,handle:SplitHandle){
  if(!workspaceArea.value||event.button!==0)return
  event.preventDefault()
  const target=event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const move=(event:PointerEvent)=>{
    const current=geometry.value.handles.find(entry=>entry.branch.id===handle.branch.id),area=workspaceArea.value?.getBoundingClientRect()
    if(!current||!area)return
    const horizontal=current.branch.direction==='horizontal',bounds=current.bounds
    const offset=horizontal?event.clientX-area.left-bounds.left:event.clientY-area.top-bounds.top
    const size=horizontal?bounds.width:bounds.height
    adjustSplit(handle.branch.id,(offset-3)/Math.max(1,size-6)*100)
  }
  const end=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('lostpointercapture',end)}
  target.addEventListener('pointermove',move);target.addEventListener('pointerup',end);target.addEventListener('lostpointercapture',end)
}
async function reconnectTerminal(id:string){
  const item=terminals.value.find(item=>item.sessionId===id)
  const server=servers.value.find(server=>server.id===item?.serverId),connection=server?.connections.find(connection=>connection.id===item?.connectionId)
  if(!item||!server||!connection){notify('连接入口已删除，请重新配置。');return}
  if(item.ai){notify('AI 终端由任务管理，请在任务中重新建立连接。');return}
  if(openingConnection.value)return
  if(connection.type!==item.protocol||!opensInWorkspace(connection)){notify('入口的连接方式已变更，请从目录重新打开。');return}
  openingConnection.value=true
  try{
    if(item.status==='已结束'){
      const snapshot=await rpc<{sessions:{sessionId:string}[]}>('workspace.snapshot')
      if(snapshot.sessions.some(s=>s.sessionId===id)){
        const method=['ssh','local'].includes(item.protocol)?'sessions.attachTicket':['adb','wdb'].includes(item.protocol)?'devices.attachTicket':'desktops.attachTicket'
        const ticket=await rpc<{attachToken:string}>(method,{sessionId:id})
        item.attachToken=ticket.attachToken;item.status='正在恢复…';return
      }
    }
    // Explicit reconnect releases only this resource, leaving its workspace slot intact.
    await rpc(closeMethod(item.protocol),{sessionId:id},true)
    const opened=await rpc<{sessionId:string;attachToken:string}>('connections.open',{serverId:server.id,connectionId:connection.id},true)
    const index=terminals.value.indexOf(item)
    if(index<0){await rpc(closeMethod(item.protocol),{sessionId:opened.sessionId},true);return}
    previews.remove(id);previews.add(opened.sessionId,server.id,item.protocol)
    terminals.value[index]={...item,...opened,status:'连接中'}
    if(minimized.value.delete(id))minimized.value.add(opened.sessionId)
    for(const group of terminalGroups.value){group.layout=replacePane(group.layout,id,opened.sessionId);if(group.focusedId===id)group.focusedId=opened.sessionId}
    if(activeTerminal.value===id)activeTerminal.value=opened.sessionId
  }catch(cause){notify(cause instanceof Error?cause.message:'重连失败。')}
  finally{openingConnection.value=false}
}
async function detachTerminal(id:string){
  const item=terminals.value.find(item=>item.sessionId===id)
  if(!item || item.page || detaching.value.has(id))return
  detaching.value.add(id)
  let page:SessionPage|undefined
  try { page=await openSessionPage(item.name,()=>{const current=terminals.value.find(entry=>entry.page?.window===page?.window);if(current)dockTerminal(current.sessionId)}) }
  catch(cause){notify(cause instanceof Error?cause.message:'无法打开独立页面。');return}
  finally{detaching.value.delete(id)}
  if(!terminals.value.includes(item)){page?.dispose();return}
  if(!page){notify('浏览器拦截了独立页面，请允许弹出窗口后重试。');return}
  item.page=markRaw(page);item.floating=false;minimized.value.delete(id)
  if(activeTerminal.value===id)selectAvailable(groupFor(id)?.id)
}
function tabAction(action:string){
  const id=tabMenu.value?.id;if(!id)return
  if(action==='close'){if(tabMenu.value?.groupId)closeGroup(tabMenu.value.groupId);else closeTerminal(id)}
  else if(action==='reconnect')void reconnectTerminal(id)
  else if(action==='configure')configureTerminal(id)
  else if(action==='float')floatTerminal(id)
  else if(action==='dock')dockTerminal(id)
  else if(action==='page')detachTerminal(id)
  else if(action==='unsplit')separateTerminal(id)
  else if(action==='minimize')minimizeTerminal(id)
  else if(action==='horizontal'||action==='vertical')startSplit(id,action)
}
function closeSessionPages(){clearTimeout(workspaceSaveTimer);void saveWorkspace();for(const item of terminals.value)item.page?.dispose()}
window.addEventListener('pagehide',closeSessionPages)
function credentials(serverId:string, connectionId:string) { credentialTarget.value={serverId,connectionId};void openPanel('credentials') }
function showHistory(serverId:string) { historyServer.value=serverId;void openPanel('history') }
function selectAvailable(groupId?:string){
  const group=terminalGroups.value.find(group=>group.id===groupId)
  selectTerminal((group&&paneIds(group.layout).find(docked))??terminals.value.find(item=>docked(item.sessionId))?.sessionId??'')
}
function addTerminalGroup(id:string){terminalGroups.value.push({id:crypto.randomUUID(),layout:{kind:'pane',sessionId:id},focusedId:id})}
function separateTerminal(id:string){terminalGroups.value=removePane(terminalGroups.value,id);addTerminalGroup(id);dockTerminal(id)}
function closeGroup(id:string){
  if(pluginTabs.some(tab=>tab.key===id)){void closePluginTab(id);return}
  const group=terminalGroups.value.find(group=>group.id===id)
  if(group)for(const member of paneIds(group.layout))closeTerminal(member)
}
function closeTerminal(id:string, cancel=true) {
  minimized.value.delete(id)
  const item = terminals.value.find(item => item.sessionId === id)
  const groupId=groupFor(id)?.id
  if(item&&!item.ai&&cancel)void rpc(closeMethod(item.protocol),{sessionId:id},true).catch(cause=>notify(cause.message))
  if(item?.ai){dismissedAi.add(id);if(dismissedAi.size>128)dismissedAi.delete(dismissedAi.values().next().value!);if(cancel)void rpc('automation.close',{sessionId:id},true).catch(cause=>notify(cause.message))}
  item?.page?.dispose()
  previews.remove(id)
  terminalGroups.value=removePane(terminalGroups.value,id)
  terminals.value = terminals.value.filter(item => item.sessionId !== id)
  if (activeTerminal.value === id)selectAvailable(groupId)
  if(tabMenu.value?.id===id)tabMenu.value=undefined
  if(splitPicker.value?.id===id)splitPicker.value=undefined
}
function raiseTerminal(id: string) {
  previews.activate(id)
  const others = terminals.value.filter(item => item.floating && item.sessionId !== id).sort((a, b) => a.order - b.order)
  others.forEach((item, index) => { item.order = index + 1 })
  const target = terminals.value.find(item => item.sessionId === id)
  if (target) { target.order = others.length + 1; target.focusRequest++ }
}
function selectTerminal(id: string) {
  activePluginTab.value = ''
  previews.activate(id)
  const target = terminals.value.find(item => item.sessionId === id)
  const group=groupFor(id);if(group)group.focusedId=id
  if(target?.page){target.page.window.focus();return}
  if (target?.floating) raiseTerminal(id)
  else activeTerminal.value = id
}
function selectGroup(id:string){
  if(pluginTabs.some(tab=>tab.key===id)){activePluginTab.value=id;return}
  activePluginTab.value=''
  const group=terminalGroups.value.find(group=>group.id===id)
  if(!group){activeTerminal.value='';return}
  const ids=paneIds(group.layout)
  const target=docked(group.focusedId)?group.focusedId:ids.find(docked)??group.focusedId
  selectTerminal(target)
  const terminal=terminals.value.find(item=>item.sessionId===target)
  if(terminal&&!terminal.floating&&!terminal.page)terminal.focusRequest++
}
function floatTerminal(id: string) {
  const target = terminals.value.find(item => item.sessionId === id)
  if (!target) return
  target.floating = true
  minimized.value.delete(id)
  raiseTerminal(id)
  if (activeTerminal.value === id)selectAvailable(groupFor(id)?.id)
}
function dockTerminal(id: string) {
  const target = terminals.value.find(item => item.sessionId === id)
  if (!target) return
  const page=target.page; target.page=undefined
  if(page)void nextTick(()=>page.dispose())
  target.floating = false
  minimized.value.delete(id)
  selectTerminal(id)
}
function searchServers() {
  if (!activeTerminal.value && !activePluginTab.value) return
  activePluginTab.value = ''
  activeTerminal.value = ''
  selected.value = 'all'
  protocol.value = 'all'
  history.replaceState(null, '', location.pathname)
}
function closeMethod(protocol:string){return ['ssh','local'].includes(protocol)?'sessions.close':['adb','wdb'].includes(protocol)?'devices.close':'desktops.close'}
async function connect(server: Server, connection: Connection, splitTarget?:{id:string;direction:SplitDirection}) {
  if(openingConnection.value)return
  openingConnection.value=true
  try {
    const extension=connectorProvider(connection)
    if(extension?.open){await extension.open(server.id,connection.id);return}
    if(connection.type.startsWith('plugin:'))throw new Error('此入口的插件视图不可用，请在插件中心检查；配置已保留。')
    if(connection.type==='web') { previewConnection.value={server,connection};void openPanel('connection');return }
    if(connection.type==='ssh') {
      const credential=await rpc<{configured:boolean}>('credentials.describe',{serverId:server.id,connectionId:connection.id})
      if(!credential.configured){credentials(server.id,connection.id);return}
    }
    if(opensInWorkspace(connection) && (connection.type==='ssh'||connection.type==='rdp'||connection.type==='vnc'||connection.type==='local'||connection.type==='adb'||connection.type==='wdb')) {
      if(terminals.value.length>=8)throw new Error('请先关闭一个会话，最多保留 8 个会话（含分屏）。')
      const opened=await rpc<{sessionId:string;attachToken:string}>('connections.open',{serverId:server.id,connectionId:connection.id},true)
      // The user may close the parent tab while the new SSH connection is pending.
      if(splitTarget&&!terminals.value.some(item=>item.sessionId===splitTarget.id)){
        await rpc('sessions.close',{sessionId:opened.sessionId},true);return
      }
      previews.add(opened.sessionId,server.id,connection.type)
      terminals.value.push({...opened,name:`${server.name} · ${connection.name}`,serverId:server.id,connectionId:connection.id,protocol:connection.type,display:connection.rdpDisplay,status:'连接中',floating:false,order:0,focusRequest:0});activeTerminal.value=opened.sessionId
      addTerminalGroup(opened.sessionId)
      if(splitTarget)applySplit(opened.sessionId,splitTarget)
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
  if (event.key === 'Escape') { mobileOpen.value = false; hideNavigationPeek(); if (!panelDialog.value?.open) query.value = '' }
}
let stopBackend: (() => void) | undefined
onMounted(() => { window.addEventListener('keydown', keyboard); window.addEventListener('blur', hideNavigationPeek); stopBackend = startBackend() })
onBeforeUnmount(() => { closeSessionPages();window.removeEventListener('pagehide',closeSessionPages);stopBackend?.(); window.removeEventListener('keydown', keyboard); window.removeEventListener('blur', hideNavigationPeek); clearTimeout(toastTimer) })
</script>

<template>
  <div class="app-shell" @pointermove.capture="trackNavigationPointer" @pointerenter="trackNavigationPointer" @pointerleave="hideNavigationPeek" :class="{'navigation-collapsed':workspacePreferences.navigationClosed,'navigation-peek':navigationPeek}" :style="{'--sidebar-width':workspacePreferences.navigationClosed?'0px':workspacePreferences.navigationWidth+'px','--expanded-sidebar-width':workspacePreferences.navigationWidth+'px'}">
    <VaultUnlock />
    <RemoteEditorPanel />
    <RemoteFileEditor v-for="editor in fileEditors" :key="editor.id" :document="editor"/>
    <button v-if="mobileOpen" class="nav-scrim" aria-label="关闭导航" @click="mobileOpen = false"></button>
    <aside :inert="workspacePreferences.navigationClosed && !navigationPeek && !mobileOpen || undefined" :class="['sidebar', { 'mobile-open': mobileOpen }]" :style="{ '--page': appearance.settings.value.left.color }" :data-theme="appearance.sidebarDark.value ? 'dark' : 'light'" aria-label="工作空间导航">
      <img v-if="appearance.backgroundImages.value.left" class="region-background" :class="{'scene-background':appearance.settings.value.left.preset}" :src="appearance.backgroundImages.value.left" alt="" />
      <a href="#" class="brand" aria-label="WebNav · 返回工作台" title="WebNav · 返回工作台" @click.prevent="navigate('all')"><span class="brand-mark" aria-hidden="true"></span><strong>WebNav</strong></a>
      <button class="icon-button mobile-close" aria-label="收起导航" @click="mobileOpen = false"><PhX :size="21" /></button>
      <nav class="main-navigation">
        <p class="nav-label">工作空间</p>
        <button v-for="item in [{ id: 'all', name: '所有服务器', icon: PhHardDrives }, { id: 'favorites', name: '收藏夹', icon: PhStar }, { id: 'recent', name: '最近使用', icon: PhClock }]" :key="item.id" :class="['nav-item', { active: selected === item.id }]" :aria-current="selected === item.id ? 'page' : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="20" /><span>{{ item.name }}</span><small v-if="item.id === 'all' && catalogLoaded">{{ servers.length }}</small></button>
        <div class="nav-divider"></div>
        <div class="group-label"><p class="nav-label">服务器分组</p><button class="icon-button small" aria-label="管理分组" @click="manageGroups"><PhPlus :size="17" /></button></div>
        <button v-for="group in sidebarGroups" :key="group.id" :class="['nav-item', { active: selected === group.id }]" :style="{ paddingLeft: `${14 + group.depth * 14}px` }" :aria-current="selected === group.id ? 'page' : undefined" @click="navigate(group.id)"><PhFolderSimple :size="group.depth ? 17 : 20" /><span>{{ group.name }}</span><small>{{ groupCount(group.id) }}</small></button>
        <button v-if="servers.some(server => !server.groupId)" :class="['nav-item', { active: selected === '' }]" @click="navigate('')"><PhFolderSimple :size="20" /><span>未分组</span><small>{{ servers.filter(server => !server.groupId).length }}</small></button>
      </nav>
      <div class="sidebar-bottom"><p class="nav-label">工具</p><button v-for="tool in Object.values(pluginTools)" :key="tool.key" :class="['nav-item', { active: activePluginTab === tool.key }]" :disabled="connectionState !== 'ready'" @click="openPluginTool(tool.key)"><img v-if="tool.icon" :src="tool.icon" alt="" width="20" height="20" /><PhSquaresFour v-else :size="20" /><span>{{ tool.title }}</span></button><div class="nav-divider"></div><button :class="['nav-item', {active:selected==='@plugins'}]" @click="navigate('@plugins')"><PhSquaresFour :size="20"/><span>插件中心</span></button><button :class="['nav-item', { active: selected === 'manage' }]" @click="navigate('manage')"><PhGearSix :size="20" /><span>管理中心</span></button></div>
    </aside>
    <div v-if="!workspacePreferences.navigationClosed" class="navigation-resizer" role="separator" aria-label="调整导航宽度" aria-orientation="vertical" tabindex="0" :aria-valuenow="workspacePreferences.navigationWidth" aria-valuemin="164" aria-valuemax="400" @pointerdown="resizeNavigation" @keydown.left.prevent="workspacePreferences.navigationWidth=Math.max(164,workspacePreferences.navigationWidth-16)" @keydown.right.prevent="workspacePreferences.navigationWidth=Math.min(400,workspacePreferences.navigationWidth+16)" @dblclick="workspacePreferences.navigationWidth=232"></div>

    <div class="workspace" :class="{ 'has-terminal-tabs': terminals.length || pluginTabs.length, 'terminal-active': activeTerminal || activePluginTab }" :inert="mobileOpen || undefined">
      <div class="workspace-background" aria-hidden="true"><img v-if="appearance.backgroundImages.value.right" class="region-background" :class="{'scene-background':appearance.settings.value.right.preset}" :src="appearance.backgroundImages.value.right" alt="" /></div>
      <header class="topbar"><button class="icon-button navigation-toggle" :aria-label="workspacePreferences.navigationClosed?'固定展开导航':'收起导航'" :title="workspacePreferences.navigationClosed?'固定展开导航':'收起导航'" @click="toggleNavigation"><PhSidebarSimple :size="21" /></button><WorkspaceTabs v-if="allWorkspaceTabs.length" :terminals="allWorkspaceTabs" :active-id="activePluginTab || (activeGroup?.id ?? '')" :directory-name="pageName" @select="selectGroup" @close="closeGroup" @menu="menuGroup" /><div v-else class="breadcrumb"><span>工作空间</span><span class="breadcrumb-separator">/</span><strong>{{ pageName }}</strong></div><div class="topbar-actions"><template v-if="inspectorTerminal"><button class="icon-button inspector-toggle" :aria-pressed="workspacePreferences.systemOpen" aria-label="切换系统信息栏" title="系统信息" @click="workspacePreferences.systemOpen=!workspacePreferences.systemOpen"><PhCpu :size="20"/></button><button class="icon-button inspector-toggle" :aria-pressed="workspacePreferences.filesOpen" aria-label="切换文件栏" title="文件" @click="workspacePreferences.filesOpen=!workspacePreferences.filesOpen"><PhFolderOpen :size="20"/></button></template><label class="global-search"><PhMagnifyingGlass :size="19" /><input ref="searchInput" v-model="query" @input="searchServers" aria-label="搜索服务器、IP 或标签" placeholder="搜索服务器" /><button v-if="query" class="search-clear" aria-label="清空搜索" @click="query = ''"><PhX :size="14" /></button><kbd v-else>Ctrl K</kbd></label><button class="icon-button" aria-label="全局设置" title="全局设置" :disabled="connectionState !== 'ready'" @click="openPanel('vault')"><PhGearSix :size="21" /></button><button class="icon-button appearance-shortcut" aria-label="打开外观设置" title="外观设置" @click="openPanel('appearance')"><PhTShirt :size="21" /></button><span class="preview-label">{{ connectionState === 'ready' ? '本机' : '离线' }}</span></div></header>
      <main id="workspace-catalog" v-show="!activeTerminal && !activePluginTab" class="main-content" :role="terminals.length ? 'tabpanel' : undefined" :aria-labelledby="terminals.length ? 'workspace-tab-catalog' : undefined">
        <BackendStatus />
        <section v-if="selected!=='@plugins'" class="page-heading"><div><h1>{{ pageName }}<span v-if="selected !== 'manage' && catalogLoaded" class="heading-count">{{ filteredServers.length }}</span></h1></div><div v-if="selected !== 'manage'" class="heading-actions"><button class="button icon-only" title="管理分组" aria-label="管理分组" @click="manageGroups"><PhFolderSimple :size="20" /></button><button class="button primary icon-only" title="添加服务器" aria-label="添加服务器" :disabled="connectionState !== 'ready'" @click="edit()"><PhPlus :size="22" /></button></div></section>

        <div v-if="catalogLoaded" :inert="connectionState !== 'ready' || undefined">
        <component :is="pluginViews.bookmarks ?? WebBookmarks" v-if="selected === 'all' && !query" @notify="notify" />
        <section v-if="selected === 'all' && !query && favoriteServers.length" class="favorites-section" aria-labelledby="favorite-title"><div class="section-title"><h2 id="favorite-title">收藏夹</h2><span>{{ favoriteServers.length }}</span></div><div class="favorite-grid"><ServerItem v-for="server in favoriteServers" :key="server.id" :server="server" :group-name="groupName(server.groupId)" :preview-sessions="previews.forServer(server.id)" :last-frame="previews.lastFrames.value[server.id]" card @favorite="favorite" @connect="connect" @edit="edit" /></div></section>

        <PluginCenter v-if="selected === '@plugins'" /><ManagementPage v-else-if="selected === 'manage'" :servers="servers" :groups="groups" :query="query" :initial-tab="managementTab" @edit="edit" :commit="saveCatalog" @notify="notify" @clear-search="query = ''" />
        <section v-else class="directory-section" aria-labelledby="directory-title"><div class="directory-heading"><div class="section-title"><h2 id="directory-title">{{ query ? '搜索结果' : pageName === '所有服务器' || selected === 'manage' ? '全部服务器' : pageName }}</h2><span class="result-count">{{ filteredServers.length }}</span></div></div><div class="directory-toolbar"><div class="segmented protocol-filter" aria-label="按连接方式筛选"><button v-for="item in ['all', 'ssh', 'rdp', 'vnc', 'local', 'adb', 'wdb', 'web'] as const" :key="item" :class="{ active: protocol === item }" :aria-pressed="protocol === item" @click="protocol = item">{{ item === 'all' ? '全部' : protocolNames[item] }}</button></div><div class="toolbar-right"><div class="segmented view-toggle" aria-label="显示方式"><button :class="{ active: viewMode === 'list' }" :aria-pressed="viewMode === 'list'" aria-label="列表视图" @click="viewMode = 'list'"><PhList :size="18" /></button><button :class="{ active: viewMode === 'grid' }" :aria-pressed="viewMode === 'grid'" aria-label="卡片视图" @click="viewMode = 'grid'"><PhSquaresFour :size="18" /></button></div><label class="sort-select"><span class="visually-hidden">服务器排序</span><select v-model="sort"><option value="default">默认排序</option><option value="name">按名称排序</option><option value="group">按分组排序</option></select><PhCaretDown :size="13" /></label></div></div>
          <div v-if="filteredServers.length" :class="['server-directory', { 'grid-directory': viewMode === 'grid' }]"><div v-if="viewMode === 'list'" class="table-header"><span>服务器</span><span>所属分组</span><span>连接方式</span><span class="visually-hidden">操作</span></div><ServerItem v-for="server in filteredServers" :key="server.id" :server="server" :group-name="groupName(server.groupId)" :preview-sessions="previews.forServer(server.id)" :last-frame="previews.lastFrames.value[server.id]" :card="viewMode === 'grid'" @favorite="favorite" @connect="connect" @edit="edit" /><p v-if="viewMode === 'grid'" class="grid-edit-hint"><PhSlidersHorizontal :size="15" />编辑配置请切换列表视图。</p></div>
          <div v-else class="empty-state"><PhMagnifyingGlass v-if="query" :size="36" /><PhStar v-else-if="selected === 'favorites'" :size="36" /><PhClock v-else-if="selected === 'recent'" :size="36" /><PhFolderSimple v-else :size="36" /><h3>{{ query ? '没有找到匹配的服务器' : selected === 'favorites' ? '收藏夹还是空的' : selected === 'recent' ? '还没有最近使用记录' : !servers.length ? '还没有服务器' : '这个分组还没有服务器' }}</h3><p>{{ query ? '试试名称、IP、标签或分组名称。' : selected === 'favorites' ? '点击服务器的星标，即可加入收藏夹。' : selected === 'recent' ? '打开一个连接预览后，会显示在这里。' : '添加服务器，或切换其他筛选条件。' }}</p><button v-if="!servers.length" class="button" @click="navigate('manage')">打开管理中心</button><button v-else class="button" @click="navigate('all')">查看全部服务器<PhArrowRight :size="16" /></button></div>
        </section>
        </div><section v-else class="empty-state catalog-pending" role="status"><PhHardDrives :size="36" /><h3>目录尚未加载</h3><p>连接本地服务后，才会读取已保存的服务器和分组。</p></section><footer class="workspace-footer"><span><kbd>Ctrl K</kbd>快速搜索</span><span>{{ saving ? '正在保存…' : connectionState === 'ready' ? '本机数据库' : '服务未连接' }}</span></footer>
      </main>
      <PluginWorkspacePage v-for="tab in pluginTabs" :key="tab.key" v-show="activePluginTab === tab.key" :tab="tab" :active="activePluginTab === tab.key" />
      <div v-if="terminals.length" class="session-workbench" :class="{idle:!activeTerminal}">
        <div v-if="inspectorTerminal && workspacePreferences.systemOpen" class="system-dock" :style="{'--system-width':workspacePreferences.systemWidth+'px'}">
          <component :is="pluginViews.system ?? SshSystemPanel" :session-id="inspectorTerminal.sessionId" :name="inspectorTerminal.name" :host="servers.find(server=>server.id===inspectorTerminal?.serverId)?.host??''" :ready="inspectorTerminal.status==='已连接'" @close="workspacePreferences.systemOpen=false"/>
          <div class="system-resizer" role="separator" aria-label="调整系统信息栏宽度" title="拖动调整宽度，双击恢复默认" aria-orientation="vertical" tabindex="0" :aria-valuenow="workspacePreferences.systemWidth" aria-valuemin="200" aria-valuemax="420" @pointerdown="resizeSystemPanel" @keydown.left.prevent="workspacePreferences.systemWidth=Math.max(200,workspacePreferences.systemWidth-16)" @keydown.right.prevent="workspacePreferences.systemWidth=Math.min(420,workspacePreferences.systemWidth+16)" @dblclick="workspacePreferences.systemWidth=260"></div>
        </div>
        <div class="session-main">
      <section ref="workspaceArea" v-if="terminals.length" class="terminal-workspace" :class="{ idle: !activeTerminal }" aria-label="连接工作区">
        <div v-for="tab in workspaceTabs" :key="tab.sessionId" :id="'workspace-panel-'+tab.sessionId" v-show="activeGroup?.id===tab.sessionId" class="workspace-group-panel" role="tabpanel" :aria-labelledby="'workspace-tab-'+tab.sessionId" :aria-owns="tab.paneIds.map(id=>'terminal-pane-'+id).join(' ')"></div>
        <Teleport v-for="item in terminals" :key="item.sessionId" :to="item.page?.mount ?? workspaceArea" :disabled="!item.page"><TerminalWindow :ai="item.ai" :locate-request="paneLocatePulse?.id===item.sessionId?paneLocatePulse.request:0" :pane-number="terminalNumbers.get(item.sessionId)" :style="paneStyle(item.sessionId)" :theme-id="terminalTheme(item.sessionId)" :detached="!!item.page" :owner-document="item.page?.window.document" :split="hasPaneHeader(item.sessionId)||minimized.has(item.sessionId)" :minimized="minimized.has(item.sessionId)" :collapsed-rail="collapsedRail(item.sessionId)" @minimize="minimizeTerminal(item.sessionId)" :focused="activeTerminal===item.sessionId" :session-id="item.sessionId" :attach-token="item.attachToken" :protocol="item.protocol" :display="item.display" @running="previews.running(item.sessionId, $event)" @frame="previewFrame(item.sessionId, item.serverId, $event)" :name="item.name" :active="inWorkspace(item.sessionId)" :floating="item.floating" :order="item.order" :focus-request="item.focusRequest" @status="item.status = $event" @history="focusMain();showHistory(item.serverId)" @reconnect="reconnectTerminal(item.sessionId)" @configure="configureTerminal(item.sessionId)" @colors="openTerminalColors(item.sessionId)" @select="!item.page && selectTerminal(item.sessionId)" @menu="menuTerminal(item.sessionId,$event)" @float="floatTerminal(item.sessionId)" @dock="dockTerminal(item.sessionId)" @close="closeTerminal(item.sessionId)" @raise="raiseTerminal(item.sessionId)" /></Teleport>
        <div v-for="handle in geometry.handles" :key="handle.branch.id" class="terminal-split-handle" :class="handle.branch.direction" :style="rectStyle(handle)" tabindex="0" role="separator" :aria-orientation="handle.branch.direction === 'horizontal' ? 'vertical' : 'horizontal'" aria-label="调整终端分屏大小" :aria-valuenow="Math.round(handle.branch.ratio)" aria-valuemin="20" aria-valuemax="80" @pointerdown="resizeSplit($event,handle)" @keydown.left.prevent="adjustSplit(handle.branch.id,handle.branch.ratio-5)" @keydown.right.prevent="adjustSplit(handle.branch.id,handle.branch.ratio+5)" @keydown.up.prevent="adjustSplit(handle.branch.id,handle.branch.ratio-5)" @keydown.down.prevent="adjustSplit(handle.branch.id,handle.branch.ratio+5)" @dblclick="adjustSplit(handle.branch.id,50)"></div>
      </section>
          <div v-if="inspectorTerminal && fileTerminal && workspacePreferences.filesOpen" class="files-dock" :style="{height:workspacePreferences.filesHeight+'px'}"><div class="files-resizer" role="separator" aria-label="调整文件栏高度" aria-orientation="horizontal" tabindex="0" :aria-valuenow="workspacePreferences.filesHeight" aria-valuemin="140" aria-valuemax="420" @pointerdown="resizeFiles" @keydown.up.prevent="workspacePreferences.filesHeight=Math.min(420,workspacePreferences.filesHeight+16)" @keydown.down.prevent="workspacePreferences.filesHeight=Math.max(140,workspacePreferences.filesHeight-16)"></div><component :is="pluginViews.files ?? SshFilesPanel" :session-id="fileTerminal.sessionId" :name="fileTerminal.name" :ready="fileTerminal.ready" :targets="fileTargets" :locate-request="fileLocateRequest" @locate="locateFilePane" @close="workspacePreferences.filesOpen=false"/></div>
        </div>
      </div>
    </div>

    <ContextMenu v-if="tabMenu" :key="tabMenu.id+(tabMenu.groupId??'')" :owner="tabMenu.owner" :x="tabMenu.x" :y="tabMenu.y" :items="tabMenuItems" label="标签右键菜单" :extension="tabMenuExtension" :execute="tabAction" @close="tabMenu=undefined" />
    <TerminalSplitPicker v-if="splitPicker" :direction="splitPicker.direction" :candidates="splitCandidates" :busy="openingConnection || connectionState !== 'ready'" @close="splitPicker=undefined" @select="applySplit" @create="newSplit" />
    <dialog aria-labelledby="panel-title"  ref="panelDialog" :class="['panel-dialog', { 'connection-dialog': panel === 'connection', 'history-dialog': panel === 'history', 'terminal-themes-dialog':['terminalThemes', 'terminalConnectionTheme'].includes(panel) }]" v-on="backdropEvents" @cancel.prevent="closePanel"><div class="panel-shell"><header class="panel-header"><div><span class="panel-kicker">{{ panel === 'appearance' ? '外观设置' : panel === 'connection' ? 'WebNav' : '管理中心' }}</span><h2 id="panel-title">{{ dialogTitle }}</h2></div><button class="icon-button" aria-label="关闭面板" :disabled="editorBusy || themeEditor?.busy" @click="closePanel"><PhX :size="22" /></button></header><div class="panel-body" :class="{ 'editor-panel-body': panel === 'editor' }">
      <AppearancePanel v-if="panel === 'appearance'" :appearance="appearance" />

      <ServerEditor v-else-if="panel === 'editor'" ref="editor" :key="editorRevision" :server="editingServer" :groups="groups" :initial-group-id="editorGroupId" :save-error="editorSaveError" :busy="editorBusy" @save="saveServer" @cancel="closePanel" @remove="deleteServer" @credentials="credentials" @history="showHistory" />

      <template v-else-if="panel === 'vault'"><button class="button settings-section-link" @click="openTerminalColors()">终端配色 <span>默认配色、自定义方案 →</span></button><button class="button settings-section-link" @click="openCapabilitySettings('service:configSync')">配置同步 <span>GitHub / Gitee 加密同步 →</span></button><button class="button settings-section-link" @click="openPanel('browserExtension')">浏览器自动填写 <span>配对浏览器、管理网站授权 →</span></button><button class="button settings-section-link" @click="openCapabilitySettings('extension:mcp')">AI 接入 <span>MCP、授权与任务 →</span></button><button class="button settings-section-link" @click="openPanel('updates')">工作台更新 <span>检查版本、下载与安装 →</span></button><VaultPanel /></template>
      <UpdatePanel v-else-if="panel === 'updates'" @back="openPanel('vault')" />
      <BrowserExtensionPanel v-else-if="panel === 'browserExtension'" @back="openPanel('vault')" />
      <TerminalConnectionThemePanel v-else-if="panel === 'terminalConnectionTheme' && themeTarget" ref="themeEditor" :server-id="themeTarget.serverId" :connection-id="themeTarget.connectionId" @manage="openPanel('terminalThemes')" />
      <component :is="pluginViews.themes ?? TerminalThemesPanel" v-else-if="panel === 'terminalThemes'" ref="themeEditor" :connection-context="!!themeTarget" @back="openPanel(themeTarget ? 'terminalConnectionTheme' : 'vault')" />
      <CredentialPanel v-else-if="panel === 'credentials' && credentialTarget" :key="credentialTarget.serverId + credentialTarget.connectionId" :server-id="credentialTarget.serverId" :connection-id="credentialTarget.connectionId" @saved="closePanel(); notify('认证信息已保存。')" />
      <component :is="pluginViews.history ?? HistoryPanel" v-else-if="panel === 'history'" :key="historyServer" :server-id="historyServer" />
      <div v-else-if="panel === 'connection' && previewConnection" class="connection-preview"><span class="connection-preview-icon"><PhTerminalWindow v-if="previewConnection.connection.type === 'ssh'" :size="35" /><PhDesktop v-else-if="previewConnection.connection.type === 'rdp'" :size="35" /><PhGlobeHemisphereWest v-else :size="35" /></span><h3>{{ previewConnection.server.name }}</h3><p class="server-address">{{ previewConnection.connection.type === 'web' ? previewConnection.connection.url : `${previewConnection.server.host}:${previewConnection.connection.port}` }}</p><div class="connection-summary"><span>连接类型<strong>{{ protocolNames[previewConnection.connection.type] }}</strong></span><span v-if="previewConnection.connection.username">用户名<strong>{{ previewConnection.connection.username }}</strong></span><span>当前状态<strong>尚未连接</strong></span></div><a v-if="previewConnection.connection.type === 'web'" class="button primary" :href="previewConnection.connection.url" target="_blank" rel="noopener noreferrer">打开网页</a><button class="button" @click="closePanel">返回工作台</button></div>
    </div></div></dialog>
    <dialog ref="unsavedDialog" class="management-dialog unsaved-dialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-description" @cancel.prevent="continueEditing">
      <header><h2 id="unsaved-title">保存修改？</h2><button class="icon-button" aria-label="继续编辑" title="继续编辑" @click="continueEditing"><PhX :size="20" /></button></header>
      <p id="unsaved-description">有未保存的修改。</p>
      <div class="unsaved-actions">
        <button type="button" class="button" autofocus @click="continueEditing">继续编辑</button>
        <button type="button" class="button" @click="discardAndLeave">不保存</button>
        <button type="button" class="button primary" @click="saveAndLeave"><PhCheck :size="17" />保存</button>
      </div>
    </dialog>
    <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><PhCheck :size="17" />{{ toast }}</div></Transition>
  </div>
</template>
