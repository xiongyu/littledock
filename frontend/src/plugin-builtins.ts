import type { PluginActivate } from './plugin-api'
const entries = new Map<string, PluginActivate>()
export function registerBuiltinFrontend(id: string, activate: PluginActivate) {
  if (!id.startsWith('builtin.') || entries.has(id)) throw new Error('内置插件注册重复或无效。')
  entries.set(id, activate)
}
export function builtinFrontend(id: string) { return entries.get(id) }
