import type { Context } from 'cordis'
import { AppError } from './errors.ts'

/** Includes independent remote collectors; reservations must happen before the next await. */
export function connectionCount(ctx: Context): number {
  return (ctx.get('sessions')?.size ?? 0) + (ctx.get('desktops')?.size ?? 0) +
    (ctx.get('deviceSessions')?.size ?? 0) + (ctx.get('taskManager')?.sizeRemote ?? 0)
}
export function requireConnectionCapacity(ctx: Context): void {
  if (connectionCount(ctx) >= 8) throw new AppError('BUSY', '最多同时打开 8 个连接，包含远程任务管理器。')
}
