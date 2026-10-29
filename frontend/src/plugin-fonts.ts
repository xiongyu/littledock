
import { pluginI18n, pluginText } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import { computed, reactive, readonly, ref, watch, type ComputedRef } from 'vue'
import { parsePluginFontInfo, type PluginFontInfo } from '@webnav/shared'

export interface RegisteredFont extends PluginFontInfo { pluginId: string; pluginName: string; key: string; size: number }
const storageKey = 'webnav.plugin-fonts.v1'
const overrides = reactive<Record<string, number>>({})
const scopes = new Map<symbol, { pluginId: string; name: string; fonts: Map<string, PluginFontInfo> }>()
const revision = ref(0)
export const fontStorageError = ref('')
function readOverrides(value: string | null) {
  try {
    const input: unknown = value ? JSON.parse(value) : {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) return
    for (const key of Object.keys(overrides)) delete overrides[key]
    for (const [key, size] of Object.entries(input).slice(0, 2000)) if (key.length <= 200 && typeof size === 'number' && Number.isFinite(size) && size >= 8 && size <= 96 && !['__proto__', 'constructor', 'prototype'].includes(key)) overrides[key] = size
  } catch { fontStorageError.value = i18nT('m3184acecf7d9') }
}
if (typeof localStorage !== 'undefined') { try { readOverrides(localStorage.getItem(storageKey)) } catch { fontStorageError.value = i18nT('mc6b1165c08a6') } }
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === storageKey) readOverrides(event.newValue) })
function effective(pluginId: string, font: PluginFontInfo) { return Math.max(font.minSize, Math.min(font.maxSize, overrides[`${pluginId}/${font.flag}`] ?? font.defaultSize)) }
export const registeredFonts: ComputedRef<RegisteredFont[]> = computed(() => {
  void revision.value
  const fonts = new Map<string, RegisteredFont>()
  for (const scope of scopes.values()) for (const font of scope.fonts.values()) {
    const key = `${scope.pluginId}/${font.flag}`
    fonts.set(key, { ...font, key, pluginId: scope.pluginId, pluginName: pluginText(scope.pluginId === 'builtin.workbench' ? 'core' : scope.pluginId, 'metadata.name', scope.name), name: pluginText(scope.pluginId === 'builtin.workbench' ? 'core' : scope.pluginId, `fonts.${font.flag}.name`, font.name), group: pluginText(scope.pluginId === 'builtin.workbench' ? 'core' : scope.pluginId, `fonts.${font.flag}.group`, font.group ?? ''), size: effective(scope.pluginId, font) })
  }
  return [...fonts.values()]
})
export function createPluginFontScope(pluginId: string, name: string) {
  const fonts = new Map<string, PluginFontInfo>(), identity = Symbol(pluginId)
  let closed = false, committed = false
  const info = (flag: string) => {
    const font = fonts.get(flag)
    if (!font) throw new Error(i18nT('m857f61b76ca6', { p0: (pluginId), p1: (flag) }))
    return readonly(reactive({ ...font, pluginId, pluginName: name, get size() { return effective(pluginId, font) } }))
  }
  return {
    registerFontInfo(input: PluginFontInfo) {
      if (closed) throw new Error(i18nT('m01c3ea924e90'))
      const font = parsePluginFontInfo(input), previous = fonts.get(font.flag)
      if (previous && JSON.stringify(previous) !== JSON.stringify(font)) throw new Error(i18nT('md059b9211794', { p0: (pluginId), p1: (font.flag) }))
      if (!previous) { if (fonts.size >= 96) throw new Error(i18nT('mb10d436d15ad')); fonts.set(font.flag, font); if (committed) revision.value++ }
      return info(font.flag)
    },
    getFontInfo: info,
    commit() { if (closed) throw new Error(i18nT('m01c3ea924e90')); scopes.set(identity, { pluginId, name, fonts }); committed = true; revision.value++ },
    dispose() { closed = true; if (scopes.delete(identity)) revision.value++ },
  }
}
export function setPluginFontSize(key: string, value?: number) {
  const font = registeredFonts.value.find(font => font.key === key)
  if (!font) throw new Error(i18nT('meb694ef5fe7b'))
  if (value === undefined) delete overrides[key]
  else {
    if (!Number.isFinite(value) || value < font.minSize || value > font.maxSize) throw new Error(i18nT('m82627e024379'))
    overrides[key] = value
  }
  try { localStorage.setItem(storageKey, JSON.stringify(overrides)); fontStorageError.value = '' }
  catch { fontStorageError.value = i18nT('m03fa934586d9') }
}
export const workbenchFonts = createPluginFontScope('builtin.workbench', i18nT('mf9e02d3c13aa'))
for (const font of [
  { flag: 'body', name: i18nT('m0b3c55b1efbf'), group: i18nT('m69fc8735da3d'), defaultSize: 16, minSize: 12, maxSize: 24 },
  { flag: 'caption', name: i18nT('m8a08328bf65a'), group: i18nT('m69fc8735da3d'), defaultSize: 14, minSize: 12, maxSize: 22 },
  { flag: 'heading', name: i18nT('m9a9cee1ba958'), group: i18nT('m69fc8735da3d'), defaultSize: 20, minSize: 16, maxSize: 32 },
  { flag: 'navigation', name: i18nT('md1ef7b144051'), group: i18nT('m37979829426b'), defaultSize: 15, minSize: 12, maxSize: 24 },
]) workbenchFonts.registerFontInfo(font)
workbenchFonts.commit()
if (typeof document !== 'undefined') for (const flag of ['body', 'caption', 'heading', 'navigation']) {
  const font = workbenchFonts.getFontInfo(flag)
  watch(() => font.size, size => document.documentElement.style.setProperty(`--font-${flag}`, `${size}px`), { immediate: true })
}
