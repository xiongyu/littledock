import { parseAutomationSchema, type AutomationSchema } from './automation.js'
import { parsePluginMenuItems, parsePluginMenuPoints, parsePluginUiItems, parsePluginUiPoints, type PluginMenuContribution, type PluginMenuPoint, type PluginUiPoint, type PluginUiContribution } from './plugin-menus.js'

export interface PluginTool { id: string; title: string; icon?: string; placement: 'sidebar.tools' }
export interface PluginSettingsPage { id: 'main'; title: string; entry?: string; styles: string[] }
export interface PluginFontInfo { flag: string; name: string; group: string; defaultSize: number; minSize: number; maxSize: number }
export interface PluginContributions { tools: PluginTool[]; settings?: PluginSettingsPage; fonts: PluginFontInfo[]; menuPoints?: PluginMenuPoint[]; menuItems?: PluginMenuContribution[]; uiPoints?: PluginUiPoint[]; uiItems?: PluginUiContribution[] }
export interface PluginServiceMethod { id: string; inputSchema: AutomationSchema; outputSchema: AutomationSchema; access: 'read' | 'write' | 'finish' }
export interface PluginServiceEvent { id: string; schema: AutomationSchema }
export interface PluginServiceContract { id: string; version: number; methods: PluginServiceMethod[]; events: PluginServiceEvent[] }
export interface PluginServiceRequirement { id: string; version: number; provider?: string; optional: boolean }
export interface PluginInterop { provides: PluginServiceContract[]; requires: PluginServiceRequirement[] }

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件声明需要对象。'); return value as Record<string, unknown> }
function text(value: unknown, label: string, max = 100) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`${label}无效。`); return value.trim() }
export function pluginLocalId(value: unknown) { const id = text(value, '局部标识', 80); if (!/^[a-z][a-z0-9.-]*$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('局部标识无效。'); return id }
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > max) throw new Error('插件声明数量超限。'); return value.map(parse) }
function unique(items: string[]) { if (new Set(items).size !== items.length) throw new Error('插件声明标识重复。') }
function version(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000) throw new Error('契约版本无效。'); return Number(value) }
export function parsePluginFontInfo(value: unknown): PluginFontInfo {
  const f = record(value)
  if (![f.minSize, f.maxSize, f.defaultSize].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 8 && v <= 96) || Number(f.minSize) > Number(f.defaultSize) || Number(f.defaultSize) > Number(f.maxSize)) throw new Error('字体范围或默认字号无效。')
  return { flag: pluginLocalId(f.flag), name: text(f.name, '字体名称'), group: text(f.group, '字体分组'), defaultSize: Number(f.defaultSize), minSize: Number(f.minSize), maxSize: Number(f.maxSize) }
}
export function parsePluginContributions(value: unknown, path: (value: unknown) => string, builtin = false): PluginContributions {
  const c = record(value)
  const tools = list(c.tools, 16, value => { const t = record(value); if (t.placement !== 'sidebar.tools') throw new Error('工具位置尚未支持。'); return { id: pluginLocalId(t.id), title: text(t.title, '工具标题'), placement: 'sidebar.tools' as const, ...(t.icon === undefined ? {} : { icon: path(t.icon) }) } })
  unique(tools.map(tool => tool.id))
  const fonts = list(c.fonts, 96, parsePluginFontInfo); unique(fonts.map(font => font.flag))
  const result: PluginContributions = { tools, fonts }
  if (c.menuPoints !== undefined) result.menuPoints = parsePluginMenuPoints(c.menuPoints)
  if (c.menuItems !== undefined) result.menuItems = parsePluginMenuItems(c.menuItems)
  if (c.uiPoints !== undefined) result.uiPoints = parsePluginUiPoints(c.uiPoints)
  if (c.uiItems !== undefined) result.uiItems = parsePluginUiItems(c.uiItems)
  unique([...(result.menuPoints ?? []).map(p => p.id), ...(result.uiPoints ?? []).map(p => p.id)])
  if (c.settings !== undefined) {
    const s = record(c.settings), entry = s.entry === undefined && builtin ? undefined : path(s.entry)
    if (s.id !== 'main' || (entry && (!entry.includes('/') || !/\.m?js$/.test(entry)))) throw new Error('设置入口需为 main 和独立目录中的 ES module。')
    const styles = list(s.styles, 8, path), base = entry?.slice(0, entry.lastIndexOf('/') + 1)
    if (styles.some(file => !base || !file.startsWith(base) || !file.endsWith('.css'))) throw new Error('设置样式必须在设置入口目录中。')
    result.settings = { id: 'main', title: text(s.title, '设置标题'), entry, styles }
  }
  return result
}
export function parsePluginInterop(value: unknown): PluginInterop {
  const declaration = record(value)
  const contractId = (value: unknown) => { const id = pluginLocalId(value); if (!id.includes('.')) throw new Error('服务契约需要命名空间。'); return id }
  const provides = list(declaration.provides, 16, value => {
    const c = record(value)
    const methods = list(c.methods, 32, value => {
      const m = record(value); if (!['read', 'write', 'finish'].includes(String(m.access))) throw new Error('服务方法需声明读写与收尾语义。')
      return { id: pluginLocalId(m.id), inputSchema: parseAutomationSchema(m.inputSchema), outputSchema: parseAutomationSchema(m.outputSchema), access: m.access as PluginServiceMethod['access'] }
    })
    const events = list(c.events, 16, value => { const e = record(value); return { id: pluginLocalId(e.id), schema: parseAutomationSchema(e.schema) } })
    unique(methods.map(m => m.id)); unique(events.map(e => e.id))
    return { id: contractId(c.id), version: version(c.version), methods, events }
  })
  const requires = list(declaration.requires, 32, value => { const r = record(value); return { id: contractId(r.id), version: version(r.version), optional: r.optional === true, ...(r.provider === undefined ? {} : { provider: contractId(r.provider) }) } })
  unique(provides.map(c => c.id + '@' + c.version)); unique(requires.map(c => c.id + '@' + c.version))
  return { provides, requires }
}
