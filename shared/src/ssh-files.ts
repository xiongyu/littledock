export type RemoteTextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'gb18030'
export interface RemoteTextFile { path: string; text: string; version: string; encoding: RemoteTextEncoding; bom: boolean; lineEnding: 'LF' | 'CRLF' }
export interface RemoteFileJob { id: string; path: string; kind: 'compress' | 'extract' | 'external'; state: 'working' | 'watching' | 'syncing' | 'done' | 'error' | 'conflict' | 'stopped'; progress: number; total: number; message: string; localPath?: string }
