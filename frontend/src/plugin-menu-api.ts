import type { Component } from 'vue'
import type { PluginMenuContext, PluginMenuPoint } from '@webnav/shared'
export interface PluginMenuItemHandler {
  when?(context: PluginMenuContext): boolean
  enabled?(context: PluginMenuContext): boolean
  run(context: PluginMenuContext, invocation: { signal: AbortSignal }): unknown | Promise<unknown>
}
export interface PluginMenuLocalItem {
  id: string; label: string; shortcut?: string; disabled?: boolean; separator?: boolean; danger?: boolean; group?: string; order?: number
}
export interface PluginMenusApi {
  registerPoint(id: string): void
  registerItem(id: string, handler: PluginMenuItemHandler): void
  /** Bound to this plugin. Props: point, context, isCurrent, items, execute, x/y, owner, label. */
  ContextMenu: Component
}
export interface PluginUiPointInfo { plugin: string; pluginName: string; point: string; title: string; description: string; fields: PluginMenuPoint['fields']; version: number; kind: 'menu' | 'tabs' | 'panel' | 'actions' }
export interface PluginUiInstanceInfo extends PluginUiPointInfo { id: string; context: PluginMenuContext }
export interface PluginUiQuery { plugin?: string; point?: string; kind?: PluginUiPointInfo['kind'] }
export interface PluginUiApi {
  registerPoint(id: string): void
  registerItem(id: string, definition: { component: Component; when?(context: PluginMenuContext): boolean }): void
  listPoints(query?: PluginUiQuery): readonly PluginUiPointInfo[]
  find(query?: PluginUiQuery): readonly PluginUiInstanceInfo[]
  /** Activates this plugin's contribution in one live tabs instance. Never grants access to another plugin's DOM. */
  activate(instanceId: string, itemId: string): boolean
  Slot: Component
}
