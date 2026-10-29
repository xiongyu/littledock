export interface SyncSettings {
  provider: 'github' | 'gitee'
  repository: string
  branch: string
  spaceId: string
  username: string
  includeSecrets: boolean
  includePlugins: boolean
  autoSync: boolean
}
export interface SyncStatus {
  settings: SyncSettings | null
  unlocked: boolean
  expiresAt: number | null
  hasToken: boolean
  tokenSaved: boolean
  busy: boolean
  message: string
  lastSuccess: number | null
  pending: boolean
  hasBaseline: boolean
  bindings: { serverId: string; connectionId: string; name: string }[]
  pluginPlan: { id: string; repository: string; commit: string }[]
}
export type SyncChoice = 'local' | 'remote'
export interface SyncChange { key: string; name: string; kind: string; action: 'add' | 'change' | 'delete'; local: string; remote: string; conflict: boolean }
export interface SyncPreview {
  token: string
  first: boolean
  remoteVersion: string | null
  changes: SyncChange[]
  changeCount: number
  hasDeletions: boolean
  conflicts: number
  warnings: string[]
  expiresAt: number
  mode: 'merge' | 'local' | 'remote' | 'restore'
}
export interface SyncHistory { versions: { version: string; time: number }[]; cursor: string | null }
