
import { pluginI18n, pluginText } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import { markRaw, ref, shallowReactive, type Component } from 'vue'

export interface PluginToolView { key: string; pluginId: string; id: string; title: string; icon?: string; component: Component }
export interface PluginWorkspaceTab { key: string; pluginId: string; title: string; kind: 'tool' | 'settings'; status: string; section?: string; component?: Component }
export const pluginTools = shallowReactive<Record<string, PluginToolView>>({})
export const pluginTabs = shallowReactive<PluginWorkspaceTab[]>([])
export const activePluginTab = ref('')
let settingsOpener: ((pluginId: string, section?: string) => void) | undefined
export function setPluginSettingsOpener(open: typeof settingsOpener) { settingsOpener = open }
export function openPluginSettings(pluginId: string, section?: string) { if (!settingsOpener) throw new Error(i18nT('m83ff96f95813')); settingsOpener(pluginId, section) }
export function openPluginTool(key: string) {
  const tool = pluginTools[key]
  if (!tool) throw new Error(i18nT('md5749ba83555'))
  if (!pluginTabs.some(tab => tab.key === key)) pluginTabs.push({ key, pluginId: tool.pluginId, get title() { return pluginTools[key]?.title ?? tool.title }, kind: 'tool', status: '' })
  activePluginTab.value = key
}
export function openSettingsTab(pluginId: string, name: string, component: Component, section?: string) {
  const key = `plugin-settings:${pluginId}`
  const previous = pluginTabs.find(tab => tab.key === key)
  if (previous) { if (section) previous.section = section }
  else pluginTabs.push({ key, pluginId, get title() { return i18nT('m2dd28051d44c', { p0: pluginText(pluginId, 'metadata.name', name) }) }, kind: 'settings', status: '', component: markRaw(component), ...(section ? { section } : {}) })
  activePluginTab.value = key
}
export const pluginCloseGuards = new Map<string, () => boolean | Promise<boolean>>()
export async function closePluginTab(key: string) {
  if (pluginCloseGuards.has(key) && !await pluginCloseGuards.get(key)!()) return false
  const index = pluginTabs.findIndex(tab => tab.key === key)
  if (index < 0) return false
  pluginTabs.splice(index, 1); pluginCloseGuards.delete(key)
  if (activePluginTab.value === key) activePluginTab.value = pluginTabs.at(-1)?.key ?? ''
  return true
}
export function publishPluginTools(tools: Map<string, PluginToolView>) {
  for (const key of Object.keys(pluginTools)) if (!tools.has(key)) {
    delete pluginTools[key]
    const index = pluginTabs.findIndex(tab => tab.key === key)
    if (index >= 0) pluginTabs.splice(index, 1)
    if (activePluginTab.value === key) activePluginTab.value = pluginTabs.at(-1)?.key ?? ''
  }
  for (const [key, tool] of tools) pluginTools[key] = tool
}
