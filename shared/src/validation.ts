import type { Connection, Group, RdpDisplay, RdpOptions, Server } from './catalog.js'
import { pluginId } from './plugins.js'
import { builtinConnectionSettings } from './builtin-connections.js'

export function isConnectionType(value: unknown): value is Connection['type'] { return typeof value === 'string' && (['ssh','rdp','vnc','web','local','adb','wdb'].includes(value) || /^plugin:[a-z][a-z0-9.-]{1,100}$/.test(value)) }
function pluginSettings(input: unknown): NonNullable<Connection['pluginSettings']> {
  const data=object(input)
  if(Object.keys(data).length>64||JSON.stringify(data).length>16384||Object.entries(data).some(([key,value])=>!/^\w{1,80}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value))))throw new Error('插件公开配置格式无效。认证秘密应由凭据服务保存。')
  return {...data} as NonNullable<Connection['pluginSettings']>
}

export interface CatalogDocument { schemaVersion: 1; groups: Group[]; servers: Server[] }
export const MAX_CATALOG_BYTES = 1024 * 1024

export function serializeCatalog(groups: Group[], servers: Server[]): string {
  if (groups.length > 200 || servers.length > 2000) throw new Error('配置最多包含 200 个分组和 2,000 台服务器。')
  const json = JSON.stringify({ schemaVersion: 1, groups, servers })
  if (new TextEncoder().encode(json).byteLength > MAX_CATALOG_BYTES) throw new Error('配置总量不能超过 1 MiB，请减少记录或缩短内容。')
  return json
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置对象格式不正确。')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('配置包含不支持的字段，请勿导入密码、私钥或其他秘密。')
}
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.trim().length > max || (!empty && !value.trim())) throw new Error(`${label}不能为空且不能超过 ${max} 个字符。`)
  return value.trim()
}
function id(value: unknown): string {
  const result = text(value, '记录 ID', 100)
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('记录 ID 只能包含字母、数字、横线或下划线。')
  return result
}
export function parseRdpDisplay(input: unknown): RdpDisplay {
  const display = object(input)
  if (display.mode === 'windowed') {
    keys(display, ['mode', 'width', 'height'])
    for (const dimension of [display.width, display.height]) {
      if (typeof dimension !== 'number' || !Number.isInteger(dimension) || dimension < 200 || dimension > 8192) throw new Error('RDP 分辨率宽高必须是 200 到 8192 之间的整数。')
    }
    return { mode: 'windowed', width: display.width as number, height: display.height as number }
  }
  if (display.mode === 'fullscreen' || display.mode === 'multimon') {
    keys(display, ['mode'])
    return { mode: display.mode }
  }
  throw new Error('RDP 显示模式不正确。')
}
export function validHost(host: string): boolean {
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) return false
  if (host.includes(':')) {
    if (host.startsWith('[') && !host.endsWith(']')) return false
    try { return new URL(`http://${host.startsWith('[') ? host : `[${host}]`}/`).hostname.startsWith('[') } catch { return false }
  }
  if (/^[\d.]+$/.test(host)) return host.split('.').length === 4 && host.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  return host.split('.').every(part => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part))
}
export function validateGroups(groups: Group[]) {
  if (groups.length > 200) throw new Error('最多支持 200 个分组。')
  const ids = new Set(groups.map(group => group.id))
  if (ids.size !== groups.length) throw new Error('分组 ID 重复。')
  const names = new Set<string>()
  for (const group of groups) {
    if (['all', 'manage', 'recent', 'favorites'].includes(group.id)) throw new Error('分组 ID 与系统页面冲突，请更换 ID。')
    text(group.name, '分组名称', 40)
    const key = `${group.parentId ?? ''}/${group.name.trim().toLocaleLowerCase()}`
    if (names.has(key)) throw new Error('同一层级的分组名称不能重复。')
    names.add(key)
    const seen = new Set([group.id])
    let parent = group.parentId
    while (parent) {
      if (!ids.has(parent)) throw new Error('上级分组不存在。')
      if (seen.has(parent)) throw new Error('分组不能移动到自身或其子分组中。')
      seen.add(parent)
      parent = groups.find(item => item.id === parent)?.parentId
    }
    if (seen.size > 5) throw new Error('分组最多支持 5 层。')
  }
}
export function parseRdpOptions(input: unknown): RdpOptions {
  const options = object(input)
  keys(options, ['domain', 'security', 'certificate'])
  if (options.domain !== undefined && (typeof options.domain !== 'string' || options.domain.length > 100 || /[\r\n\0]/.test(options.domain))) throw new Error('RDP 域名不正确。')
  if (options.security !== undefined && (typeof options.security !== 'string' || !['any', 'nla', 'tls', 'rdp'].includes(options.security))) throw new Error('RDP 安全模式不正确。')
  if (options.certificate !== undefined && (typeof options.certificate !== 'string' || !['verify', 'tofu'].includes(options.certificate))) throw new Error('RDP 证书选项不正确。')
  return { ...options } as RdpOptions
}
export function validateServer(server: Server, groups: Group[]) {
  text(server.name, '服务器名称', 60)
  if (!validHost(server.host)) throw new Error('请输入有效 IP 或主机名，不要包含协议、端口、空格或路径。')
  if (server.groupId && !groups.some(group => group.id === server.groupId)) throw new Error('所属分组不存在。')
  if (!server.connections.length || server.connections.length > 12) throw new Error('每台服务器需要 1 到 12 个连接入口。')
  if (new Set(server.connections.map(connection => connection.id)).size !== server.connections.length) throw new Error('连接入口 ID 重复。')
  if (server.tags.length > 12 || server.tags.some(tag => !tag.trim() || tag.length > 30)) throw new Error('最多 12 个标签，每个标签不超过 30 字。')
  text(server.note, '备注', 500, true)
  for (const connection of server.connections) {
    if (connection.terminalThemeId !== undefined && (!['ssh','local'].includes(connection.type) || !/^[\w-]{1,80}$/.test(connection.terminalThemeId))) throw new Error('终端配色标识无效。')
    if (!isConnectionType(connection.type)) throw new Error('连接类型不正确。')
    if (connection.providerId !== undefined && connection.providerId !== 'builtin') pluginId(connection.providerId)
    if (connection.pluginSettings !== undefined) pluginSettings(connection.pluginSettings)
    builtinConnectionSettings(connection)
    if (connection.rdpClient !== undefined && (connection.type !== 'rdp' || !['native', 'browser'].includes(connection.rdpClient))) throw new Error('RDP 打开方式不正确。')
    if (connection.rdpOptions !== undefined) {
      if (connection.type !== 'rdp') throw new Error('RDP 参数与协议不匹配。')
      parseRdpOptions(connection.rdpOptions)
    }
    text(connection.name, '入口名称', 30)
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) throw new Error('端口必须是 1 到 65535 之间的整数。')
    if (connection.rdpDisplay !== undefined) {
      if (connection.type !== 'rdp') throw new Error('显示设置仅适用于 RDP 入口。')
      parseRdpDisplay(connection.rdpDisplay)
    }
    if (connection.type === 'web') {
      let url: URL
      try { url = new URL(connection.url ?? '') } catch { throw new Error('网页入口需要完整的 http:// 或 https:// 地址。') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页只支持 HTTP/HTTPS，地址中不能包含用户名或密码。')
      if (/[\u0000-\u0020\u007f]/.test(connection.url ?? '') || (connection.url?.length ?? 0) > 2048) throw new Error('网页地址不能包含空白或控制字符，长度不能超过 2048 字。')
      if (connection.port !== (url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443)) throw new Error('网页端口与 URL 不一致。')
    } else if (connection.username !== undefined) text(connection.username, '用户名', 100, true)
  }
}

