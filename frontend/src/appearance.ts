import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { installedThemes, requestedTheme } from './theme-market'

export const skins = [
  { id: 'mist', name: '雾松', description: '灰绿与松石', background: '#f3f5f2', sidebar: '#e9eee8', accent: '#426653' },
  { id: 'sand', name: '浅砂', description: '柔和的暖灰', background: '#f3f0eb', sidebar: '#eae5de', accent: '#78604e' },
  { id: 'fjord', name: '远山', description: '清透的灰蓝', background: '#edf2f5', sidebar: '#e3eaf0', accent: '#496a7d' },
  { id: 'night', name: '夜航', description: '安静的深色', background: '#202824', sidebar: '#19201c', accent: '#a0bda8' },
  { id: 'mist-lake', name: '雾岚湖畔', description: '山湖晨雾 · 风景', background: '#e8eeec', sidebar: '#dce4df', accent: '#48695c' },
] as const

export const scenicBackgrounds = {
  left: '/skins/mist-lake/sidebar.png',
  right: '/skins/mist-lake/workspace.png',
} as const

type SkinId = (typeof skins)[number]['id'] | `plugin:${string}`
export type BackgroundSide = 'left' | 'right'
export interface BackgroundSettings {
  color: string
  preset?: 'mist-lake' | 'solid' | 'plugin'
  image?: string
}
interface Appearance {
  skin: SkinId
  accent: string
  left: BackgroundSettings
  right: BackgroundSettings
}

const storageKey = 'webnav.appearance.v1'
const databaseName = 'webnav-appearance'
const validHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

function defaults(): Appearance {
  const skin = window.matchMedia('(prefers-color-scheme: dark)').matches ? skins[3] : skins[0]
  return { skin: skin.id, accent: skin.accent,
    left: { color: skin.sidebar }, right: { color: skin.background } }
}

function readBackground(raw: unknown, fallback: BackgroundSettings): BackgroundSettings {
  if (!raw || typeof raw !== 'object') return fallback
  const data = raw as Record<string, unknown>
  return { color: validHex(data.color) ? data.color : fallback.color, ...(data.preset === 'mist-lake' || data.preset === 'solid' || data.preset === 'plugin' ? { preset: data.preset } : {}), ...(typeof data.image === 'string' && /^\/plugins\/[a-z0-9.-]+\/[a-f0-9]+\/[a-zA-Z0-9_./-]+$/.test(data.image) ? { image: data.image } : {}) }
}

function load(): Appearance {
  const fallback = defaults()
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!raw || typeof raw !== 'object') return fallback
    const data = raw as Record<string, unknown>
    return {
      skin: typeof data.skin === 'string' && /^plugin:[a-z0-9.-]+$/.test(data.skin) ? data.skin as SkinId : skins.find(skin => skin.id === data.skin)?.id ?? fallback.skin,
      accent: validHex(data.accent) ? data.accent : fallback.accent,
      left: readBackground(data.left, fallback.left),
      right: readBackground(data.right, fallback.right),
    }
  } catch { return fallback }
}

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(index => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
}

export function contrastColor(hex: string): string {
  const light = '#fcfdfb'
  const dark = '#152019'
  const value = luminance(hex)
  return (luminance(light) + 0.05) / (value + 0.05) > (value + 0.05) / (luminance(dark) + 0.05) ? light : dark
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('assets')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('浏览器暂时无法保存背景图片。'))
    request.onblocked = () => reject(new Error('请关闭其他预览标签页后重试。'))
  })
}

async function imageStorage(side: BackgroundSide, action: 'read' | 'write' | 'delete', value?: Blob): Promise<unknown> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('assets', action === 'read' ? 'readonly' : 'readwrite')
    const store = transaction.objectStore('assets')
    const request = action === 'read' ? store.get(side) : action === 'delete' ? store.delete(side) : store.put(value, side)
    let result: unknown
    request.onsuccess = () => { result = request.result }
    transaction.oncomplete = () => { db.close(); resolve(result) }
    transaction.onerror = () => { db.close(); reject(new Error('背景图片未能保存，请检查浏览器存储空间。')) }
    transaction.onabort = () => { db.close(); reject(new Error('背景图片保存已取消。')) }
  })
}

