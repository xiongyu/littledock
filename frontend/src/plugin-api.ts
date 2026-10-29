import type { Component, Ref } from 'vue'
import type { FrontendSlot, PluginFontInfo } from '@webnav/shared'
import type { PluginMenusApi, PluginUiApi } from './plugin-menu-api'
import type { PluginLocaleApi } from './i18n.ts'
export type { PluginLocaleApi } from './i18n.ts'
export type { MessageRef, MessageParams, PluginI18n, LocaleBundle } from '@webnav/shared'
export type * from './plugin-menu-api'
export type { PluginMenuContext, PluginMenuPoint, PluginMenuContribution, PluginUiPoint, PluginUiContribution } from '@webnav/shared'
export interface PluginFrontendApi {
  apiVersion: 1
  /** Framework-owned translator, scoped to this plugin's declared dictionaries. */
  i18n: PluginLocaleApi
  vue: typeof import('vue')
  hostState: Readonly<Ref<'connecting' | 'offline' | 'locked' | 'ready'>>
  config: Record<string, unknown>
  menus: PluginMenusApi
  ui: PluginUiApi
  rpc<T = unknown>(name: string, params?: Record<string, unknown>, mutate?: boolean): Promise<T>
  hostRpc<T = unknown>(name: string, params?: Record<string, unknown>, mutate?: boolean): Promise<T>
  registerView(slot: FrontendSlot, component: Component): void
  registerTool(id: string, definition: { component: Component }): void
  registerSettingsPage(id: 'main', definition: { component: Component }): void
  openTool(id: string): void
  openSettings(options?: { section?: string }): void
  registerFontInfo(info: PluginFontInfo): Readonly<PluginFontInfo & { size: number }>
  getFontInfo(flag: string): Readonly<PluginFontInfo & { size: number }>
  registerConnector(type: string, definition: { name: string; port: number; form?: Component; open?: (serverId: string, connectionId: string) => Promise<void> }): void
  onDispose(cleanup: () => void | Promise<void>): void
}
export type PluginActivate = (api: PluginFrontendApi) => void | Promise<void>
/** Separate entry is available while the business plugin is disabled. config is the host's shared draft. */
export interface PluginSettingsApi {
  apiVersion: 1
  i18n: PluginLocaleApi
  vue: typeof import('vue')
  hostState: PluginFrontendApi['hostState']
  config: Record<string, string | number | boolean>
  registerSettingsPage(id: 'main', definition: { component: Component }): void
  registerFontInfo: PluginFrontendApi['registerFontInfo']
  getFontInfo: PluginFrontendApi['getFontInfo']
  onDispose(cleanup: () => void | Promise<void>): void
  setDirty(value: boolean): void
  rpc: PluginFrontendApi['rpc']
}
