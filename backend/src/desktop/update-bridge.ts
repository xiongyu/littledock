import { randomUUID } from 'node:crypto'
import { Service, type Context } from 'cordis'
import { WEBNAV_VERSION, type UpdateRequest, type UpdateState, type UpdateActivity } from '@webnav/shared'
import { AppError, record, string } from '../core/errors.ts'

export type UpdateControl = (request: UpdateRequest) => Promise<UpdateState>
declare module 'cordis' { interface Context { updates: UpdateService } }
export class UpdateService extends Service {
  private control?: UpdateControl
  constructor(ctx: Context, control?: UpdateControl) { super(ctx, 'updates', true); this.control = control }
  async dispatch(method: string, input: unknown, operationId?: string) {
    const p = record(input), action = method.slice('updates.'.length)
    if (!['status', 'check', 'download', 'cancel', 'install'].includes(action)) throw new AppError('NOT_FOUND', '未知更新操作。')
    if (!this.control) {
      if (action !== 'status') throw new AppError('UPDATE_UNAVAILABLE', '源码模式请通过构建和重启更新；正式安装版支持在线更新。')
      return { mode: 'source', phase: 'unavailable', currentVersion: WEBNAV_VERSION, message: '当前为源码模式。正式安装版提供在线更新。' } satisfies UpdateState
    }
    if (p.interrupt !== undefined && typeof p.interrupt !== 'boolean') throw new AppError('INVALID_ARGUMENT', '更新选项无效。')
    return this.control({ action: action as UpdateRequest['action'], ...(p.targetVersion === undefined ? {} : { targetVersion: string(p.targetVersion, 100) }), ...(p.interrupt === true ? { interrupt: true } : {}), ...(action === 'status' || action === 'check' ? {} : { operationId: string(operationId, 100) }) })
  }
}

/** IPC is only connected by main after its singleton owner has been verified. */
export function workerUpdateControl(): UpdateControl {
  const pending = new Map<string, { resolve: (state: UpdateState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  process.on('message', value => {
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'update.response' || !('id' in value) || typeof value.id !== 'string') return
    const task = pending.get(value.id); if (!task) return
    pending.delete(value.id); clearTimeout(task.timer)
    if ('error' in value) task.reject(new AppError('UPDATE_FAILED', String(value.error)))
    else if ('state' in value) task.resolve(value.state as UpdateState)
  })
  return request => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error('更新请求过多，请稍后再试。'))
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('更新操作结果暂时未知，请读取更新状态。')) }, 20_000)
    pending.set(id, { resolve, reject, timer }); process.send?.({ type: 'update.request', id, request })
  })
}

export function updateActivity(ctx: Context): UpdateActivity {
  const blocking: string[] = [], connections: string[] = []
  if (ctx.plugins.manager.activity) blocking.push('插件安装或设置正在处理')
  if (ctx.plugins.activity) blocking.push('插件任务或清理仍在进行')
  if (ctx.configSync.status().busy) blocking.push('配置同步仍在进行')
  if (ctx.sshFiles.updateBusy) blocking.push('文件传输或编辑写入仍在进行')
  if (ctx.webBookmarks.activity) blocking.push('网页截图仍在生成')
  if (ctx.sessions.size) connections.push(`${ctx.sessions.size} 个 SSH / 本地终端`)
  if (ctx.get('taskManager')?.size) connections.push(`${ctx.taskManager.size} 个任务管理器`)
  if (ctx.plugins.resourceCount) connections.push('AI 或插件后台任务')
  if (ctx.desktops.size + ctx.deviceSessions.size) connections.push(`${ctx.desktops.size + ctx.deviceSessions.size} 个桌面 / 设备连接`)
  return { requests: ctx.maintenance.active, blocking, connections }
}
