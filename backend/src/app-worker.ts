import { parentPort, workerData } from 'node:worker_threads'
import type { Context } from 'cordis'
import { WorkerRpc } from './plugin-system/worker-rpc.ts'
import { updateActivity } from './desktop/update-bridge.ts'
import { parseSessionCounts } from './desktop/session-status.ts'

if (!parentPort) throw new Error('共享运行入口只能在 Worker 中运行。')
const peer = new WorkerRpc(parentPort)
let ctx: Context | undefined
let serverCount: number | undefined
const status = () => {
  let counts, activity
  try { counts = ctx && parseSessionCounts({ ...ctx.sessions.counts(), ...ctx.desktops.counts(), ...ctx.deviceSessions.counts() }) } catch { /* Optional provider counts remain unknown. */ }
  try { activity = ctx && updateActivity(ctx) } catch { activity = { requests: 1, blocking: ['插件运行状态暂不可用'], connections: [] } }
  peer.event('status', { sampledAt: Date.now(), serverCount, counts, activity })
}
const timer = setInterval(status, 1000); timer.unref()
peer.handler = async (method, args) => {
  if (method === 'stop') { clearInterval(timer); try { await ctx?.plugins.close() } finally { await ctx?.stop() }; return }
  if (!ctx) throw Error('共享插件 Worker 尚未就绪。')
  if (method === 'update.prepare') {
    ctx.maintenance.draining = true
    const activity = updateActivity(ctx)
    if (!activity.requests && !activity.blocking.length && (args[0] === true || !activity.connections.length)) ctx.maintenance.sealed = true
    return activity
  }
  if (method === 'update.resume') { ctx.maintenance.draining = false; ctx.maintenance.sealed = false; return updateActivity(ctx) }
  throw Error('未知运行控制消息。')
}
// Dynamic imports are intentional: no business module enters the main-thread module graph.
if (process.platform === 'win32' && process.arch === 'x64' && workerData.config.rdpEnabled !== false && process.env.WEBNAV_RDP_ENABLED !== '0') {
  const { prepareRdpRuntime } = await import('./plugins/rdp/runtime.ts'); await prepareRdpRuntime()
}
const { createApp } = await import('./app.ts')
await createApp({ ...workerData.config, runtimeGateway: { token: workerData.token },
  ...(workerData.updates ? { updateControl: (request: unknown) => peer.call('updates', [request]) } : {}),
  onTransportReady: (context: Context) => {
    ctx = context
    const updateCount = () => { serverCount = context.storage.snapshot().snapshot.servers.length }
    updateCount(); context.on('dispose', context.storage.subscribe(updateCount))
    status(); peer.event('ready', context.transport.listenPort)
  },
})
status()
