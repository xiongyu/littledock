import type { PluginWorkerApi } from '../../../backend/src/plugin-api.ts'
import { OptimizerEngine } from './engine.ts'
import { NativeWindowsAdapter } from './windows.ts'
import { randomUUID } from 'node:crypto'
export async function activate(api: PluginWorkerApi) {
  const adapter = new NativeWindowsAdapter()
  const engine = new OptimizerEngine(adapter, api.dataDirectory, () => api.host.acquireResource(), async () => (await api.host.vaultStatus()).unlocked)
  await engine.initialize()
  api.onDispose(() => engine.close())
  api.beforeUnload(() => engine.active ? '系统优化正在核对更改，结束后自动切换。' : undefined)
  const text = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 160) throw new Error('参数无效。'); return value }
  type Job = { owner: string; id: string; state: 'running' | 'done' | 'failed'; result?: unknown; error?: string; expires: number }
  const jobs = new Map<string, Job>()
  async function start(owner: string, action: () => Promise<unknown>) {
    for (const [id, job] of jobs) if (job.state !== 'running' && job.expires < Date.now()) jobs.delete(id)
    if ([...jobs.values()].some(job => job.state === 'running') || jobs.size >= 32) throw new Error('上一项操作仍在处理，请先核对结果。')
    const release = await api.host.acquireResource()
    if ([...jobs.values()].some(job => job.state === 'running') || jobs.size >= 32) { release(); throw new Error('上一项操作仍在处理，请先核对结果。') }
    const job: Job = { id: randomUUID(), owner, state: 'running', expires: Date.now() + 600000 }; jobs.set(job.id, job)
    void Promise.resolve().then(action).then(result => { job.result = result; job.state = 'done' }, cause => { job.error = cause instanceof Error ? cause.message : '操作失败，请核对状态。'; job.state = 'failed' }).finally(release)
    return { jobId: job.id }
  }
  api.registerRpc('job', { mutate: false, maintenance: 'read', handler: (owner, params) => { const job = jobs.get(text(params.jobId)); if (!job || job.owner !== owner) throw new Error('操作记录不属于当前页面，请查看恢复记录核对。'); return { state: job.state, result: job.result, error: job.error } } })
  api.registerRpc('scan', { mutate: true, handler: owner => start(owner, () => engine.scan()) })
  api.registerRpc('details', { mutate: false, handler: (_owner, params) => engine.details(text(params.id)) })
  api.registerRpc('preview', { mutate: true, handler: (owner, params) => { if (!Array.isArray(params.ids) || params.ids.length > 50) throw new Error('选择无效。'); const ids = params.ids.map(text); return start(owner, () => engine.preview(owner, ids)) } })
  api.registerRpc('apply', { mutate: true, handler: (owner, params) => start(owner, () => engine.apply(owner, text(params.planId), text(params.operationId))) })
  api.registerRpc('history', { mutate: true, handler: (owner, params) => start(owner, () => engine.history(params.page === undefined ? 0 : Number(params.page))) })
  api.registerRpc('restorePreview', { mutate: true, handler: (owner, params) => start(owner, () => engine.restorePreview(owner, text(params.id))) })
  api.registerRpc('openSettings', { mutate: true, handler: (_owner, params) => { if (!['startup', 'apps', 'storage'].includes(String(params.page))) throw new Error('系统页面无效。'); return adapter.openSettings(params.page as 'startup' | 'apps' | 'storage') } })
}
