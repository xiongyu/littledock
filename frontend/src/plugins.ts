import * as vue from 'vue'
import { shallowReactive, ref, markRaw, type Component } from 'vue'
import type { Connection, FrontendSlot, PluginManifest, PluginState, Protocol, InstalledTheme } from '@webnav/shared'
import { rpc, connectionState } from './backend'
import { installedThemes } from './theme-market'
import { pluginConnectors } from './plugin-registry.ts'
import { pluginDeadline } from './plugin-lifecycle.ts'
import { builtinFrontend } from './plugin-builtins'
import { openPluginTool, openPluginSettings, publishPluginTools, pluginTabs, activePluginTab, type PluginToolView } from './plugin-workspace'
import type { PluginFrontendApi } from './plugin-api'
import { createPluginFontScope } from './plugin-fonts'
import { pluginSettingsViews } from './plugin-settings-registry'
import { pluginMenus, setMenuAvailability } from './plugin-menus'
import { pluginUi, setUiAvailability } from './plugin-ui'
import { createUiApi } from './plugin-ui-api'
setMenuAvailability(() => connectionState.value === 'ready')
setUiAvailability(() => connectionState.value === 'ready')
vue.watch(connectionState, state => { if (state !== 'ready') pluginMenus.cancelPending() }, { flush: 'sync' })
export { pluginConnectors } from './plugin-registry.ts'
export async function refreshThemes() { installedThemes.value = await rpc<InstalledTheme[]>('plugins.themes') }

