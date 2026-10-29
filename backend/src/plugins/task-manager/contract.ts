import type { TaskManagerTarget } from '@webnav/shared'
import type { TaskManagerEngine } from './index.ts'

export interface TaskManagerConfig { directory: string; packageDirectory?: string; homeDirectory?: string }
export interface TaskManagerHost {
  authorize(owner: string): Promise<void>
  available(): Promise<void>
  reserve(owner: string, target: TaskManagerTarget): Promise<{ id: string; label: string }>
  release(id: string): Promise<void>
  connection(owner: string, id: string): Promise<{ host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string }>
  fingerprint(owner: string, id: string, next?: { fingerprint: string; previous: string }): Promise<string>
  onLock(callback: () => void): () => void
}
export const taskManagerMethods = ['start', 'status', 'install', 'hostKeyDecision', 'snapshot', 'details', 'commandLine', 'prepareAction', 'applyAction', 'recordingStatus', 'configureRecording', 'queryHistory', 'historyPoint', 'close', 'closeOwner'] as const
export type TaskManagerMethods = Pick<TaskManagerEngine, typeof taskManagerMethods[number]>
export type TaskManagerClient = TaskManagerMethods & { readonly size: number; readonly sizeRemote: number; hasResources(): boolean }
