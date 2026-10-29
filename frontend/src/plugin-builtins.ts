
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import type { PluginActivate } from './plugin-api'
const entries = new Map<string, PluginActivate>()
export function registerBuiltinFrontend(id: string, activate: PluginActivate) {
  if (!id.startsWith('builtin.') || entries.has(id)) throw new Error(i18nT('m47399222af38'))
  entries.set(id, activate)
}
export function builtinFrontend(id: string) { return entries.get(id) }
