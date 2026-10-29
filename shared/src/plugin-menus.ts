/** Flat, bounded public metadata only. No DOM, callbacks, credentials or process output. */
export type PluginMenuContext = Readonly<Record<string, string | number | boolean>>
export interface PluginMenuPoint {
  id: string; title: string; description: string; version: number; public: boolean
  fields: Record<string, { type: 'string' | 'number' | 'boolean'; required: boolean; description: string }>
}
export interface PluginMenuContribution {
  id: string; title: string; target: { plugin: string; point: string; version: number }
  group: string; order: number; access: 'read' | 'write'; danger: boolean
}
export interface PluginUiPoint extends PluginMenuPoint { kind: 'tabs' | 'panel' | 'actions' }
export type PluginUiContribution = Omit<PluginMenuContribution, 'access' | 'danger'>
export function parsePluginUiPoints(value: unknown): PluginUiPoint[] {
  const points = parsePluginMenuPoints(value)
  return points.map((point, index) => {
    const kind = object((value as unknown[])[index]).kind
    if (kind !== 'tabs' && kind !== 'panel' && kind !== 'actions') throw new Error('界面扩展位置类型无效。')
    return { ...point, kind }
  })
}
export function parsePluginUiItems(value: unknown): PluginUiContribution[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('界面扩展声明需要列表。')
  return parsePluginMenuItems(value.map(value => ({ ...object(value), access: 'read', danger: false }))).map(({ access, danger, ...item }) => item)
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('菜单声明需要对象。'); return value as Record<string, unknown> }
function id(value: unknown) { if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('菜单标识无效。'); return value }
function title(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new Error('菜单标题无效。'); return value.trim() }
function description(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\x00-\x1f]/.test(value)) throw new Error('扩展点及字段必须提供用途说明（最多 2000 字）。'); return value.trim() }
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000) throw new Error('菜单版本无效。'); return Number(value) }
function list<T>(value: unknown, maximum: number, parse: (value: unknown) => T & { id: string }): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) throw new Error('菜单声明数量超限。')
  const result = value.map(parse)
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('菜单声明标识重复。')
  return result
}
export function parsePluginMenuPoints(value: unknown): PluginMenuPoint[] {
  return list(value, 16, value => {
    const p = object(value), source = object(p.fields), fields: PluginMenuPoint['fields'] = {}
    if (p.public !== undefined && typeof p.public !== 'boolean') throw new Error('控件 public 必须为布尔值。')
    if (Object.keys(source).length > 32) throw new Error('菜单上下文字段超限。')
    for (const [key, value] of Object.entries(source)) {
      const field = object(value)
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !['string', 'number', 'boolean'].includes(String(field.type)) || (field.required !== undefined && typeof field.required !== 'boolean')) throw new Error('菜单上下文字段无效。')
      fields[key] = { type: field.type as 'string' | 'number' | 'boolean', required: field.required === true, description: description(field.description) }
    }
    return { id: id(p.id), title: title(p.title), description: description(p.description), version: version(p.version), public: p.public !== false, fields }
  })
}
export function parsePluginMenuItems(value: unknown): PluginMenuContribution[] {
  return list(value, 64, value => {
    const m = object(value), target = object(m.target), order = m.order ?? 500
    if (typeof target.plugin !== 'string' || !/^[a-z][a-zA-Z0-9.-]{0,99}$/.test(target.plugin) || !target.plugin.includes('.')) throw new Error('菜单目标插件无效。')
    if (!Number.isSafeInteger(order) || Number(order) < -1000 || Number(order) > 10000 || !['read', 'write'].includes(String(m.access)) || (m.danger !== undefined && typeof m.danger !== 'boolean')) throw new Error('菜单排序或操作类型无效。')
    return { id: id(m.id), title: title(m.title), target: { plugin: target.plugin, point: id(target.point), version: version(target.version) }, group: id(m.group ?? 'extensions'), order: Number(order), access: m.access as 'read' | 'write', danger: m.danger === true }
  })
}
export function parsePluginMenuContext(point: PluginMenuPoint, value: unknown): PluginMenuContext {
  const source = object(value), result: Record<string, string | number | boolean> = {}
  if (Object.keys(source).some(key => !Object.hasOwn(point.fields, key))) throw new Error('菜单上下文包含未声明字段。')
  for (const [key, field] of Object.entries(point.fields)) {
    const value = source[key]
    if (value === undefined && !field.required) continue
    if (typeof value !== field.type || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 4096)) throw new Error('菜单上下文不符合声明。')
    result[key] = value as string | number | boolean
  }
  if (JSON.stringify(result).length > 16384) throw new Error('菜单上下文超限。')
  return Object.freeze(result)
}
