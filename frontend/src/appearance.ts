
import { pluginI18n, pluginText } from './i18n.ts'
const { t: i18nT } = pluginI18n('builtin.appearance')
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { installedThemes, requestedTheme } from './theme-market'

export const skins = [
  { id: 'mist', get name() { return i18nT('m3d1c9ac6c42a') }, get description() { return i18nT('m44713f565dfa') }, background: '#f3f5f2', sidebar: '#e9eee8', accent: '#426653' },
  { id: 'sand', get name() { return i18nT('mf75ef355acdf') }, get description() { return i18nT('m36f26bb42715') }, background: '#f3f0eb', sidebar: '#eae5de', accent: '#78604e' },
  { id: 'fjord', get name() { return i18nT('mfad55058ad89') }, get description() { return i18nT('m130645619fb4') }, background: '#edf2f5', sidebar: '#e3eaf0', accent: '#496a7d' },
  { id: 'night', get name() { return i18nT('m2020c381e110') }, get description() { return i18nT('mf17cb1c6c0f6') }, background: '#202824', sidebar: '#19201c', accent: '#a0bda8' },
  { id: 'mist-lake', get name() { return i18nT('m757c6f40a4b8') }, get description() { return i18nT('m34584a525711') }, background: '#e8eeec', sidebar: '#dce4df', accent: '#48695c' },
  { id: 'harbor-dawn', get name() { return i18nT('skin.harborDawn.name') }, get description() { return i18nT('skin.harborDawn.description') }, background: '#e8eeec', sidebar: '#dce4df', accent: '#31584b' },
  { id: 'harbor-dusk', get name() { return i18nT('skin.harborDusk.name') }, get description() { return i18nT('skin.harborDusk.description') }, background: '#243239', sidebar: '#202c29', accent: '#a0bda8' },
] as const

const scenicBackgrounds = {
  'mist-lake': { left: '/skins/mist-lake/sidebar.png', right: '/skins/mist-lake/workspace.png' },
  'harbor-dawn': { left: '/skins/harbor-dawn/sidebar.png', right: '/skins/harbor-dawn/workspace.png' },
  'harbor-dusk': { left: '/skins/harbor-dusk/sidebar.png', right: '/skins/harbor-dusk/workspace.png' },
} as const

type ScenicPreset = keyof typeof scenicBackgrounds
function isScenicPreset(value: unknown): value is ScenicPreset {
  return typeof value === 'string' && Object.hasOwn(scenicBackgrounds, value)
}
export function scenicBackgroundFor(id: string | undefined) {
  return isScenicPreset(id) ? scenicBackgrounds[id] : undefined
}

type SkinId = (typeof skins)[number]['id'] | `plugin:${string}`
export type BackgroundSide = 'left' | 'right'
export interface BackgroundMedia { src: string; kind: 'image' | 'video' }
export interface BackgroundSettings {
  color: string
  preset?: ScenicPreset | 'solid' | 'plugin'
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
const videoTypes = new Set(['video/mp4', 'video/webm'])

async function validateVideo(file: File): Promise<void> {
  const video = document.createElement('video'), url = URL.createObjectURL(file)
  video.muted = true; video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); video.onloadeddata = null; video.onerror = null
        error ? reject(error) : resolve()
      }
      const timer = window.setTimeout(() => finish(new Error(i18nT('background.videoUnreadable'))), 10000)
      video.onerror = () => finish(new Error(i18nT('background.videoUnreadable')))
      video.onloadeddata = () => finish(
        video.videoWidth <= 0 || video.videoHeight <= 0
          ? new Error(i18nT('background.videoUnreadable'))
          : video.videoWidth * video.videoHeight > 3840 * 2160 ? new Error(i18nT('background.videoResolution')) : undefined)
      video.src = url
    })
  } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) }
}

function defaults(): Appearance {
  const id = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'harbor-dusk' : 'harbor-dawn'
  const skin = skins.find(item => item.id === id)!
  return { skin: skin.id, accent: skin.accent,
    left: { color: skin.sidebar, preset: id }, right: { color: skin.background, preset: id } }
}

function readBackground(raw: unknown, fallback: BackgroundSettings): BackgroundSettings {
  if (!raw || typeof raw !== 'object') return fallback
  const data = raw as Record<string, unknown>
  return { color: validHex(data.color) ? data.color : fallback.color, ...(isScenicPreset(data.preset) || data.preset === 'solid' || data.preset === 'plugin' ? { preset: data.preset } : {}), ...(typeof data.image === 'string' && /^\/plugins\/[a-z0-9.-]+\/[a-f0-9]+\/[a-zA-Z0-9_./-]+$/.test(data.image) ? { image: data.image } : {}) }
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
    request.onerror = () => reject(new Error(i18nT('mc98667121f87')))
    request.onblocked = () => reject(new Error(i18nT('m7bc7cc3f8c9a')))
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
    transaction.onerror = () => { db.close(); reject(new Error(i18nT('m1fbb76023081'))) }
    transaction.onabort = () => { db.close(); reject(new Error(i18nT('m08140fdf5971'))) }
  })
}

