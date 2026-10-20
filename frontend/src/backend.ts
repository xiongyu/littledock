import { ref } from 'vue'
import { parseCatalogImport, type Group, type Server } from '@webnav/shared'

export const groups = ref<Group[]>([])
export const servers = ref<Server[]>([])
export const catalogLoaded = ref(false)
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
let retry: ReturnType<typeof setTimeout> | undefined
function object(input: unknown): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('服务响应格式不正确。'); return input as Record<string, unknown> }
function snapshot(input: unknown) {
  const data = object(input)
  if (!Number.isSafeInteger(data.revision)) throw new Error('目录版本无效。')
  const version = data.revision as number
  if (version < revision) return
  const catalog = parseCatalogImport(data.snapshot)
  revision = version; groups.value = catalog.groups; servers.value = catalog.servers; catalogLoaded.value = true
}
export function rpc<T>(method: string, params: Record<string, unknown> = {}, mutate = false): Promise<T> {
  if (socket?.readyState !== WebSocket.OPEN || !epoch) return Promise.reject(new Error('本地服务尚未连接。'))
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(mutate ? '未收到结果，操作可能已经保存。请同步目录后核对，不要连续重试。' : '请求超时，请重试。')) }, 30_000)
    pending.set(id, { resolve: value => resolve(value as T), reject, timer })
    socket!.send(JSON.stringify({ v: 1, type: 'request', epoch, id, method, params, ...(mutate ? { operationId: crypto.randomUUID() } : {}) }))
  })
}
export async function synchronize() {
  const result = await rpc<unknown>('catalog.watch'); const data = object(result)
  if (data.epoch !== epoch || typeof data.subscriptionId !== 'string') throw new Error('目录订阅无效。')
  if (!vaultStatus.value?.unlocked) return
  subscription = data.subscriptionId; snapshot(result); connectionState.value = 'ready'; backendError.value = ''
}
function applyVault(input: unknown) {
  const data = object(input)
  if (!['local', 'master'].includes(String(data.mode)) || typeof data.unlocked !== 'boolean' || !Number.isSafeInteger(data.unlockMinutes) || (data.expiresAt !== null && typeof data.expiresAt !== 'number')) throw new Error('全局设置响应无效。')
  vaultStatus.value = data as unknown as VaultStatus
  if (!data.unlocked) { connectionState.value = 'locked'; backendError.value = '' }
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
export async function saveCatalog(nextGroups: Group[], nextServers: Server[], rdpPasswords: RdpPasswordUpdate[] = []) {
  if (saving.value) throw new Error('上一项保存尚未完成。')
  const catalog = parseCatalogImport({ schemaVersion: 1, groups: nextGroups, servers: nextServers })
  saving.value = true
  try { snapshot(await rpc('catalog.replace', { catalog, expectedRevision: revision, ...(rdpPasswords.length ? { rdpPasswords } : {}) }, true)) }
  catch (cause) { void synchronize().catch(() => {}); throw cause }
  finally { saving.value = false }
}
export function startBackend() {
  stopped = false
  let refreshPageSession = false
  async function connect() {
    if (stopped) return
    connectionState.value = 'connecting'; epoch = ''; subscription = ''; revision = -1
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
          if (typeof message.epoch !== 'string') throw new Error('服务握手无效。')
          receivedHello = true; refreshPageSession = false
          epoch = message.epoch
          if (message.authorized) void initialize().catch(cause => { backendError.value = String(cause.message) })
          else { backendError.value = '请重启本地服务以更新连接流程。'; socket?.close() }
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
            task.reject(Object.assign(new Error(String(error.message ?? '请求失败。')), { code: error.code }))
          }
        } else if (message.type === 'event' && message.event === 'vault.changed' && message.epoch === epoch) {
          const wasLocked = connectionState.value === 'locked'
          applyVault(message.status)
          if (wasLocked && vaultStatus.value?.unlocked) void synchronize().catch(cause => { backendError.value = cause.message })
        } else if (message.type === 'event' && message.event === 'catalog.changed' && message.epoch === epoch && message.subscriptionId === subscription) {
          // Each event contains the entire committed snapshot, including skipped versions.
          if (vaultStatus.value?.unlocked) snapshot(message)
        }
      } catch (cause) { backendError.value = cause instanceof Error ? cause.message : '无法读取服务响应。' }
    }
    socket.onclose = () => {
      refreshPageSession = !receivedHello
      connectionState.value = 'offline'; epoch = ''
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('连接中断；写入结果可能未知，重连后请核对。')) }
      pending.clear()
      if (!stopped) retry = setTimeout(connect, 3000)
    }
    socket.onerror = () => socket?.close()
  }
  connect()
  return () => { stopped = true; clearTimeout(retry); socket?.close() }
}
