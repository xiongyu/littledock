import { shallowRef } from 'vue'

export const remoteEditorRequest = shallowRef<{ sessionId: string; folder: string; name: string; autoOpen: boolean }>()
// Open only a ready editor URL. Checking and installation never create placeholder tabs.
export function openRemoteEditorTab(url: string) {
  const tab = window.open(url, '_blank')
  if (!tab) return false
  tab.opener = null
  return true
}

export function closeRemoteEditor() {
  remoteEditorRequest.value = undefined
}

export function openRemoteEditor(sessionId: string, folder: string, name: string, autoOpen = false) {
  closeRemoteEditor()
  remoteEditorRequest.value = { sessionId, folder, name, autoOpen }
}