export function useAppearance() {
  const availableSkins = computed(() => [...skins, ...installedThemes.value.map(p => ({ id: p.id as SkinId, name: p.name, description: p.description, ...p.theme }))])
  const settings = ref<Appearance>(load())
  const uploadedImages = ref<Record<BackgroundSide, string>>({ left: '', right: '' })
  const backgroundImages = computed<Record<BackgroundSide, string>>(() => ({
    left: settings.value.left.preset === 'plugin' ? settings.value.left.image ?? '' : settings.value.left.preset === 'mist-lake' ? scenicBackgrounds.left : settings.value.left.preset === 'solid' ? '' : uploadedImages.value.left,
    right: settings.value.right.preset === 'plugin' ? settings.value.right.image ?? '' : settings.value.right.preset === 'mist-lake' ? scenicBackgrounds.right : settings.value.right.preset === 'solid' ? '' : uploadedImages.value.right,
  }))
  const storageError = ref('')
  const imageBusy = ref(false)
  const imageError = ref('')
  const generation = { left: 0, right: 0 }
  let disposed = false
  const isDark = computed(() => contrastColor(settings.value.right.color) === '#fcfdfb')
  const sidebarDark = computed(() => contrastColor(settings.value.left.color) === '#fcfdfb')

  function replaceImage(side: BackgroundSide, blob?: Blob) {
    if (uploadedImages.value[side]) URL.revokeObjectURL(uploadedImages.value[side])
    uploadedImages.value[side] = blob ? URL.createObjectURL(blob) : ''
  }

  for (const side of ['left', 'right'] as const) void imageStorage(side, 'read').then(blob => {
    if (!disposed && generation[side] === 0 && blob instanceof Blob) replaceImage(side, blob)
  }).catch(() => { /* 图片存储不可用时仍可使用纯色主题。 */ })

  watch(settings, value => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); storageError.value = '' }
    catch { storageError.value = '当前外观已生效，浏览器未能保存设置。' }
  }, { deep: true })

  watchEffect(() => {
    const root = document.documentElement
    root.dataset.theme = isDark.value ? 'dark' : 'light'
    root.style.colorScheme = isDark.value ? 'dark' : 'light'
    root.style.setProperty('--page', settings.value.right.color)
    root.style.setProperty('--accent', settings.value.accent)
    root.style.setProperty('--accent-ink', contrastColor(settings.value.accent))
  })

  function selectSkin(id: SkinId) {
    if (id.startsWith('plugin:')) {
      const entry = installedThemes.value.find(p => p.id === id); if (!entry) return
      settings.value = { skin: id, accent: entry.theme.accent, left: { color: entry.theme.sidebar, preset: 'plugin', image: entry.theme.backgrounds?.left }, right: { color: entry.theme.background, preset: 'plugin', image: entry.theme.backgrounds?.right } }
      return
    }
    const skin = skins.find(item => item.id === id)!
    settings.value = { ...settings.value, skin: id, accent: skin.accent,
      left: { color: skin.sidebar, ...(id === 'mist-lake' ? {preset: 'mist-lake' as const} : {}) },
      right: { color: skin.background, ...(id === 'mist-lake' ? {preset: 'mist-lake' as const} : {}) } }
  }
  watch(requestedTheme, value => { if(value) selectSkin(value.id === 'builtin.appearance' ? 'mist' : value.id as SkinId) })

  async function setBackground(side: BackgroundSide, file?: File) {
    if (!file || imageBusy.value) return
    imageError.value = ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      imageError.value = '请选择 JPG、PNG 或 WebP 图片。'; return
    }
    if (file.size > 5 * 1024 * 1024) { imageError.value = '图片请控制在 5 MB 以内。'; return }
    imageBusy.value = true
    generation[side]++
    try {
      const bitmap = await createImageBitmap(file)
      const pixels = bitmap.width * bitmap.height
      bitmap.close()
      if (pixels > 24_000_000) throw new Error('图片尺寸过大，请缩小到 2,400 万像素以内。')
      await imageStorage(side, 'write', file)
      if (!disposed) { replaceImage(side, file); delete settings.value[side].preset }
    } catch (error) {
      imageError.value = error instanceof Error ? error.message : '无法读取图片，请换一张试试。'
    } finally { imageBusy.value = false }
  }

  async function removeBackground(side: BackgroundSide) {
    if (imageBusy.value) return
    if (settings.value[side].preset === 'mist-lake' || settings.value[side].preset === 'plugin') {
      settings.value[side].preset = 'solid'; imageError.value = ''; return
    }
    imageBusy.value = true
    generation[side]++
    try { await imageStorage(side, 'delete'); replaceImage(side); delete settings.value[side].preset; imageError.value = '' }
    catch (error) { imageError.value = error instanceof Error ? error.message : '暂时无法移除背景。' }
    finally { imageBusy.value = false }
  }

  async function reset() {
    settings.value = defaults()
    await removeBackground('left')
    await removeBackground('right')
  }

  onBeforeUnmount(() => { disposed = true; replaceImage('left'); replaceImage('right') })
  return { settings, availableSkins, backgroundImages, isDark, sidebarDark, imageBusy, imageError, storageError, selectSkin, setBackground, removeBackground, reset }
}
