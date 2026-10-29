export type UpdatePhase = 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'waiting' | 'installing' | 'succeeded' | 'failed'
export interface UpdateState {
  mode: 'source' | 'installed'; phase: UpdatePhase; currentVersion: string
  targetVersion?: string; notes?: string; progress?: number; message: string
  blockers?: string[]; checkedAt?: number; operationId?: string; recovered?: boolean
}
export type UpdateAction = 'status' | 'check' | 'download' | 'cancel' | 'install'
export interface UpdateRequest { action: UpdateAction; targetVersion?: string; interrupt?: boolean; operationId?: string }
export interface UpdateActivity { requests: number; blocking: string[]; connections: string[] }
