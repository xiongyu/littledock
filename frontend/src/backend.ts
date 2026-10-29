
import { pluginI18n, renderMessage } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import { defaultTerminalThemes, parseTerminalThemes } from '@webnav/shared'
import type { SyncStatus } from '@webnav/shared'
import { ref } from 'vue'
import type { AutomationTaskView } from '@webnav/shared'
import { parseWorkspaceSnapshot, type WorkspaceSnapshot } from '@webnav/shared'
export const workspaceSnapshot=ref<WorkspaceSnapshot>()
export const automationTasks=ref<AutomationTaskView[]>([])
import { loadPlugins, pluginState } from './plugins'
import { parseCatalogImport, parseBookmarkSnapshot, type BookmarkSnapshot, type Group, type Server, type WebBookmark } from '@webnav/shared'

export const terminalThemes = ref(defaultTerminalThemes())
export const configSyncStatus = ref<SyncStatus>()
let themeSubscription = ''
let pluginSubscription = ''
export const groups = ref<Group[]>([])
export const servers = ref<Server[]>([])
export const catalogLoaded = ref(false)
export const bookmarks = ref<WebBookmark[]>([])
export const bookmarksLoaded = ref(false)
export const bookmarksError = ref('')
export const connectionState = ref<'connecting' | 'offline' | 'locked' | 'ready'>('connecting')
export interface VaultStatus { configured: boolean; mode: 'local' | 'master'; unlocked: boolean; unlockMinutes: number; expiresAt: number | null }
export const vaultStatus = ref<VaultStatus>()
export const backendError = ref('')
export const saving = ref(false)
export const backendOrigin = import.meta.env.VITE_WEBNAV_BACKEND_ORIGIN || location.origin
export const wsOrigin = backendOrigin.replace(/^http/, 'ws')
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>()
let socket: WebSocket | undefined, epoch = '', revision = -1, subscription = '', stopped = false
let bookmarkSubscription = '', bookmarkRevision = -1
let automationRevision = -1
let retry: ReturnType<typeof setTimeout> | undefined
function object(input: unknown): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(i18nT('m01049b6ccd2e')); return input as Record<string, unknown> }
function snapshot(input: unknown) {
  const data = object(input)
  if (!Number.isSafeInteger(data.revision)) throw new Error(i18nT('md917683b3169'))
  const version = data.revision as number
  if (version < revision) return
  const catalog = parseCatalogImport(data.snapshot)
  revision = version; groups.value = catalog.groups; servers.value = catalog.servers; catalogLoaded.value = true
}
function applyAutomation(input:unknown){
  const data=object(input)
  if(data.epoch!==epoch||!vaultStatus.value?.unlocked)return
  if(!Number.isSafeInteger(data.revision)||Number(data.revision)<0||!Array.isArray(data.tasks)||data.tasks.length>32)throw new Error(i18nT('m250905d5cd5c'))
  if(Number(data.revision)<automationRevision)return
  const tasks=data.tasks.map(value=>{
    const task=object(value)
    for(const key of ['id','sessionId','clientName','name','serverId','connectionId','message'])if(typeof task[key]!=='string'||String(task[key]).length>4096)throw new Error(i18nT('mb60da2f82cc4'))
    for(const key of ['createdAt','expiresAt','controlEpoch'])if(!Number.isSafeInteger(task[key])||Number(task[key])<1)throw new Error(i18nT('m2a9a2e216bb3'))
    if(typeof task.connected!=='boolean'||!['ai','user','none'].includes(String(task.controller))||!['running','waiting_user','finishing','succeeded','failed','cancelling','cancelled','interrupted'].includes(String(task.state)))throw new Error(i18nT('m20e371aec39d'))
    return task as unknown as AutomationTaskView
  })
  automationRevision=Number(data.revision);automationTasks.value=tasks
}
export function rpc<T>(method: string, params: Record<string, unknown> = {}, mutate = false, timeoutMs = 30_000): Promise<T> {
  if (socket?.readyState !== WebSocket.OPEN || !epoch) return Promise.reject(new Error(i18nT('m254952718516')))
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(mutate ? i18nT('m6789ce053819') : i18nT('mc90cdb0cfc21'))) }, timeoutMs)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    socket!.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, ...(mutate ? { operationId: crypto.randomUUID() } : {}) }))
  })
}
export async function synchronize() {
  const pluginWatch = await rpc<{subscriptionId:string;epoch:string;state:import('@webnav/shared').PluginState}>('plugins.watch')
  if(pluginWatch.epoch !== epoch)return
  pluginSubscription=pluginWatch.subscriptionId;pluginState.value=pluginWatch.state
  void loadPlugins().catch(cause => { backendError.value = cause instanceof Error ? cause.message : i18nT('m085be4c893be') })
  const result = await rpc<unknown>('catalog.watch'); const data = object(result)
  if (data.epoch !== epoch || typeof data.subscriptionId !== 'string') throw new Error(i18nT('m0134b370ed13'))
  if (!vaultStatus.value?.unlocked) return
  subscription = data.subscriptionId; snapshot(result); connectionState.value = 'ready'; backendError.value = ''
  const themes = await rpc<Record<string, unknown>>('terminalThemes.watch')
  if (themes.epoch === epoch && vaultStatus.value?.unlocked) {
    themeSubscription = String(themes.subscriptionId)
    terminalThemes.value = parseTerminalThemes({ revision: themes.revision, defaultId: themes.defaultId, themes: themes.themes })
  }
  await synchronizeBookmarks()
  applyAutomation(await rpc('automation.watch'))
  const workspace=parseWorkspaceSnapshot(await rpc('workspace.snapshot'))
  if(workspace.epoch===epoch&&vaultStatus.value?.unlocked)workspaceSnapshot.value=workspace
}
export function applyBookmarks(input: unknown) {
  const result = parseBookmarkSnapshot(input)
  if (result.revision < bookmarkRevision) return
  bookmarkRevision = result.revision; bookmarks.value = result.bookmarks; bookmarksLoaded.value = true; bookmarksError.value = ''
}
export async function synchronizeBookmarks() {
  try {
    const result = await rpc<BookmarkSnapshot & { subscriptionId: string; epoch: string }>('bookmarks.watch')
    if (result.epoch !== epoch || !vaultStatus.value?.unlocked) return
    if (typeof result.subscriptionId !== 'string') throw new Error(i18nT('me63f52b38fa8'))
    bookmarkSubscription = result.subscriptionId; applyBookmarks(result)
  } catch (cause) { bookmarksError.value = cause instanceof Error ? cause.message : i18nT('mce9e7592e0fb') }
}
function applyVault(input: unknown) {
  const data = object(input)
  if (!['local', 'master'].includes(String(data.mode)) || typeof data.unlocked !== 'boolean' || !Number.isSafeInteger(data.unlockMinutes) || (data.expiresAt !== null && typeof data.expiresAt !== 'number')) throw new Error(i18nT('m12b5ed1cab2c'))
  vaultStatus.value = data as unknown as VaultStatus
  if (!data.unlocked) { connectionState.value = 'locked'; backendError.value = ''; if(configSyncStatus.value)configSyncStatus.value={...configSyncStatus.value,unlocked:false,expiresAt:null} }
}
async function initialize() {
  applyVault(await rpc('vault.watch'))
  if (vaultStatus.value?.unlocked) await synchronize()
}
export async function updateVault(params: Record<string, unknown>) {
  await rpc('vault.update', params, true)
  applyVault(await rpc('vault.status'))
}
export async function unlockVault(password: string) {
  await rpc('vault.unlock', { password }, true)
  applyVault(await rpc('vault.status'))
}
export type RdpPasswordUpdate = { serverId: string; connectionId: string; secret: string | null }
export type DesktopPasswordUpdate = RdpPasswordUpdate
export async function saveCatalog(nextGroups: Group[], nextServers: Server[], rdpPasswords: RdpPasswordUpdate[] = []) {
  if (saving.value) throw new Error(i18nT('m394e0352a14b'))
  const catalog = parseCatalogImport({ schemaVersion: 1, groups: nextGroups, servers: nextServers })
  saving.value = true
    try { snapshot(await rpc('catalog.replace', { catalog, expectedRevision: revision, ...(rdpPasswords.length ? { desktopPasswords: rdpPasswords } : {}) }, true)) }
  catch (cause) { void synchronize().catch(() => {}); throw cause }
  finally { saving.value = false }
}
export function startBackend() {
  stopped = false
  let refreshPageSession = false
  async function connect() {
    if (stopped) return
    connectionState.value = 'connecting'; epoch = ''; subscription = ''; revision = -1; bookmarkSubscription = ''; bookmarkRevision = -1; automationRevision = -1
    // Repair a missing/expired HttpOnly cookie through the page response, not a REST API.
    if (refreshPageSession) {
      try {
        const page = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(3000) })
        await page.body?.cancel()
      } catch { /* The WS retry below provides the normal offline state. */ }
      if (stopped) return
    }
    let receivedHello = false
    socket = new WebSocket(wsOrigin + '/ws')
    socket.onmessage = event => {
      try {
        const message = object(JSON.parse(String(event.data)))
        if (message.type === 'hello') {
          if (typeof message.epoch !== 'string') throw new Error(i18nT('m2a23c54d86c8'))
          receivedHello = true; refreshPageSession = false
          epoch = message.epoch
          if (message.authorized) void initialize().catch(cause => { backendError.value = String(cause.message) })
          else { backendError.value = i18nT('m35c00f2b91fb'); socket?.close() }
        } else if (message.type === 'response') {
          const task = pending.get(String(message.id)); if (!task) return
          pending.delete(String(message.id)); clearTimeout(task.timer)
          if (message.ok) task.resolve(message.result)
          else {
            const error = object(message.error)
            if (error.code === 'VAULT_LOCKED') {
              connectionState.value = 'locked'
              if (vaultStatus.value) vaultStatus.value = { ...vaultStatus.value, unlocked: false, expiresAt: null }
            }
            if (error.code === 'UNAUTHORIZED') socket?.close()
            task.reject(Object.assign(new Error(renderMessage(error.messageRef, String(error.message ?? i18nT('m0755d81df3ff')))), { code: error.code, messageRef: error.messageRef }))
          }
        } else if (message.type === 'event' && message.event === 'automation.changed' && message.epoch === epoch) {
          applyAutomation(message)
        } else if (message.type === 'event' && message.event === 'vault.changed' && message.epoch === epoch) {
          const wasLocked = connectionState.value === 'locked'
          applyVault(message.status)
          if (wasLocked && vaultStatus.value?.unlocked) void synchronize().catch(cause => { backendError.value = cause.message })
        } else if (message.type === 'event' && message.event === 'plugins.changed' && message.epoch === epoch && message.subscriptionId === pluginSubscription) {
          if(vaultStatus.value?.unlocked)void loadPlugins().catch(cause=>{backendError.value=cause.message})
        } else if (message.type === 'event' && message.event === 'configSync.changed' && message.epoch === epoch) {
          if(vaultStatus.value?.unlocked)configSyncStatus.value=message.status as SyncStatus
        } else if (message.type === 'event' && message.event === 'terminalThemes.changed' && message.epoch === epoch && message.subscriptionId === themeSubscription) {
          if (vaultStatus.value?.unlocked && Number(message.revision) >= terminalThemes.value.revision) terminalThemes.value = parseTerminalThemes({ revision: message.revision, defaultId: message.defaultId, themes: message.themes })
        } else if (message.type === 'event' && message.event === 'catalog.changed' && message.epoch === epoch && message.subscriptionId === subscription) {
          // Each event contains the entire committed snapshot, including skipped versions.
          if (vaultStatus.value?.unlocked) snapshot(message)
        } else if (message.type === 'event' && message.event === 'bookmarks.changed' && message.epoch === epoch && message.subscriptionId === bookmarkSubscription) {
          if (vaultStatus.value?.unlocked) applyBookmarks(message)
        }
      } catch (cause) { backendError.value = cause instanceof Error ? cause.message : i18nT('m8bd4962d9376') }
    }
    socket.onclose = () => {
      refreshPageSession = !receivedHello
      connectionState.value = 'offline'; epoch = ''
      if(configSyncStatus.value)configSyncStatus.value={...configSyncStatus.value,unlocked:false,expiresAt:null}
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(i18nT('m1abbffc3fb58'))) }
      pending.clear()
      if (!stopped) retry = setTimeout(connect, 3000)
    }
    socket.onerror = () => socket?.close()
  }
  connect()
  return () => { stopped = true; clearTimeout(retry); socket?.close() }
}
