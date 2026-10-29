import { Worker } from 'node:worker_threads'
import { createServer, request, type ServerResponse, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WorkerRpc } from './plugin-system/worker-rpc.ts'
import { bounded } from './plugin-system/lifecycle.ts'
import type { UpdateControl } from './desktop/update-bridge.ts'
import type { UpdateActivity, UpdateRequest } from '@webnav/shared'
import type { SessionCounts } from './desktop/session-status.ts'
import type { TaskManagerConfig } from './plugins/task-manager/contract.ts'

export interface ApplicationConfig {
  directory: string; port: number; frontendRoot: string; devOrigin?: string
  pluginMarket?: string; disablePlugins?: boolean; bundledPluginsDirectory?: string
  rdpEnabled?: boolean; updateControl?: UpdateControl
  taskManagerConfig?: Omit<TaskManagerConfig, 'directory'>
}
export interface RuntimeStatus {
  threadId: number; state: 'starting' | 'ready' | 'unresponsive' | 'failed' | 'stopped'
  sampledAt: number; serverCount?: number; counts?: SessionCounts; activity?: UpdateActivity
}

/** Main-thread gateway: imports framework code only. All business modules live in app-worker. */
export async function startApplication(config: ApplicationConfig) {
  const { updateControl, ...workerConfig } = config
  const token = randomBytes(32).toString('hex'), source = import.meta.url.endsWith('.ts')
  const expectedHost = `127.0.0.1:${config.port}`, sockets = new Set<Duplex>()
  let internalPort = 0, stopping = false, closing: Promise<void> | undefined
  let heartbeat = Date.now(), status: RuntimeStatus = { threadId: -1, state: 'starting', sampledAt: 0 }
  const unavailable = (response: ServerResponse) => { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-WebNav-Service': '1' }); response.end('插件运行线程暂不可用。主框架仍在运行，请稍后重试或从托盘重启。') }
  const available = () => internalPort > 0 && status.state === 'ready' && !stopping
  const headers = (req: IncomingMessage) => ({ ...req.headers, host: expectedHost, 'x-webnav-runtime': token })
  const server = createServer((req, res) => {
    if (req.headers.host !== expectedHost || req.headers['x-webnav-runtime']) { res.writeHead(403); res.end(); return }
    if (!available()) { unavailable(res); return }
    const upstream = request({ host: '127.0.0.1', port: internalPort, path: req.url, method: req.method, headers: headers(req), timeout: 15000 }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res)
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => { if (!res.headersSent) unavailable(res); else res.destroy() })
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream)
  })
  server.maxConnections = 128
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== expectedHost || req.headers['x-webnav-runtime'] || !available()) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
    const upstream = request({ host: '127.0.0.1', port: internalPort, path: req.url, headers: headers(req), timeout: 10000 })
    upstream.on('upgrade', (reply, remote, rest) => {
      remote.setTimeout(0); sockets.add(remote); remote.on('close', () => sockets.delete(remote))
      socket.write(`HTTP/1.1 ${reply.statusCode ?? 101} Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) remote.write(head)
      if (rest.length) socket.write(rest)
      // stream.pipe supplies backpressure; no application output queue is retained in the gateway.
      socket.pipe(remote).pipe(socket)
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy())
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy())
    })
    upstream.on('response', reply => { socket.end(`HTTP/1.1 ${reply.statusCode ?? 403} Forbidden\r\nConnection: close\r\n\r\n`); reply.resume() })
    upstream.on('timeout', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy()); upstream.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  let worker: Worker
  try {
    worker = new Worker(new URL(source ? './app-worker.ts' : './app-worker.js', import.meta.url), {
      workerData: { config: workerConfig, token, updates: !!updateControl }, execArgv: source ? ['--experimental-strip-types'] : [],
    })
  } catch (error) { server.close(); throw error }
  status.threadId = worker.threadId
  const peer = new WorkerRpc(worker)
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const failed = () => {
    if (stopping || status.state === 'failed') return
    status = { ...status, state: 'failed' }; peer.close()
    void worker.terminate()
    for (const socket of sockets) socket.destroy()
    rejectReady(new Error('共享插件 Worker 异常退出。'))
    process.send?.({ type: 'sessions.counts', nonce: process.env.WEBNAV_WORKER_NONCE, counts: null }, () => {})
  }
  worker.on('error', failed); worker.on('exit', failed)
  peer.onClose = failed
  peer.handler = (method, args) => {
    if (method === 'updates' && updateControl) return updateControl(args[0] as UpdateRequest)
    throw new Error('主框架未提供此接口。')
  }
  peer.onEvent = (name, value) => {
    if (name === 'ready' && Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535) { internalPort = Number(value); heartbeat = Date.now(); status.state = 'ready'; resolveReady() }
    if (name === 'status' && value && typeof value === 'object') {
      heartbeat = Date.now()
      const next = value as Omit<RuntimeStatus, 'state' | 'threadId'>
      status = { ...next, threadId: worker.threadId, state: internalPort ? 'ready' : 'starting' }
      process.send?.({ type: 'sessions.counts', nonce: process.env.WEBNAV_WORKER_NONCE, counts: next.counts ?? null }, () => {})
    }
  }
  const monitor = setInterval(() => {
    if (stopping || status.state === 'failed' || Date.now() - heartbeat <= 5000) return
    status = { ...status, state: 'unresponsive' }
    for (const socket of sockets) socket.destroy()
    process.send?.({ type: 'sessions.counts', nonce: process.env.WEBNAV_WORKER_NONCE, counts: null }, () => {})
  }, 1000)
  monitor.unref()
  const stop = () => closing ??= (async () => {
    stopping = true; clearInterval(monitor)
    for (const socket of sockets) socket.destroy()
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    try { await bounded(peer.call('stop'), 10000, '共享插件 Worker 清理超时。') }
    finally { peer.close(); await worker.terminate(); await closed; status.state = 'stopped' }
  })()
  try { await bounded(ready, 45000, '共享插件 Worker 启动超时。') }
  catch (error) { await stop().catch(() => {}); throw error }
  return {
    stop,
    status: () => structuredClone(status),
    async prepareUpdate(interrupt = false) { return bounded(peer.call<UpdateActivity>('update.prepare', [interrupt]), 5000, '插件线程无响应，不能确认更新收尾。') },
    async resumeUpdate() { return bounded(peer.call<UpdateActivity>('update.resume'), 5000, '插件线程无响应。') },
  }
}
