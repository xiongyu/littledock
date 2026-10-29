import type { Connection } from '@webnav/shared'

export interface TerminalProcess {
  write(bytes: Buffer): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  close(): void
}
export type TerminalProvider = (options: {
  connection: Connection; cols: number; rows: number; signal: AbortSignal
  output: (bytes: Buffer) => void; exit: () => void
}) => Promise<TerminalProcess>