export function parseCatalogImport(input: unknown): CatalogDocument {
  const data = object(input)
  keys(data, ['schemaVersion', 'groups', 'servers'])
  if (data.schemaVersion !== 1) throw new Error('不支持此配置版本，需要 schemaVersion: 1。')
  if (!Array.isArray(data.groups) || data.groups.length > 200 || !Array.isArray(data.servers) || data.servers.length > 2000) throw new Error('配置最多包含 200 个分组和 2,000 台服务器。')
  const groups: Group[] = data.groups.map((value: unknown) => {
    const group = object(value); keys(group, ['id', 'name', 'parentId'])
    return { id: id(group.id), name: text(group.name, '分组名称', 40), ...(group.parentId !== undefined ? { parentId: id(group.parentId) } : {}) }
  })
  validateGroups(groups)
  const servers: Server[] = data.servers.map((value: unknown) => {
    const server = object(value); keys(server, ['id', 'name', 'host', 'groupId', 'tags', 'note', 'favorite', 'connections'])
    if (!Array.isArray(server.tags) || !Array.isArray(server.connections) || typeof server.favorite !== 'boolean') throw new Error('服务器标签、收藏或连接格式不正确。')
    const connections: Connection[] = server.connections.map((value: unknown) => {
      const connection = object(value); keys(connection, ['id', 'type', 'name', 'port', 'username', 'url', 'saveHistory', 'terminalThemeId', 'rdpDisplay', 'rdpClient', 'rdpOptions', 'providerId', 'pluginSettings'])
      if (!isConnectionType(connection.type) || typeof connection.port !== 'number') throw new Error('连接类型或端口格式不正确。')
      if (connection.saveHistory !== undefined && typeof connection.saveHistory !== 'boolean') throw new Error('历史记录开关格式不正确。')
      const type = connection.type as Connection['type']
      if ((type !== 'web' && connection.url !== undefined) || (!['ssh','local'].includes(type) && connection.saveHistory !== undefined) || (type !== 'rdp' && (connection.rdpDisplay !== undefined || connection.rdpClient !== undefined || connection.rdpOptions !== undefined))) throw new Error('连接参数与协议不匹配。')
      if (connection.rdpClient !== undefined && (typeof connection.rdpClient !== 'string' || !['native', 'browser'].includes(connection.rdpClient))) throw new Error('RDP 打开方式不正确。')
      return { id: id(connection.id), type, name: text(connection.name, '入口名称', 30), port: connection.port,
        ...(connection.providerId!==undefined?{providerId:connection.providerId==='builtin'?'builtin':pluginId(connection.providerId)}:{}),
        ...(connection.pluginSettings!==undefined?{pluginSettings:pluginSettings(connection.pluginSettings)}:{}),
        ...(connection.username !== undefined ? { username: text(connection.username, '用户名', 100, true) } : {}),
        ...(type === 'web' ? { url: text(connection.url, '网页地址', 2048) } : {}),
        ...(type === 'ssh' ? { saveHistory: connection.saveHistory !== false } : {}),
        ...(type === 'local' ? { saveHistory: connection.saveHistory === true } : {}),
        ...(connection.terminalThemeId !== undefined ? { terminalThemeId: text(connection.terminalThemeId, '终端配色', 80) } : {}),
        ...(connection.rdpDisplay !== undefined ? { rdpDisplay: parseRdpDisplay(connection.rdpDisplay) } : {}),
        ...(connection.rdpClient !== undefined ? { rdpClient: connection.rdpClient as 'native' | 'browser' } : {}),
        ...(connection.rdpOptions !== undefined ? { rdpOptions: parseRdpOptions(connection.rdpOptions) } : {}) }
    })
    const result: Server = { id: id(server.id), name: text(server.name, '服务器名称', 60), host: text(server.host, '服务器地址', 253), groupId: server.groupId === '' ? '' : id(server.groupId), tags: server.tags.map((tag: unknown) => text(tag, '标签', 30)), note: text(server.note, '备注', 500, true), favorite: server.favorite, connections }
    validateServer(result, groups)
    return result
  })
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw new Error('服务器 ID 重复。')
  serializeCatalog(groups, servers)
  return { schemaVersion: 1, groups, servers }
}
