import { Service, type Context } from 'cordis'
import { AppError } from './errors.ts'
declare module 'cordis' { interface Context { maintenance: MaintenanceService } }
/** Admission and in-flight accounting shared by browser RPC and MCP. Existing sessions may finish. */
export class MaintenanceService extends Service {
  draining = false
  sealed = false
  active = 0
  constructor(ctx: Context) { super(ctx, 'maintenance', true) }
  requireAvailable() { if (this.draining) throw new AppError('UPDATE_WAITING', '工作台正在等待安装更新，暂不接受新任务。可在更新页面取消。') }
  async run<T>(finish: boolean, work: () => T | Promise<T>): Promise<T> {
    if (this.sealed || !finish) this.requireAvailable()
    this.active++
    try { return await work() } finally { this.active-- }
  }
}
