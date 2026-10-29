import { ref, readonly, watch, type Ref } from 'vue'
import { LocaleRegistry, localeId, parseMessageRef, type MessageRef, type LocaleBundle, type MessageParams, type PluginManifest } from '@webnav/shared'
import { builtinLocales } from './i18n-builtins.ts'
import type { LocaleNamespaceMap } from './i18n-keys'

const registry = new LocaleRegistry()
for (const [namespace, bundle] of Object.entries(builtinLocales)) registry.register(namespace, bundle)
const storageKey = 'webnav.locale.v1'
function preference() {
  try { const saved = globalThis.localStorage?.getItem(storageKey); return saved === 'en' ? 'en' : 'zh-CN' } catch { return 'zh-CN' }
}
const active = ref(preference()), revision = ref(0)
export function displayLocale() { return active.value }
export const currentLocale: Readonly<Ref<string>> = readonly(active)
export const localeChoices = Object.freeze([{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }])
export function setLocale(value: string) {
  const id = localeId(value)
  if (!localeChoices.some(choice => choice.id === id)) throw new Error('Unsupported display language')
  active.value = id
  try { globalThis.localStorage?.setItem(storageKey, id) } catch { /* The current page still switches when storage is unavailable. */ }
}
watch(active, id => { if (typeof document !== 'undefined') document.documentElement.lang = id }, { immediate: true, flush: 'sync' })
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === storageKey) active.value = event.newValue === 'en' ? 'en' : 'zh-CN' })
export function registerLocaleBundle(namespace: string, bundle: unknown): () => void {
  const dispose = registry.register(namespace, bundle); revision.value++
  return () => { dispose(); revision.value++ }
}
export function translate(namespace: string, key: string, params?: MessageParams): string {
  void revision.value
  return registry.translate(namespace, key, active.value, params)
}
export interface PluginLocaleApi<Key extends string = string> {
  readonly locale: Readonly<Ref<string>>
  t(key: Key, params?: MessageParams): string
  ref(key: Key, params?: MessageParams): MessageRef
  number(value: number, options?: Intl.NumberFormatOptions): string
  date(value: number | Date, options?: Intl.DateTimeFormatOptions): string
  /** Resolve a structured status/error produced by this plugin; ordinary data stays unchanged. */
  message(value: unknown, fallback?: string): string
}
export function pluginI18n<N extends keyof LocaleNamespaceMap>(namespace: N): PluginLocaleApi<LocaleNamespaceMap[N]>
export function pluginI18n(namespace: string): PluginLocaleApi
export function pluginI18n(namespace: string): PluginLocaleApi {
  return Object.freeze({ locale: currentLocale, t: (key: string, params?: MessageParams) => translate(namespace, key, params),
    ref: (key: string, params?: MessageParams) => parseMessageRef({ namespace, key, params }),
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(active.value, options).format(value),
    date: (value: number | Date, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(active.value, options).format(value),
    message: (value: unknown, fallback = '') => renderMessage(value, fallback),
  })
}
export function renderMessage(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  try { const ref = parseMessageRef(value), result = translate(ref.namespace, ref.key, ref.params); return result === ref.key ? fallback || ref.key : result } catch { return fallback }
}
export function pluginText(namespace: string, key: string, fallback: string): string {
  const value = translate(namespace, key)
  return value === key ? fallback : value
}
export function localizedManifest<T extends PluginManifest>(manifest: T): T {
  const text = (key: string, fallback: string) => pluginText(manifest.id, key, fallback)
  return { ...manifest, name: text('metadata.name', manifest.name), description: text('metadata.description', manifest.description),
    ...(manifest.configFields ? { configFields: manifest.configFields.map(field => ({ ...field, label: text(`configFields.${field.key}.label`, field.label) })) } : {}),
    ...(manifest.contributes ? { contributes: { ...manifest.contributes,
      tools: manifest.contributes.tools.map(tool => ({ ...tool, title: text(`tools.${tool.id}.title`, tool.title) })),
      fonts: manifest.contributes.fonts.map(font => ({ ...font, name: text(`fonts.${font.flag}.name`, font.name) })),
      ...(manifest.contributes.settings ? { settings: { ...manifest.contributes.settings, title: text('settings.title', manifest.contributes.settings.title) } } : {}),
    } } : {}),
  }
}
/** Namespace-scoped replacement: a stale release's disposer cannot remove its successor. */
export const installedLocaleBundles = new Map<string, { commit: string; dispose: () => void; bundle: LocaleBundle }>()
export function cachePluginLocales(namespace: string, commit: string, bundle: unknown) {
  if (installedLocaleBundles.get(namespace)?.commit === commit) return
  const dispose = registerLocaleBundle(namespace, bundle), old = installedLocaleBundles.get(namespace)
  installedLocaleBundles.set(namespace, { commit, dispose, bundle: registry.get(namespace)! }); old?.dispose()
}
export type { LocaleBundle }
