export type Protocol = 'ssh' | 'rdp' | 'web'
export interface Group { id: string; name: string; parentId?: string }
export interface Connection { id: string; type: Protocol; name: string; port: number; username?: string; url?: string; saveHistory?: boolean }
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

export const protocolNames: Record<Protocol, string> = { ssh: 'SSH', rdp: 'RDP', web: '网页' }

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
