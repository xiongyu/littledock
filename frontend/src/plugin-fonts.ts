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
  } catch { fontStorageError.value = '字号设置读取失败，暂时使用注册默认值。' }
}
if (typeof localStorage !== 'undefined') { try { readOverrides(localStorage.getItem(storageKey)) } catch { fontStorageError.value = '当前浏览器无法读取字号设置。' } }
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === storageKey) readOverrides(event.newValue) })
function effective(pluginId: string, font: PluginFontInfo) { return Math.max(font.minSize, Math.min(font.maxSize, overrides[`${pluginId}/${font.flag}`] ?? font.defaultSize)) }
export const registeredFonts: ComputedRef<RegisteredFont[]> = computed(() => {
  void revision.value
  const fonts = new Map<string, RegisteredFont>()
  for (const scope of scopes.values()) for (const font of scope.fonts.values()) {
    const key = `${scope.pluginId}/${font.flag}`
    fonts.set(key, { ...font, key, pluginId: scope.pluginId, pluginName: scope.name, size: effective(scope.pluginId, font) })
  }
  return [...fonts.values()]
})
export function createPluginFontScope(pluginId: string, name: string) {
  const fonts = new Map<string, PluginFontInfo>(), identity = Symbol(pluginId)
  let closed = false, committed = false
  const info = (flag: string) => {
    const font = fonts.get(flag)
    if (!font) throw new Error(`未注册字体：${pluginId}/${flag}`)
    return readonly(reactive({ ...font, pluginId, pluginName: name, get size() { return effective(pluginId, font) } }))
  }
  return {
    registerFontInfo(input: PluginFontInfo) {
      if (closed) throw new Error('字体注册作用域已关闭。')
      const font = parsePluginFontInfo(input), previous = fonts.get(font.flag)
      if (previous && JSON.stringify(previous) !== JSON.stringify(font)) throw new Error(`字体声明冲突：${pluginId}/${font.flag}`)
      if (!previous) { if (fonts.size >= 96) throw new Error('字体注册数量超限。'); fonts.set(font.flag, font); if (committed) revision.value++ }
      return info(font.flag)
    },
    getFontInfo: info,
    commit() { if (closed) throw new Error('字体注册作用域已关闭。'); scopes.set(identity, { pluginId, name, fonts }); committed = true; revision.value++ },
    dispose() { closed = true; if (scopes.delete(identity)) revision.value++ },
  }
}
export function setPluginFontSize(key: string, value?: number) {
  const font = registeredFonts.value.find(font => font.key === key)
  if (!font) throw new Error('该字体已不再注册。')
  if (value === undefined) delete overrides[key]
  else {
    if (!Number.isFinite(value) || value < font.minSize || value > font.maxSize) throw new Error('字号超出允许范围。')
    overrides[key] = value
  }
  try { localStorage.setItem(storageKey, JSON.stringify(overrides)); fontStorageError.value = '' }
  catch { fontStorageError.value = '字号已在当前页面生效，但未能保存到浏览器。' }
}
export const workbenchFonts = createPluginFontScope('builtin.workbench', '工作台')
for (const font of [
  { flag: 'body', name: '页面正文', group: '通用界面', defaultSize: 16, minSize: 12, maxSize: 24 },
  { flag: 'caption', name: '辅助说明', group: '通用界面', defaultSize: 14, minSize: 12, maxSize: 22 },
  { flag: 'heading', name: '区域标题', group: '通用界面', defaultSize: 20, minSize: 16, maxSize: 32 },
  { flag: 'navigation', name: '导航与标签', group: '工作区', defaultSize: 15, minSize: 12, maxSize: 24 },
]) workbenchFonts.registerFontInfo(font)
workbenchFonts.commit()
if (typeof document !== 'undefined') for (const flag of ['body', 'caption', 'heading', 'navigation']) {
  const font = workbenchFonts.getFontInfo(flag)
  watch(() => font.size, size => document.documentElement.style.setProperty(`--font-${flag}`, `${size}px`), { immediate: true })
}
