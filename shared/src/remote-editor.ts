export type EditorPlatform = 'linux-x64' | 'linux-arm64' | 'windows-x64' | 'windows-arm64'
export interface RemoteEditorStatus {
  id: string
  sessionId: string
  folder: string
  platform?: EditorPlatform
  product?: string
  version?: string
  state: 'checking' | 'needs-install' | 'downloading' | 'uploading' | 'installing' | 'starting' | 'ready' | 'error' | 'stopped'
  message: string
  progress?: number
  url?: string
  licenseUrl?: string
}
