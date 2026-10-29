import { ref } from 'vue'
import type { InstalledTheme } from '@webnav/shared'
export const installedThemes = ref<InstalledTheme[]>([])
export const requestedTheme = ref<{ id: string; at: number }>()
export function applyMarketTheme(id: string) { requestedTheme.value = { id, at: Date.now() } }
