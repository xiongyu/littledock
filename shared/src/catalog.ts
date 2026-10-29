export type Protocol = 'ssh' | 'rdp' | 'vnc' | 'web' | 'local' | 'adb' | 'wdb' | `plugin:${string}`
export type WorkspaceProtocol = 'ssh' | 'rdp' | 'vnc' | 'local' | 'adb' | 'wdb'
export interface Group { id: string; name: string; parentId?: string }
export type RdpDisplay = { mode: 'windowed'; width: number; height: number } | { mode: 'fullscreen' | 'multimon' }
export interface RdpOptions { domain?: string; security?: 'any' | 'nla' | 'tls' | 'rdp'; certificate?: 'verify' | 'tofu' }
export interface Connection { id: string; type: Protocol; name: string; port: number; username?: string; url?: string; saveHistory?: boolean; terminalThemeId?: string; rdpDisplay?: RdpDisplay; rdpClient?: 'native' | 'browser'; rdpOptions?: RdpOptions; providerId?: string; pluginSettings?: Record<string, string | number | boolean> }
export const DEFAULT_BROWSER_RDP_DISPLAY = { mode: 'windowed', width: 1920, height: 1080 } as const
// Missing values include existing entries and older imports: RDP opens in the workspace by default.
export function getRdpClient(connection: Pick<Connection, 'rdpClient'>): 'native' | 'browser' { return connection.rdpClient ?? 'browser' }
export function getRdpCertificatePolicy(connection: Pick<Connection, 'rdpOptions'>): 'verify' | 'tofu' { return connection.rdpOptions?.certificate ?? 'tofu' }
export interface Server {
  id: string
  name: string
  host: string
  groupId: string
  tags: string[]
  note: string
  favorite: boolean
  connections: Connection[]
}

export const protocolNames: Record<Protocol, string> = new Proxy({ ssh: 'SSH', rdp: 'RDP', vnc: 'VNC', web: '网页', local: '本地终端', adb: 'ADB', wdb: 'WDB' }, { get: (target, key: string) => target[key as keyof typeof target] ?? key.replace(/^plugin:/, '') })

export function orderedGroups(groups: Group[]): (Group & { depth: number })[] {
  const result: (Group & { depth: number })[] = []
  const seen = new Set<string>()
  function visit(parentId: string | undefined, depth: number) {
    for (const group of groups.filter(item => item.parentId === parentId)) {
      if (seen.has(group.id)) continue
      seen.add(group.id)
      result.push({ ...group, depth })
      visit(group.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return result
}

export function groupDescendants(id: string, groups: Group[]): Set<string> {
  const ids = new Set([id])
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups) if (group.parentId && ids.has(group.parentId) && !ids.has(group.id)) {
      ids.add(group.id); changed = true
    }
  }
  return ids
}