export function useAppearance() {
  const availableSkins = computed(() => [...skins, ...installedThemes.value.map(p => ({ id: p.id as SkinId, name: pluginText(p.id, 'metadata.name', p.name), description: pluginText(p.id, 'metadata.description', p.description), ...p.theme }))])
  const settings = ref<Appearance>(load())
  const uploadedImages = ref<Record<BackgroundSide, string>>({ left: '', right: '' })
  const uploadedKinds = ref<Record<BackgroundSide, BackgroundMedia['kind']>>({ left: 'image', right: 'image' })
  const backgroundMedia = computed<Record<BackgroundSide, BackgroundMedia | undefined>>(() => ({
    left: backgroundAsset('left'), right: backgroundAsset('right'),
  }))
  function backgroundAsset(side: BackgroundSide): BackgroundMedia | undefined {
    const background = settings.value[side]
    if (background.preset === 'plugin') return background.image ? { src: background.image, kind: 'image' } : undefined
    if (background.preset === 'solid') return undefined
    const scene = scenicBackgroundFor(background.preset)?.[side]
    return scene ? { src: scene, kind: 'image' } : uploadedImages.value[side] ? { src: uploadedImages.value[side], kind: uploadedKinds.value[side] } : undefined
  }
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
    uploadedKinds.value[side] = blob && videoTypes.has(blob.type) ? 'video' : 'image'
  }

  for (const side of ['left', 'right'] as const) void imageStorage(side, 'read').then(blob => {
    if (!disposed && generation[side] === 0 && blob instanceof Blob) replaceImage(side, blob)
  }).catch(() => { /* 图片存储不可用时仍可使用纯色主题。 */ })

  watch(settings, value => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); storageError.value = '' }
    catch { storageError.value = i18nT('me9ce1d0baa92') }
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
    if (imageBusy.value) return
    if (id.startsWith('plugin:')) {
      const entry = installedThemes.value.find(p => p.id === id); if (!entry) return
      settings.value = { skin: id, accent: entry.theme.accent, left: { color: entry.theme.sidebar, preset: 'plugin', image: entry.theme.backgrounds?.left }, right: { color: entry.theme.background, preset: 'plugin', image: entry.theme.backgrounds?.right } }
      return
    }
    const skin = skins.find(item => item.id === id)
    if (!skin) return
    settings.value = { ...settings.value, skin: id, accent: skin.accent,
      left: { color: skin.sidebar, ...(isScenicPreset(id) ? { preset: id } : {}) },
      right: { color: skin.background, ...(isScenicPreset(id) ? { preset: id } : {}) } }
  }
  watch(requestedTheme, value => { if(value) selectSkin(value.id === 'builtin.appearance' ? defaults().skin : value.id as SkinId) })

  async function setBackground(side: BackgroundSide, file?: File) {
    if (!file || imageBusy.value) return
    imageError.value = ''
    const isVideo = videoTypes.has(file.type)
    if (!isVideo && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      imageError.value = i18nT('mab3f74071e0a'); return
    }
    if (file.size > (isVideo ? 50 : 5) * 1024 * 1024) { imageError.value = i18nT(isVideo ? 'background.videoSize' : 'm1ff77f9a594e'); return }
    imageBusy.value = true
    generation[side]++
    try {
      if (isVideo) await validateVideo(file)
      else {
        const bitmap = await createImageBitmap(file)
        const pixels = bitmap.width * bitmap.height
        bitmap.close()
        if (pixels > 24_000_000) throw new Error(i18nT('m72b792ec3857'))
      }
      if (disposed) return
      await imageStorage(side, 'write', file)
      if (!disposed) { replaceImage(side, file); delete settings.value[side].preset }
    } catch (error) {
      imageError.value = error instanceof Error ? error.message : i18nT('m9eb51833a913')
    } finally { imageBusy.value = false }
  }

  async function removeBackground(side: BackgroundSide) {
    if (imageBusy.value) return
    if (isScenicPreset(settings.value[side].preset) || settings.value[side].preset === 'plugin') {
      settings.value[side].preset = 'solid'; imageError.value = ''; return
    }
    imageBusy.value = true
    generation[side]++
    try { await imageStorage(side, 'delete'); replaceImage(side); delete settings.value[side].preset; imageError.value = '' }
    catch (error) { imageError.value = error instanceof Error ? error.message : i18nT('m3d9d1e96d4b2') }
    finally { imageBusy.value = false }
  }

  async function reset() {
    if (imageBusy.value) return
    imageBusy.value = true
    generation.left++; generation.right++
    try {
      await Promise.all([imageStorage('left', 'delete'), imageStorage('right', 'delete')])
      if (!disposed) {
        replaceImage('left'); replaceImage('right')
        settings.value = defaults(); imageError.value = ''
      }
    } catch (error) { imageError.value = error instanceof Error ? error.message : i18nT('m3d9d1e96d4b2') }
    finally { imageBusy.value = false }
  }

  onBeforeUnmount(() => { disposed = true; replaceImage('left'); replaceImage('right') })
  return { settings, availableSkins, backgroundMedia, isDark, sidebarDark, imageBusy, imageError, storageError, selectSkin, setBackground, removeBackground, reset }
}
