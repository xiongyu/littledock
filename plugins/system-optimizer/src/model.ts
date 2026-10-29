export type RegistryValue = { exists: false } | { exists: true; type: 'DWord' | 'String' | 'ExpandString'; data: string | number }
export interface RegistryTarget { hive: 'CurrentUser' | 'LocalMachine'; view: 'Registry64' | 'Registry32'; path: string; name: string }
export interface SystemItem { id: string; name: string; category: 'startup' | 'settings' | 'apps'; source: string; state: string; writable: boolean; note: string; target?: RegistryTarget; before?: RegistryValue; desired?: RegistryValue; details?: string; publisher?: string; version?: string }
export interface SystemSnapshot { identity: string; computer: string; user: string; build: number; scannedAt: number; items: SystemItem[]; coverage: string[]; warnings: string[] }
export interface PublicItem extends Omit<SystemItem, 'target' | 'before' | 'desired' | 'details'> {}
export interface PublicSnapshot extends Omit<SystemSnapshot, 'items' | 'identity'> { items: PublicItem[] }
export interface Change { itemId: string; name: string; target: RegistryTarget; before: RegistryValue; after: RegistryValue; note: string }
export interface Plan { id: string; owner: string; identity: string; expiresAt: number; changes: Change[]; restorationOf?: string }
export interface RecordItem extends Change { status: 'pending' | 'applied' | 'conflict' | 'failed' | 'unknown'; message?: string }
export interface OperationRecord { id: string; operationId: string; request: string; owner: string; identity: string; createdAt: number; status: 'running' | 'complete' | 'partial' | 'unknown'; items: RecordItem[]; restorationOf?: string }
export interface WindowsAdapter {
  snapshot(): Promise<SystemSnapshot>
  read(target: RegistryTarget): Promise<RegistryValue>
  apply(target: RegistryTarget, expected: RegistryValue, desired: RegistryValue): Promise<{ status: 'applied' | 'conflict'; current: RegistryValue }>
  protect(value: string): Promise<string>
  unprotect(value: string): Promise<string>
  openSettings(page: 'startup' | 'apps' | 'storage'): Promise<void>
  close(): Promise<void>
}
export function publicSnapshot(snapshot: SystemSnapshot): PublicSnapshot {
  const { identity: _identity, items, ...rest } = snapshot
  return { ...rest, items: items.map(({ target: _target, before: _before, desired: _desired, details: _details, ...item }) => item) }
}
export const equivalent = (a: RegistryValue, b: RegistryValue) => a.exists === b.exists && (!a.exists || (b.exists && a.type === b.type && a.data === b.data))
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统数据格式无效。'); return value as Record<string, unknown> }
function text(value: unknown, max = 32768): string { if (typeof value !== 'string' || value.length > max) throw new Error('系统文本数据无效。'); return value }
export function registryValue(input: unknown): RegistryValue {
  const v = object(input); if (v.exists === false) return { exists: false }
  if (v.exists !== true) throw new Error('注册表状态无效。')
  if (v.type === 'DWord' && Number.isInteger(v.data) && Number(v.data) >= -2147483648 && Number(v.data) <= 2147483647) return { exists: true, type: v.type, data: Number(v.data) }
  if (v.type === 'String' || v.type === 'ExpandString') return { exists: true, type: v.type, data: text(v.data) }
  throw new Error('不支持的注册表值类型。')
}
export function registryTarget(input: unknown): RegistryTarget {
  const v = object(input)
  if (!['CurrentUser','LocalMachine'].includes(String(v.hive)) || !['Registry32','Registry64'].includes(String(v.view))) throw new Error('注册表范围无效。')
  return { hive: v.hive as RegistryTarget['hive'], view: v.view as RegistryTarget['view'], path: text(v.path, 300), name: text(v.name, 300) }
}
export function parseSnapshot(input: unknown): SystemSnapshot {
  const s = object(input)
  if (!Number.isSafeInteger(s.build) || !Number.isSafeInteger(s.scannedAt) || !Array.isArray(s.items) || s.items.length > 10000 || !Array.isArray(s.coverage) || !Array.isArray(s.warnings)) throw new Error('扫描响应超限或无效。')
  const items = s.items.map(input => {
    const i = object(input)
    if (!['startup','settings','apps'].includes(String(i.category)) || typeof i.writable !== 'boolean') throw new Error('扫描条目无效。')
    const item: SystemItem = { id: text(i.id, 160), name: text(i.name, 1000), category: i.category as SystemItem['category'], source: text(i.source, 1000), state: text(i.state, 100), writable: i.writable, note: text(i.note, 2000) }
    if (i.target !== undefined) item.target = registryTarget(i.target)
    if (i.before !== undefined) item.before = registryValue(i.before)
    if (i.desired !== undefined) item.desired = registryValue(i.desired)
    if (i.details !== undefined) item.details = text(i.details)
    if (i.publisher !== undefined) item.publisher = text(i.publisher, 2000)
    if (i.version !== undefined) item.version = text(i.version, 200)
    if (item.writable && (!item.target || !item.before || !item.desired)) throw new Error('可修改条目缺少原值。')
    return item
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('扫描条目标识冲突。')
  return { identity: text(s.identity, 160), computer: text(s.computer, 300), user: text(s.user, 300), build: Number(s.build), scannedAt: Number(s.scannedAt), items, coverage: s.coverage.map(v => text(v, 2000)), warnings: s.warnings.map(v => text(v, 2000)) }
}
