/** Public API surface for plugin authors. Import types only; activate receives runtime objects. */
export type { PluginBackendApi, PluginRpc } from './plugin-system/runtime.ts'
/** Portable SDK surface for shared and dedicated execution; no synchronous Cordis references. */
export type PluginWorkerApi = import('./plugin-system/runtime.ts').PluginBackendApi
export type { PluginInteropApi, PluginCallContext, PluginMethodHandler, PluginEventSnapshot } from './plugin-system/interop.ts'
export type { PluginContributions, PluginFontInfo, PluginInterop, PluginServiceContract } from '@webnav/shared'
export type { PluginMenuContext, PluginMenuPoint, PluginMenuContribution, PluginUiPoint, PluginUiContribution } from '@webnav/shared'
export type { AutomationHandler, AutomationCall } from './plugin-system/runtime.ts'
export type { AutomationDeclaration, AutomationTool } from '@webnav/shared'
export type { PluginManifest, PluginField, PluginCategory, PluginPlatform } from '@webnav/shared'
export type { PluginMessages, MessageRef, MessageParams, PluginI18n, LocaleBundle } from '@webnav/shared'
export type { TerminalProcess, TerminalProvider } from './core/terminal-provider.ts'
export type { DeviceProvider, DeviceStream } from './plugins/device-sessions.ts'
