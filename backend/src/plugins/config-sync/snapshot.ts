import type { Context } from 'cordis'
import { builtInTerminalThemes, parseCatalogImport, parseTerminalThemes, validateBookmark, type CatalogDocument, type Connection, type SyncChange, type SyncChoice, type SyncSettings } from '@webnav/shared'
import { AppError, record, string } from '../../core/errors.ts'
import { credentialKey } from '../storage.ts'
import { digest, MAX_PLAIN } from './crypto.ts'

export interface SyncSecret { id: string; kind: 'password' | 'key' | 'web-login'; secret: string }
export interface PluginReference { id: string; repository: string; commit: string }
export interface PortableSnapshot {
  version: 1
  catalog: CatalogDocument
  bookmarks: { id: string; name: string; url: string }[]
  themes: { defaultId: string; themes: ReturnType<typeof parseTerminalThemes>['themes'] }
  secrets: SyncSecret[] | null
  plugins: PluginReference[] | null
}
export interface Payload { version: 1; operationId: string; ancestors: string[]; snapshot: PortableSnapshot }
export const canonical = (value: unknown): string => JSON.stringify(normalize(value))
function normalize(value: unknown): unknown { if (Array.isArray(value)) return value.map(normalize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)])); return value }
export function portableConnection(connection: Connection): Connection {
  const next = structuredClone(connection)
  if (next.type.startsWith('plugin:') || (next.providerId && next.providerId !== 'builtin')) delete next.pluginSettings
  else if (next.pluginSettings) { if (next.type === 'local') delete next.pluginSettings.cwd; if (next.type === 'adb') delete next.pluginSettings.serial }
  return next
}
export function parseSnapshot(input: unknown): PortableSnapshot {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_PLAIN) throw new AppError('LIMIT', '同步快照过大。')
  const p = record(input)
  if (p.version !== 1 || Object.keys(p).sort().join() !== 'bookmarks,catalog,plugins,secrets,themes,version') throw new AppError('SYNC_FORMAT', '不支持此同步配置版本。')
  const catalog = parseCatalogImport(p.catalog)
  for (const server of catalog.servers) for (const c of server.connections) if (canonical(c) !== canonical(portableConnection(c))) throw new AppError('SYNC_FORMAT', '同步快照包含本机专用配置。')
  if (!Array.isArray(p.bookmarks) || p.bookmarks.length > 200) throw new AppError('SYNC_FORMAT', '网页收藏数量不正确。')
  const bookmarks = p.bookmarks.map(validateBookmark)
  if (new Set(bookmarks.map(b => b.id)).size !== bookmarks.length) throw new AppError('SYNC_FORMAT', '网页收藏 ID 重复。')
  const t = record(p.themes), themes = parseTerminalThemes({ ...t, revision: 0 })
  const themeIds = new Set([...builtInTerminalThemes, ...themes.themes].map(t => t.id))
  if (catalog.servers.some(s => s.connections.some(c => c.terminalThemeId && !themeIds.has(c.terminalThemeId)))) throw new AppError('SYNC_FORMAT', '有入口引用了不存在的终端配色，请先修复配色。')
  const references = new Map(catalog.servers.flatMap(s => s.connections.map(c => [credentialKey(s.id, c.id), c.type] as const)))
  const bookmarkIds = new Set(bookmarks.map(b => 'bookmark:' + b.id))
  let secrets: SyncSecret[] | null = null
  if (p.secrets !== null) {
    if (!Array.isArray(p.secrets) || p.secrets.length > 24200) throw new AppError('SYNC_FORMAT', '凭据数量不正确。')
    secrets = p.secrets.map(value => { const r = record(value), id = string(r.id, 256), secret = string(r.secret, 16384, true)
      if (Object.keys(r).sort().join() !== 'id,kind,secret' || !['password', 'key', 'web-login'].includes(String(r.kind))) throw new AppError('SYNC_FORMAT', '凭据格式不正确。')
      if (r.kind === 'web-login') { const login = record(JSON.parse(secret)); if (!bookmarkIds.has(id) || Object.keys(login).sort().join() !== 'password,username') throw new AppError('SYNC_FORMAT', '网页凭据引用不正确。'); string(login.username, 256, true); string(login.password, 4096, true) }
      else if (!references.has(id) || (r.kind === 'key' ? references.get(id) !== 'ssh' : !['ssh', 'rdp', 'vnc', 'wdb'].includes(references.get(id)!))) throw new AppError('SYNC_FORMAT', '连接凭据引用不正确。')
      return { id, kind: r.kind as SyncSecret['kind'], secret }
    })
    if (new Set(secrets.map(s => s.id)).size !== secrets.length) throw new AppError('SYNC_FORMAT', '凭据 ID 重复。')
  }
  let plugins: PluginReference[] | null = null
  if (p.plugins !== null) {
    if (!Array.isArray(p.plugins) || p.plugins.length > 200) throw new AppError('SYNC_FORMAT', '插件清单过大。')
    plugins = p.plugins.map(value => { const r = record(value), id = string(r.id, 100), repository = string(r.repository, 512), commit = string(r.commit, 40); const url = new URL(repository)
      if (!/^[a-z][a-z0-9.-]+$/.test(id) || !/^[a-f0-9]{40}$/.test(commit) || url.protocol !== 'https:' || url.username || url.password || Object.keys(r).sort().join() !== 'commit,id,repository') throw new AppError('SYNC_FORMAT', '插件恢复清单无效。')
      return { id, repository, commit }
    })
  }
  return { version: 1, catalog, bookmarks, themes: { defaultId: themes.defaultId, themes: themes.themes }, secrets, plugins }
}
export function parsePayload(input: unknown): Payload {
  const p = record(input)
  if (p.version !== 1 || typeof p.operationId !== 'string' || p.operationId.length > 100 || !Array.isArray(p.ancestors) || p.ancestors.length > 128 || p.ancestors.some(a => typeof a !== 'string' || !/^[a-f0-9]{64}$/.test(a))) throw new AppError('SYNC_FORMAT', '同步链格式不正确。')
  return { version: 1, operationId: p.operationId, ancestors: p.ancestors as string[], snapshot: parseSnapshot(p.snapshot) }
}
export function capture(ctx: Context, settings: SyncSettings): PortableSnapshot {
  const catalog = ctx.storage.snapshot().snapshot
  for (const server of catalog.servers) server.connections = server.connections.map(portableConnection)
  const themes = ctx.terminalThemes.snapshot()
  const plan = JSON.parse(ctx.storage.getSetting('sync-plugin-plan') ?? '[]') as PluginReference[]
  const plugins = new Map(plan.map(p => [p.id, p]))
  for (const p of ctx.plugins.manager.registry.installed) if (p.source !== 'bundled') plugins.set(p.manifest.id, { id: p.manifest.id, repository: p.repository, commit: p.commit })
  return parseSnapshot({ version: 1, catalog, bookmarks: ctx.webBookmarks.snapshot().bookmarks.map(({ id, name, url }) => ({ id, name, url })), themes: { defaultId: themes.defaultId, themes: themes.themes }, secrets: settings.includeSecrets ? ctx.credentials.exportSyncSecrets() : null, plugins: settings.includePlugins ? [...plugins.values()] : null })
}
export function localStamp(ctx: Context): string {
  return digest(canonical({ catalog: ctx.storage.snapshot(), bookmarks: ctx.webBookmarks.snapshot(), themes: ctx.terminalThemes.snapshot(), secrets: ctx.credentials.syncRevision(), bindings: ctx.storage.getSetting('sync-bindings') ?? '', vault: ctx.storage.getSetting('vault') ?? '', plugins: ctx.plugins.manager.registry.revision }))
}
type Entry = { kind: string; name: string; value: unknown; order: number }
function flatten(snapshot: PortableSnapshot) {
  const entries = new Map<string, Entry>()
  const add = (kind: string, id: string, name: string, value: unknown, order = 0) => entries.set(JSON.stringify([kind, id]), { kind, name, value, order })
  snapshot.catalog.groups.forEach((g, i) => add('分组', g.id, g.name, g, i))
  snapshot.catalog.servers.forEach((s, i) => { const { connections, ...meta } = s; add('服务器', s.id, s.name, meta, i); connections.forEach((c, j) => add('入口', credentialKey(s.id, c.id), `${s.name} / ${c.name}`, { serverId: s.id, connection: c }, j)) })
  snapshot.bookmarks.forEach((b, i) => add('网页收藏', b.id, b.name, b, i))
  snapshot.themes.themes.forEach((t, i) => add('配色', t.id, t.name, t, i)); add('默认配色', 'default', '默认配色', snapshot.themes.defaultId)
  snapshot.secrets?.forEach(s => add('凭据', s.id, '保存的密码或口令', s))
  snapshot.plugins?.forEach(p => add('插件清单', p.id, p.id, p))
  return entries
}
function publicValue(entry?: Entry): string { return !entry ? '不存在' : entry.kind === '凭据' ? '已保存（内容隐藏）' : JSON.stringify(entry.value, null, 2) }
export function mergeSnapshots(base: PortableSnapshot | null, local: PortableSnapshot, remote: PortableSnapshot, choices: Record<string, SyncChoice> = {}, mode: 'merge' | 'local' | 'remote' = 'merge') {
  const b = base ? flatten(base) : new Map<string, Entry>(), l = flatten(local), r = flatten(remote), result = new Map<string, Entry>(), changes: SyncChange[] = []
  const keys = new Set([...b.keys(), ...l.keys(), ...r.keys()])
  for (const key of keys) {
    const old = b.get(key), left = l.get(key), right = r.get(key), same = (a?: Entry, b?: Entry) => canonical(a ? [a.value, a.order] : null) === canonical(b ? [b.value, b.order] : null)
    let conflict = false, picked: Entry | undefined
    if (mode !== 'merge') picked = mode === 'local' ? left : right
    else if (same(left, right)) picked = left
    else if (base && same(left, old)) picked = right
    else if (base && same(right, old)) picked = left
    else if (!base && (!left || !right)) picked = left ?? right
    else { conflict = !choices[key]; picked = choices[key] === 'remote' ? right : left }
    if (picked) result.set(key, picked)
    if (!same(left, right)) { const item = left ?? right ?? old!; changes.push({ key, name: item.name, kind: item.kind, action: old && (!left || !right) ? 'delete' : !left || !right ? 'add' : 'change', local: publicValue(left), remote: publicValue(right), conflict }) }
  }
  const values = (kind: string) => [...result.values()].filter(e => e.kind === kind).sort((a, b) => a.order - b.order).map(e => e.value)
  const serverValues = values('服务器') as Omit<CatalogDocument['servers'][number], 'connections'>[]
  const connectionValues = values('入口') as { serverId: string; connection: Connection }[]
  if (connectionValues.some(c => !serverValues.some(s => s.id === c.serverId))) throw new AppError('SYNC_MERGE_INVALID', '保留的入口所属服务器已被删除，请同时保留服务器，或整体采用同一来源。')
  const candidate = { version: 1, catalog: { schemaVersion: 1, groups: values('分组'), servers: serverValues.map(s => ({ ...s, connections: connectionValues.filter(c => c.serverId === s.id).map(c => c.connection) })) }, bookmarks: values('网页收藏'), themes: { defaultId: values('默认配色')[0], themes: values('配色') }, secrets: local.secrets === null && remote.secrets === null ? null : values('凭据'), plugins: local.plugins === null && remote.plugins === null ? null : values('插件清单') }
  // Deleting a parent must also delete its children and associated secrets; report each in the preview.
  const ids = new Set(candidate.catalog.servers.flatMap(s => s.connections.map(c => credentialKey(s.id, c.id))).concat((candidate.bookmarks as PortableSnapshot['bookmarks']).map(b => 'bookmark:' + b.id)))
  if (candidate.secrets) {
    for (const s of candidate.secrets as SyncSecret[]) if (!ids.has(s.id)) {
      const key = JSON.stringify(['凭据', s.id])
      if (!changes.some(change => change.key === key)) changes.push({ key, kind: '凭据', name: '随所属条目删除的凭据', action: 'delete', local: '已保存（内容隐藏）', remote: '所属入口或收藏将被删除', conflict: false })
    }
    candidate.secrets = (candidate.secrets as SyncSecret[]).filter(s => ids.has(s.id))
  }
  return { candidate, changes, conflicts: changes.filter(c => c.conflict).length }
}
export function applySnapshot(ctx: Context, snapshot: PortableSnapshot, settings: SyncSettings, stamp: string, commitAnchor: () => void) {
  const next = parseSnapshot(snapshot)
  if (localStamp(ctx) !== stamp) throw new AppError('REVISION_CONFLICT', '本机配置已改变，请重新预览。')
  ctx.credentials.requireUnlocked()
  if (typeof ctx.webBookmarks.replaceForSync !== 'function' || typeof ctx.terminalThemes.replaceForSync !== 'function') throw new AppError('PLUGIN_UNAVAILABLE', '当前收藏或配色提供者不支持配置同步。')
  const current = ctx.storage.snapshot(), bindings = new Set<string>(JSON.parse(ctx.storage.getSetting('sync-bindings') ?? '[]') as string[])
  for (const server of next.catalog.servers) for (const c of server.connections) {
    const old = current.snapshot.servers.find(s => s.id === server.id)?.connections.find(x => x.id === c.id && x.type === c.type)
    const key = credentialKey(server.id, c.id)
    if (old) { if (c.type === 'local' && old.pluginSettings?.cwd !== undefined) c.pluginSettings = { ...c.pluginSettings, cwd: old.pluginSettings.cwd }; if (c.type === 'adb' && old.pluginSettings?.serial !== undefined) c.pluginSettings = { ...c.pluginSettings, serial: old.pluginSettings.serial }; if (c.type.startsWith('plugin:') || (c.providerId && c.providerId !== 'builtin')) c.pluginSettings = old.pluginSettings }
    else if (['local', 'adb'].includes(c.type) || c.type.startsWith('plugin:') || (c.providerId && c.providerId !== 'builtin')) bindings.add(key)
  }
  ctx.storage.db.transaction(() => {
    const writeSecrets = ctx.credentials.prepareSyncSecrets(next.secrets, settings.includeSecrets, next.catalog, next.bookmarks)
    ctx.storage.replace(next.catalog, current.revision)
    ctx.webBookmarks.replaceForSync(next.bookmarks)
    ctx.terminalThemes.replaceForSync(next.themes)
    writeSecrets()
    const retained = new Set(next.catalog.servers.flatMap(s => s.connections.map(c => credentialKey(s.id, c.id))))
    ctx.storage.setSetting('sync-bindings', JSON.stringify([...bindings].filter(id => retained.has(id))))
    if (settings.includePlugins && next.plugins) ctx.storage.setSetting('sync-plugin-plan', JSON.stringify(next.plugins))
    commitAnchor()
  })()
  ctx.storage.notify(); ctx.webBookmarks.notifySync(); ctx.terminalThemes.notifySync()
}
