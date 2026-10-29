/** Public, data-only localization contract shared by hosts and plugins. */
export type LocaleId = string
export type MessageParams = Readonly<Record<string, string | number | boolean | null | undefined>>
export interface PluginI18n { defaultLocale: LocaleId; locales: Record<LocaleId, string> }
export interface LocaleBundle { defaultLocale: LocaleId; locales: Record<LocaleId, Record<string, string>> }
export interface MessageRef { namespace: string; key: string; params?: MessageParams }
export interface PluginMessages {
  /** Send this data reference for text that should follow the viewer's current language. */
  message(key: string, params?: MessageParams): MessageRef
  /** Default-language text for logs and non-UI consumers. */
  text(key: string, params?: MessageParams): string
  error(code: string, key: string, params?: MessageParams): Error & { code: string; messageRef: MessageRef }
}
export function createPluginMessages(namespace: string, bundle?: LocaleBundle): PluginMessages {
  const registry = new LocaleRegistry()
  if (bundle) registry.register(namespace, bundle)
  const message = (key: string, params?: MessageParams) => parseMessageRef({ namespace, key, params })
  const text = (key: string, params?: MessageParams) => registry.translate(namespace, key, bundle?.defaultLocale ?? 'zh-CN', params)
  return Object.freeze({ message, text, error: (code: string, key: string, params?: MessageParams) => {
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) throw new Error('Invalid error code')
    return Object.assign(new Error(text(key, params)), { code, messageRef: message(key, params) })
  } })
}
export function errorMessageRef(value: unknown): MessageRef | undefined {
  try { if (value && typeof value === 'object' && 'messageRef' in value) return parseMessageRef(value.messageRef) } catch { /* Malformed references never hide the original error. */ }
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
export function localeId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 50 || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(value)) throw new Error('Invalid locale ID')
  try { return Intl.getCanonicalLocales(value)[0]! } catch { throw new Error('Invalid locale ID') }
}
export function messageParameters(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]!))].sort()
}
export function parseLocaleBundle(value: unknown): LocaleBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid locale bundle')
  const input = value as Record<string, unknown>, fallback = localeId(input.defaultLocale)
  if (!input.locales || typeof input.locales !== 'object' || Array.isArray(input.locales)) throw new Error('Invalid locale dictionaries')
  const locales: LocaleBundle['locales'] = Object.create(null)
  let total = 0
  const entries = Object.entries(input.locales)
  if (!entries.length || entries.length > 32) throw new Error('Locale count exceeds limit')
  for (const [raw, dictionary] of entries) {
    const id = localeId(raw)
    if (Object.hasOwn(locales, id) || !dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) throw new Error('Invalid locale dictionary')
    const result: Record<string, string> = Object.create(null), rows = Object.entries(dictionary)
    if (rows.length > 10000) throw new Error('Locale dictionary exceeds limit')
    for (const [key, text] of rows) {
      if (key.length > 180 || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(key) || key.split('.').some(part => forbidden.has(part)) || typeof text !== 'string' || text.length > 10000 || /[\u0000\u200b\ufeff]/.test(text)) throw new Error('Invalid translation entry')
      total += key.length + text.length
      if (total > 2 * 1024 * 1024) throw new Error('Locale resources exceed limit')
      result[key] = text
    }
    locales[id] = Object.freeze(result)
  }
  const source = locales[fallback]
  if (!source) throw new Error('Default locale dictionary is required')
  for (const [id, dictionary] of Object.entries(locales)) if (id !== fallback) for (const [key, text] of Object.entries(dictionary)) {
    if (!Object.hasOwn(source, key) || messageParameters(text).join(',') !== messageParameters(source[key]!).join(',')) throw new Error(`Translation key or parameters differ: ${id}/${key}`)
  }
  return Object.freeze({ defaultLocale: fallback, locales: Object.freeze(locales) })
}
export function parseMessageRef(value: unknown): MessageRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message reference')
  const input = value as Record<string, unknown>
  if (typeof input.namespace !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(input.namespace) || typeof input.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,179}$/.test(input.key)) throw new Error('Invalid message reference')
  const params: Record<string, string | number | boolean | null> = Object.create(null)
  if (input.params !== undefined) {
    if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params) || Object.keys(input.params).length > 32) throw new Error('Invalid message parameters')
    for (const [key, val] of Object.entries(input.params)) {
      if (val === undefined) continue
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) || forbidden.has(key) || !(val === null || typeof val === 'boolean' || (typeof val === 'string' && val.length <= 8192) || (typeof val === 'number' && Number.isFinite(val)))) throw new Error('Invalid message parameter')
      params[key] = val
    }
  }
  return { namespace: input.namespace, key: input.key, ...(input.params === undefined ? {} : { params }) }
}
export function formatMessage(template: string, params: MessageParams = {}): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => Object.hasOwn(params, key) ? String(params[key] ?? '') : match)
}
/** Registry ownership is independent of plugin business activation. Replacement is atomic. */
export class LocaleRegistry {
  private bundles = new Map<string, LocaleBundle>()
  register(namespace: string, input: unknown): () => void {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(namespace)) throw new Error('Invalid locale namespace')
    const bundle = parseLocaleBundle(input)
    this.bundles.set(namespace, bundle)
    return () => { if (this.bundles.get(namespace) === bundle) this.bundles.delete(namespace) }
  }
  get(namespace: string) { return this.bundles.get(namespace) }
  remove(namespace: string) { this.bundles.delete(namespace) }
  translate(namespace: string, key: string, locale: string, params?: MessageParams): string {
    const bundle = this.bundles.get(namespace)
    if (!bundle) return key
    const primary = locale.split('-')[0]!
    const template = bundle.locales[locale]?.[key] ?? bundle.locales[primary]?.[key] ?? bundle.locales[bundle.defaultLocale]?.[key]
    return template === undefined ? key : formatMessage(template, params)
  }
}