export const pluginState = ref<PluginState>()
export const pluginLoadErrors = ref<string[]>([])
export const pluginViews = shallowReactive<Record<string, Component>>({})
const slotCapabilities: Record<FrontendSlot, string[]> = { terminal: ['sessions'], desktop: ['freeRdp', 'desktops'], 'connection-form': ['sessions', 'freeRdp', 'desktops', 'rdp'], bookmarks: ['webBookmarks'], system: ['sshInspector'], files: ['sshFiles'], 'task-manager': ['taskManager'], history: ['terminalHistory'], themes: ['terminalThemes'] }
type Connector = (typeof pluginConnectors)[string]
type Unit = { signature: string; views: Map<string, Component>; tools: Map<string, PluginToolView>; settings?: Component; fonts: ReturnType<typeof createPluginFontScope>; menus: ReturnType<typeof pluginMenus.createScope>; ui: ReturnType<typeof pluginUi.createScope>; connectors: Map<string, Connector>; cleanups: (() => void | Promise<void>)[]; disposed: boolean; registering: boolean }
const loaded = new Map<string, Unit>()
let serial: Promise<void> = Promise.resolve()
async function cleanup(unit: Unit) {
  if (unit.disposed) return
  unit.disposed = true; unit.registering = false
  try { const results = await pluginDeadline(Promise.allSettled(unit.cleanups.splice(0).reverse().map(async dispose => dispose())), 5000, '插件资源清理超时。'); if (results.some(result => result.status === 'rejected')) throw new Error('清理失败') }
  catch { if (!pluginLoadErrors.value.includes('插件资源清理未完成，请刷新页面完成回收。')) pluginLoadErrors.value.push('插件资源清理未完成，请刷新页面完成回收。') }
}
export function loadPlugins() { serial = serial.catch(() => {}).then(syncPlugins); return serial }
async function syncPlugins() {
  await refreshThemes()
  type Asset = { id: string; name?: string; commit: string; capabilities: PluginManifest['capabilities']; entry?: string; builtin?: boolean; contributes?: PluginManifest['contributes']; icon?: string; styles: string[]; config: Record<string, unknown> }
  const state = await rpc<{ revision: number; assets: Asset[]; providers: Record<string, string> }>('plugins.assets')
  const desired = new Set(state.assets.filter(p => p.entry || (p.builtin && builtinFrontend(p.id))).map(p => p.id)), candidates = new Map<string, Unit>()
  for (const asset of state.assets) {
    if (!asset.entry && !(asset.builtin && builtinFrontend(asset.id))) continue
    const entry = asset.entry
    const signature = JSON.stringify([asset, Object.entries(state.providers).filter(([, id]) => id === asset.id).sort()])
    if (loaded.get(asset.id)?.signature === signature) continue
    const fonts = createPluginFontScope(asset.id, asset.name ?? asset.id)
    const menus = pluginMenus.createScope(asset.id, asset.name ?? asset.id, asset.contributes), ui = pluginUi.createScope(asset.id, asset.name ?? asset.id, asset.contributes)
    const unit: Unit = { signature, views: new Map(), tools: new Map(), fonts, menus, ui, connectors: new Map(), cleanups: [() => fonts.dispose(), () => menus.dispose(), () => ui.dispose()], disposed: false, registering: true }
    const requireRegistration = () => { if (unit.disposed || !unit.registering) throw new Error('插件注册作用域已经关闭。') }
    try {
      await pluginDeadline((async () => {
      const module: unknown = asset.builtin ? { activate: builtinFrontend(asset.id) } : await import(/* @vite-ignore */ entry!)
      requireRegistration()
      const activate = (module as { activate?: unknown }).activate
      if (typeof activate !== 'function') throw new Error('前端入口未导出 activate。')
      const api: PluginFrontendApi = { apiVersion: 1, vue, hostState: vue.readonly(connectionState), config: asset.config, ...createUiApi(menus, ui),
        registerFontInfo: info => { requireRegistration(); return fonts.registerFontInfo(info) }, getFontInfo: flag => fonts.getFontInfo(flag),
        rpc: (name: string, params: Record<string, unknown> = {}, mutate = false) => rpc(`plugin.${asset.id}.${name}`, params, mutate), hostRpc: rpc,
        registerView: (slot: FrontendSlot, component: Component) => {
          requireRegistration()
          if (!slotCapabilities[slot]?.some(cap => state.providers['service:' + cap] === asset.id)) return
          if (unit.views.has(slot)) throw new Error('视图槽位冲突。')
          unit.views.set(slot, markRaw(component))
        },
        registerTool: (id, definition) => {
          requireRegistration()
          const declared = asset.contributes?.tools.find(tool => tool.id === id)
          if (!declared || unit.tools.has(id) || !definition.component) throw new Error('工具注册未声明或重复。')
          const key = `plugin-tool:${asset.id}/${id}`
          unit.tools.set(id, { key, id, pluginId: asset.id, title: declared.title, component: markRaw(definition.component), icon: !asset.builtin && declared.icon ? `/plugins/${asset.id}/${asset.commit}/${declared.icon}` : asset.icon })
        },
        registerSettingsPage: (id, definition) => {
          requireRegistration()
          if (id !== asset.contributes?.settings?.id || unit.settings || !definition.component) throw new Error('设置页面未声明或重复。')
          unit.settings = markRaw(definition.component)
        },
        openTool: id => { if (unit.disposed) throw new Error('插件已停止。'); openPluginTool(`plugin-tool:${asset.id}/${id}`) },
        openSettings: options => { if (unit.disposed) throw new Error('插件已停止。'); openPluginSettings(asset.id, options?.section) },
        registerConnector: (type: string, definition: Omit<Connector, 'pluginId'>) => {
          requireRegistration()
          if (!asset.capabilities.some(cap => cap.id === 'connector:' + type)) throw new Error('连接器未声明。')
          if (!definition.name || !Number.isInteger(definition.port) || definition.port < 1 || definition.port > 65535) throw new Error('连接器显示定义无效。')
          const key = asset.id + '/' + type
          unit.connectors.set(key, { ...definition, pluginId: asset.id, ...(definition.form ? { form: markRaw(definition.form) } : {}) })
        },
        onDispose: (dispose: () => void | Promise<void>) => { requireRegistration(); if (typeof dispose !== 'function') throw new Error('清理方法无效。'); unit.cleanups.push(dispose) },
      }
      for (const font of asset.contributes?.fonts ?? []) fonts.registerFontInfo(font)
      await activate(api)
      menus.seal(); ui.seal()
      if (asset.contributes?.tools.some(tool => !unit.tools.has(tool.id))) throw new Error('未注册声明的工具页面。')
      })(), 15000, '插件前端加载超时。')
      unit.registering = false
      for (const href of asset.styles) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link); unit.cleanups.push(() => link.remove()) }
      candidates.set(asset.id, unit)
      pluginLoadErrors.value = pluginLoadErrors.value.filter(message => !message.startsWith(asset.id + ' '))
    } catch { await cleanup(unit); const message = `${asset.id} 前端更新失败，已保留原视图。请重试或回退插件。`; if (!pluginLoadErrors.value.includes(message)) pluginLoadErrors.value.push(message) }
  }
  // Vue batches this synchronous registry update: unchanged panes keep the same component identity.
  const retired: Unit[] = []
  for (const [id, unit] of loaded) if (!desired.has(id) || candidates.has(id)) { loaded.delete(id); retired.push(unit) }
  for (const [id, unit] of candidates) { unit.fonts.commit(); loaded.set(id, unit) }
  pluginMenus.publish([...loaded.values()].map(unit => unit.menus))
  pluginUi.publish([...loaded.values()].map(unit => unit.ui))
  const views = new Map([...loaded.values()].flatMap(unit => [...unit.views])), connectors = new Map([...loaded.values()].flatMap(unit => [...unit.connectors]))
  for (const key of Object.keys(pluginViews)) if (!views.has(key)) delete pluginViews[key]
  for (const [key, component] of views) pluginViews[key] = component
  for (const key of Object.keys(pluginConnectors)) if (!connectors.has(key)) delete pluginConnectors[key]
  for (const [key, connector] of connectors) pluginConnectors[key] = connector
  publishPluginTools(new Map([...loaded.values()].flatMap(unit => [...unit.tools.values()].map(tool => [tool.key, tool]))))
  for (const id of Object.keys(pluginSettingsViews)) if (!loaded.get(id)?.settings) delete pluginSettingsViews[id]
  for (const [id, unit] of loaded) if (unit.settings) pluginSettingsViews[id] = unit.settings
  await vue.nextTick()
  for (const unit of retired) await cleanup(unit)
  pluginState.value = await rpc<PluginState>('plugins.state')
  const installed = new Set([...(pluginState.value.installed ?? []).map(p => p.manifest.id), ...(pluginState.value.builtins ?? []).map(p => p.id)])
  for (let index = pluginTabs.length - 1; index >= 0; index--) {
    const tab = pluginTabs[index]!
    if (tab.kind === 'settings' && !installed.has(tab.pluginId)) { pluginTabs.splice(index, 1); if (activePluginTab.value === tab.key) activePluginTab.value = '' }
  }
}
export function connectorProvider(connection: Connection) {
  const type = connection.type.replace(/^plugin:/, '')
  const id = connection.providerId ?? pluginState.value?.runningProviders['connector:' + type]
  return id ? pluginConnectors[id + '/' + type] : undefined
}
export function connectorOptions(type: Protocol) { const protocol = type.replace(/^plugin:/, ''); return Object.entries(pluginConnectors).filter(([key, item]) => key === item.pluginId + '/' + protocol).map(([, item]) => item) }
export function disposePlugins() { pluginMenus.publish([]); pluginUi.publish([]); for (const unit of loaded.values()) void cleanup(unit); loaded.clear() }
