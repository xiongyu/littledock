import { parseAutomationDeclaration, type AutomationDeclaration } from './automation.js'
import { parsePluginContributions, parsePluginInterop, type PluginContributions, type PluginInterop } from './plugin-contributions.js'
/** Plugin protocol v1. Categories describe discovery; capabilities describe replaceable contracts. */
export const WEBNAV_VERSION = '0.1.2'
export const PLUGIN_API_VERSION = 1
export const PLUGIN_MARKET_REPOSITORY = 'https://gitee.com/axisxy/webnavpluginsmarket.git'
export const pluginCategories = {
  terminal: 'SSH 与终端', desktop: '远程桌面', files: '文件管理与传输', servers: '服务器与分组',
  bookmarks: '网页收藏与导航', monitoring: '系统监控', services: '服务与容器', databases: '数据库工具',
  network: '网络工具', automation: '自动化与任务', exchange: '数据导入与导出', backup: '备份与恢复',
  appearance: '外观与工作区', productivity: '搜索与效率', integrations: '通知与集成', development: '开发与诊断',
  themes: '主题',
} as const
export type PluginCategory = keyof typeof pluginCategories
export const serviceCapabilities = {
  sessions: 'SSH 会话', desktops: 'VNC 与桌面通道', freeRdp: '网页 RDP', rdp: '系统 RDP',
  terminalHistory: '输出历史', terminalThemes: '终端配色', webBookmarks: '网页收藏',
  sshInspector: 'SSH 系统信息', sshFiles: 'SSH 文件管理', remoteEditor: '远程编辑器',
  local: '本地终端', adb: '安卓 ADB', wdb: 'WDB 远程控制', configSync: '配置同步', taskManager: '任务管理器',
} as const
export type ServiceCapability = keyof typeof serviceCapabilities
export const frontendSlots = ['terminal', 'desktop', 'connection-form', 'bookmarks', 'system', 'files', 'history', 'themes', 'task-manager'] as const
export type FrontendSlot = typeof frontendSlots[number]
export interface PluginPlatform { os: 'win32' | 'linux' | 'darwin'; arch: 'x64' | 'arm64'; minRelease?: string }
export interface PluginField { key: string; label: string; type: 'string' | 'number' | 'boolean'; required?: boolean }
export interface PluginTheme { background: string; sidebar: string; accent: string; backgrounds?: { left?: string; right?: string } }
export interface InstalledTheme { id: string; name: string; description: string; theme: PluginTheme }
export interface PluginManifest {
  schemaVersion: 1; id: string; name: string; version: string; description: string; author: string; license: string
  category: PluginCategory; secondaryCategories: PluginCategory[]
  apiVersion: 1; webnav: string; node: string; platforms: PluginPlatform[]
  capabilities: { id: string; version: 1 }[]
  backend?: string; frontend?: string; styles?: string[]
  /** Backend code always runs off the host main thread. Omitted means the shared runtime. */
  execution?: { backend: 'shared' | 'dedicated' }
  icon: string; homepage?: string; screenshots?: string[]; readme?: string; changelog?: string
  dependencies?: Record<string, string>; commands?: string[]
  /** Executable + argv, never a shell command; run only AFTER consent. */
  install?: { command: string; args: string[] }[]
  configFields?: PluginField[]; dataVersion: number
  theme?: PluginTheme
  /** Defaults to hot. restart is reserved for process-wide resources that cannot be released. */
  reload?: 'hot' | 'restart'
  reloadReason?: string
  automation?: AutomationDeclaration
  contributes?: PluginContributions
  interop?: PluginInterop
}
export interface PluginIndexEntry {
  id: string; name: string; description: string; repository: string; ref?: string
  category: PluginCategory; secondaryCategories: PluginCategory[]; platforms: PluginPlatform[]
  publisher: 'official' | 'community'
}
export interface PluginIndex { schemaVersion: 1; plugins: PluginIndexEntry[] }
export interface PluginHost { os: string; arch: string; release: string; node: string; webnav: string; apiVersion: number }
export interface InstalledPlugin {
  manifest: PluginManifest; repository: string; commit: string; ref: string; enabled: boolean
  source?: 'bundled'
  installedAt: number; config: Record<string, string | number | boolean>; previousCommit?: string
}
export interface PluginPreview {
  token: string; manifest: PluginManifest; repository: string; commit: string; ref: string
  compatible: boolean; reasons: string[]; readme: string; iconDataUrl?: string; expiresAt: number; upgrading: boolean
  registryRevision: number
  change: 'install' | 'current' | 'upgrade' | 'rebuild' | 'downgrade'
  installedRelease?: { version: string; commit: string }
  changes: string[]
}
export interface PluginState {
  runtimeRevision: number
  pending: { id: string; kind: 'waiting' | 'restart' | 'error'; reason: string }[]
  host: PluginHost; revision: number; safeMode: boolean; restartRequired: boolean
  installed: (InstalledPlugin & { running: boolean; activeRelease?: { version: string; commit: string }; runtime?: PluginRuntime; reasons: string[]; error?: string })[]
  providers: Record<string, string>; runningProviders: Record<string, string>
  builtins: PluginBuiltin[]
  bundled?: PluginDetails[]
  bundledErrors?: string[]
}
export interface PluginRuntime { backend: 'shared' | 'dedicated'; threadId: number }
export interface PluginBuiltin { id: string; name: string; capability: string; category: PluginCategory; manifest: PluginManifest; readme: string; iconDataUrl: string; runtime?: PluginRuntime }
export interface PluginDetails { manifest: PluginManifest; repository: string; commit: string; readme: string; iconDataUrl?: string; fetchedAt: number; cached: boolean; reasons: string[] }
export interface PluginMarket {
  repository: string; index: PluginIndex; fetchedAt: number | null; cached: boolean; error?: string
}
export const pluginRisk = {
  title: '安装第三方插件前，请确认风险',
  body: '插件及其安装脚本可能以当前系统用户权限执行代码，读取、修改、删除或向外发送本地文件、服务器配置、账号信息，以及可访问的密码、私钥和终端历史，也可能利用已有凭据操作远程服务器。',
  index: '插件被收录到索引中，不代表已经通过安全审核。平台兼容检查通过，也不代表插件安全。',
  ai: '强烈建议先使用 AI 审查插件源码、依赖和安装脚本，再决定是否安装。AI 审查可能遗漏问题，不能保证插件安全。',
  privacy: '使用 AI 审核时，请勿提交真实密码、私钥、服务器配置或终端历史。请谨慎处理涉及数据和账号的插件。',
  consent: '我已阅读并理解上述风险，自行决定安装，并愿意承担安装和使用此插件的风险。',
} as const

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件配置必须是对象。')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`${label}格式不正确。`)
  return value.trim()
}
export function pluginId(value: unknown): string {
  const id = text(value, '插件 ID', 100)
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id) || id.startsWith('builtin.')) throw new Error('插件 ID 需要命名空间，例如 author.plugin；不能占用 builtin。')
  return id
}
function category(value: unknown): PluginCategory {
  if (typeof value !== 'string' || !Object.hasOwn(pluginCategories, value)) throw new Error('请选择内置插件分类，不支持自定义分类。')
  return value as PluginCategory
}
function categories(value: unknown, primary: PluginCategory): PluginCategory[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2) throw new Error('最多选择两个次要分类。')
  const list = value.map(category)
  if (new Set([primary, ...list]).size !== list.length + 1) throw new Error('插件分类不能重复。')
  return list
}
function platforms(value: unknown): PluginPlatform[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw new Error('必须声明支持的宿主平台与架构组合。')
  const list = value.map(item => {
    const p = object(item)
    if (!['win32', 'linux', 'darwin'].includes(String(p.os)) || !['x64', 'arm64'].includes(String(p.arch))) throw new Error('宿主平台或架构无效。')
    return { os: p.os, arch: p.arch, ...(p.minRelease === undefined ? {} : { minRelease: text(p.minRelease, '最低系统版本', 50) }) } as PluginPlatform
  })
  if (new Set(list.map(p => p.os + '/' + p.arch)).size !== list.length) throw new Error('平台组合重复。')
  return list
}
export function pluginRelativePath(value: unknown): string {
  const path = text(value, '插件资源路径', 240)
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('插件资源必须使用仓库内的相对路径。')
  return path
}
export function pluginRepository(value: unknown): string {
  const raw = text(value, 'Git 仓库地址', 2048)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('请输入完整的 HTTPS Git 仓库地址。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Git 安装使用不含账号、密码或查询参数的 HTTPS 地址。')
  return url.href.replace(/\/$/, '')
}
function link(value: unknown): string { const url = new URL(text(value, '介绍链接', 2048)); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('介绍链接必须使用 HTTPS。'); return url.href }
export function parsePluginManifest(input: unknown, builtin = false): PluginManifest {
  const m = object(input), primary = category(m.category)
  if (m.schemaVersion !== 1 || m.apiVersion !== 1) throw new Error('不支持此插件规范或 API 版本。')
  if (!Array.isArray(m.capabilities) || !m.capabilities.length || m.capabilities.length > 30) throw new Error('必须声明提供的能力。')
  const capabilities = m.capabilities.map(item => {
    const c = object(item), id = text(c.id, '能力 ID', 120)
    if (!/^(service:[a-zA-Z]+|connector:[a-z][a-z0-9.-]*|extension:[a-z][a-z0-9.-]*|theme:appearance)$/.test(id) || c.version !== 1) throw new Error('能力 ID 或契约版本无效。')
    if (id.startsWith('service:') && !Object.hasOwn(serviceCapabilities, id.slice(8))) throw new Error('此系统服务不可替换。')
    return { id, version: 1 as const }
  })
  if (new Set(capabilities.map(c => c.id)).size !== capabilities.length) throw new Error('能力声明重复。')
  if ((primary === 'themes' || capabilities.some(c => c.id === 'theme:appearance')) && m.theme === undefined) throw new Error('主题分类与主题能力必须提供静态主题定义。')
  const contributes = m.contributes === undefined ? undefined : parsePluginContributions(m.contributes, pluginRelativePath, builtin)
  if (!m.backend && !m.frontend && !m.theme && !contributes?.settings) throw new Error('插件必须提供后端、前端、设置入口或主题定义。')
  if (contributes?.tools.length && !m.frontend && !builtin) throw new Error('工具声明需要前端入口。')
  if ((contributes?.menuPoints?.length || contributes?.menuItems?.length || contributes?.uiPoints?.length || contributes?.uiItems?.length) && !m.frontend && !builtin) throw new Error('界面扩展声明需要前端入口。')
  if (m.theme && (m.contributes || m.interop)) throw new Error('静态主题不能注册可执行扩展。')
  if (!Number.isSafeInteger(m.dataVersion) || Number(m.dataVersion) < 1) throw new Error('必须声明正整数 dataVersion。')
  const result: PluginManifest = { schemaVersion: 1, id: builtin ? text(m.id, '内置插件 ID', 100) : pluginId(m.id), name: text(m.name, '插件名称', 80), version: text(m.version, '版本', 60), description: text(m.description, '简介', 1000), author: text(m.author, '作者', 100), license: text(m.license, '许可证', 100), category: primary, secondaryCategories: categories(m.secondaryCategories, primary), apiVersion: 1, webnav: text(m.webnav, 'WebNav 版本范围', 100), node: text(m.node, 'Node 版本范围', 100), platforms: platforms(m.platforms), capabilities, dataVersion: Number(m.dataVersion), icon: pluginRelativePath(m.icon) }
  if (m.execution !== undefined) {
    const execution = object(m.execution)
    if (!m.backend || m.theme || Object.keys(execution).some(key => key !== 'backend') || !['shared', 'dedicated'].includes(String(execution.backend))) throw new Error('execution.backend 需要后端入口，只能为 shared 或 dedicated。')
    result.execution = { backend: execution.backend as 'shared' | 'dedicated' }
  }
  if (m.reload !== undefined) { if (m.reload !== 'hot' && m.reload !== 'restart') throw new Error('reload 必须是 hot 或 restart。'); result.reload = m.reload }
  if (contributes) result.contributes = contributes
  if (m.interop !== undefined) { if (!m.backend) throw new Error('插件通信需要后端入口。'); result.interop = parsePluginInterop(m.interop) }
  if (m.reloadReason !== undefined) result.reloadReason = text(m.reloadReason, '重启原因', 500)
  if (m.theme !== undefined) {
    if (primary !== 'themes' || capabilities.length !== 1 || capabilities[0]!.id !== 'theme:appearance' || m.backend || m.frontend || m.install || m.styles) throw new Error('主题使用独立主题分类，只提供 theme:appearance 和静态配色 / 背景，不包含执行入口或安装步骤。')
    const theme = object(m.theme)
    if (['background','sidebar','accent'].some(key => typeof theme[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(theme[key] as string))) throw new Error('主题配色必须使用六位十六进制颜色。')
    result.theme = { background: theme.background as string, sidebar: theme.sidebar as string, accent: theme.accent as string }
    if (theme.backgrounds !== undefined) {
      const images = object(theme.backgrounds); result.theme.backgrounds = {}
      for (const side of ['left','right'] as const) if (images[side] !== undefined) { const path = pluginRelativePath(images[side]); if (!/\.(png|jpg|jpeg|webp|svg)$/.test(path)) throw new Error('主题背景需要 PNG / JPG / WebP / SVG。'); result.theme.backgrounds[side] = path }
    }
  }
  for (const key of ['backend', 'frontend', 'readme', 'changelog'] as const) if (m[key] !== undefined) result[key] = pluginRelativePath(m[key])
  if (!builtin && result.backend && !/\.m?js$/.test(result.backend)) throw new Error('后端入口需要可直接运行的 JS / MJS 文件。')
  if (result.frontend && (!result.frontend.includes('/') || !/\.m?js$/.test(result.frontend))) throw new Error('前端入口需要独立资源目录中的 ES module，例如 ui/index.js。')
  if (m.styles !== undefined) { if (!Array.isArray(m.styles) || m.styles.length > 8) throw new Error('样式列表无效。'); result.styles = m.styles.map(pluginRelativePath) }
  if (result.styles?.some(path => !result.frontend || !path.startsWith(result.frontend.slice(0, result.frontend.lastIndexOf('/') + 1)) || !path.endsWith('.css'))) throw new Error('样式必须位于前端入口的同一资源目录。')
  if (m.homepage !== undefined) result.homepage = link(m.homepage)
  if (m.screenshots !== undefined) { if (!Array.isArray(m.screenshots) || m.screenshots.length > 8) throw new Error('截图最多八张。'); result.screenshots = m.screenshots.map(link) }
  if (m.dependencies !== undefined) result.dependencies = Object.fromEntries(Object.entries(object(m.dependencies)).map(([id, range]) => [pluginId(id), text(range, '依赖版本', 100)]))
  if (m.commands !== undefined) { if (!Array.isArray(m.commands) || m.commands.length > 20) throw new Error('外部组件列表无效。'); result.commands = m.commands.map(v => { const name = text(v, '外部组件', 80); if (!/^[\w.-]+$/.test(name)) throw new Error('外部组件需要可执行文件名。'); return name }) }
  if (m.install !== undefined) {
    if (!Array.isArray(m.install) || m.install.length > 5) throw new Error('安装步骤最多五项。')
    result.install = m.install.map(item => { const step = object(item), command = text(step.command, '安装程序', 120); if (!/^[\w./-]+$/.test(command) || command.startsWith('-')) throw new Error('安装程序名称无效。'); if (!Array.isArray(step.args) || step.args.length > 50 || step.args.some(a => typeof a !== 'string' || a.length > 2048 || a.includes('\0'))) throw new Error('安装参数无效。'); return { command, args: step.args as string[] } })
  }
  if (m.configFields !== undefined) {
    if (!Array.isArray(m.configFields) || m.configFields.length > 30) throw new Error('配置字段最多三十项。')
    result.configFields = m.configFields.map(item => { const field = object(item), key = text(field.key, '配置键', 80); if (!/^[a-z][a-zA-Z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !['string', 'number', 'boolean'].includes(String(field.type))) throw new Error('配置字段无效。'); return { key, label: text(field.label, '配置标题', 100), type: field.type as PluginField['type'], required: field.required === true } })
  }
  if (m.automation !== undefined) {
    result.automation = parseAutomationDeclaration(m.automation)
    if (result.theme && result.automation.tools.length) throw new Error('静态主题不能提供可执行自动化工具。')
    for (const tool of result.automation.tools) if (tool.binding.capability && !capabilities.some(c => c.id === tool.binding.capability)) throw new Error('工具绑定未声明的插件能力。')
  }
  return result
}
export function parsePluginIndex(input: unknown): PluginIndex {
  const value = object(input)
  if (value.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 1000) throw new Error('插件索引格式不正确。')
  const plugins = value.plugins.map(item => { const p = object(item), primary = category(p.category); if(p.publisher!==undefined&&!['official','community'].includes(String(p.publisher)))throw new Error('发布者标记无效。');return { id: pluginId(p.id), name: text(p.name, '插件名称', 80), description: text(p.description, '插件简介', 1000), repository: pluginRepository(p.repository), ...(p.ref === undefined ? {} : { ref: text(p.ref, 'Git 版本', 200) }), category: primary, secondaryCategories: categories(p.secondaryCategories, primary), platforms: platforms(p.platforms), publisher: p.publisher === 'official' ? 'official' as const : 'community' as const } })
  if (new Set(plugins.map(p => p.id)).size !== plugins.length) throw new Error('索引包含重复插件 ID。')
  return { schemaVersion: 1, plugins }
}
