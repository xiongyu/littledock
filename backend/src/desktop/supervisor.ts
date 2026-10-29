import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { configuration, type RuntimeState } from './config.ts'
import { request, type Status } from './control.ts'
import { powershell, windowsAction, windowsFiles, saveLaunchConfiguration, refreshStartupConfiguration } from './windows.ts'
import { HostUpdater } from './updater.ts'
import { readRelease, releaseDirectory } from './update-files.ts'
import type { UpdateActivity, UpdateRequest } from '@webnav/shared'
import {parseSessionCounts,sessionSummary,type SessionCounts} from './session-status.ts'

export async function supervise(options: { open?: (url:string) => Promise<void> } = {}) {
  const trayMode = process.platform === 'win32' && !process.argv.includes('--console')
  const config = configuration(process.argv[2] === 'start' ? 'start' : 'dev')
  const token = randomBytes(32).toString('hex')
  const descriptor = join(config.runtimeDirectory, 'instance.json')
  const sockets = new Set<Socket>()
  let state: RuntimeState = 'starting', error: string | undefined, autoStart = false
  let worker: ChildProcess | undefined, tray: ChildProcess | undefined
  let sessions:SessionCounts|undefined
  let updater: HostUpdater | undefined, installedVersion: string | undefined, workerNonce = '', graceful = false
  const controls = new Map<string, { resolve: (activity: UpdateActivity) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const workerControl = (type: 'update.prepare' | 'update.resume', interrupt = false): Promise<UpdateActivity> => new Promise((resolve, reject) => {
    if (!worker?.connected) return reject(new Error('业务进程状态未知，暂不能安装。'))
    const id = randomBytes(16).toString('hex'), timer = setTimeout(() => { controls.delete(id); reject(new Error('业务进程未确认任务状态，暂不能安装。')) }, 10_000)
    controls.set(id, { resolve, reject, timer }); worker.send({ type, id, interrupt })
  })
  let transitioning = false, quitting = false, reported = false
  const status = (): Status => ({ state, url: config.url, pid: process.pid, workerPid: worker?.pid, autoStart, presentation: trayMode ? 'tray' : 'console',sessions,sessionSummary:sessionSummary(sessions), ...(error ? { error } : {}) })
  const report = () => { if (!reported) { reported = true; if (process.connected) process.send?.(status()) } }
  function sendTray(message: object) { if (tray?.stdin?.writable) tray.stdin.write(JSON.stringify(message) + '\n') }
  function update(next: RuntimeState, message?: string) {
    state = next; error = message
    sendTray({ type: 'state', ...status() })
    // Bounded lifecycle-only diagnostics. Never persist child stdout, WS data or credentials.
    void writeFile(join(config.runtimeDirectory, 'status.json'), JSON.stringify({ at: new Date().toISOString(), ...status() }), { mode: 0o600 }).catch(() => {})
  }
  async function stopWorker(strict = false) {
    const child = worker
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit').catch(() => {})
    if (child.connected) child.send('shutdown', () => {})
    else child.kill()
    const timer = setTimeout(() => child.kill(), strict ? 15_000 : 6000)
    await exited; clearTimeout(timer); if (worker === child) worker = undefined
    if (strict && (!graceful || child.exitCode !== 0)) throw new Error('业务进程未正常收尾，已停止安装。')
  }
  async function startWorker(version = installedVersion) {
    sessions=undefined
    const workerRoot = config.installRoot && version ? releaseDirectory(config.installRoot, version) : config.root
    if(config.installRoot && version)await readRelease(config.installRoot,version)
    const entry = config.mode === 'dev' ? join(workerRoot, 'scripts/dev-worker.mjs') : join(workerRoot, process.argv.includes('--source-backend') ? 'backend/src/main.ts' : 'backend/dist/main.js')
    const executable = config.installRoot ? join(workerRoot, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node') : process.execPath
    workerNonce=randomBytes(32).toString('hex');graceful=false
    const child = spawn(executable, ['--experimental-strip-types', entry], {
      cwd: workerRoot, windowsHide: true, stdio: ['ignore', trayMode ? 'ignore' : 'inherit', trayMode ? 'ignore' : 'inherit', 'ipc'],
      env: { ...process.env, ...config.environment, WEBNAV_MANAGED: '1',WEBNAV_WORKER_NONCE:workerNonce,WEBNAV_RELEASE_VERSION:version??'' },
    })
    worker = child
    child.on('exit', () => {
      if (worker !== child) return
      worker = undefined
      sessions=undefined
      for(const [id,pending]of controls){clearTimeout(pending.timer);pending.reject(new Error('业务进程已退出。'));controls.delete(id)}
      if (!quitting && !transitioning && !updater?.busy && state === 'running') {
        update('failed', trayMode ? '服务意外退出，请从托盘选择“重启”。' : '服务意外退出，请重新启动工作台。')
        if (!trayMode) { process.exitCode = 1; void quit() }
      }
    })
    await new Promise<void>((resolve, reject) => {
      let done = false
      const finish = (cause?: Error) => {
        if (done) return
        done = true; clearTimeout(timeout)
        cause ? reject(cause) : resolve()
      }
      const timeout = setTimeout(() => finish(new Error('服务启动超时，请检查端口与依赖，然后从托盘重启。')), 30_000)
      child.once('error', () => finish(new Error('无法启动 Node.js 服务。')))
      child.once('exit', code => finish(new Error(config.installRoot ? `此版本的工作台未能启动（${code ?? '进程已结束'}）。` : `服务启动失败（${code ?? '已结束'}），请检查端口占用；正式运行前需要 pnpm build。`)))
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message)) return
        if(message.type==='sessions.counts'&&worker===child&&'nonce' in message&&message.nonce===workerNonce&&'counts' in message){const counts=parseSessionCounts(message.counts);if(counts||message.counts===null){sessions=counts;sendTray({type:'state',...status()})}return}
        if (message.type === 'ready' && (!config.installRoot || ('nonce' in message && message.nonce === workerNonce && 'version' in message && message.version === version))) finish()
        else if (message.type === 'failed') finish(new Error('message' in message && typeof message.message === 'string' ? message.message.slice(0, 500) : '服务启动失败。'))
        else if(message.type==='stopped'&&'nonce' in message&&message.nonce===workerNonce)graceful=true
        else if(message.type==='update.activity'&&'id' in message&&typeof message.id==='string'&&'activity' in message){const pending=controls.get(message.id);if(pending){clearTimeout(pending.timer);controls.delete(message.id);pending.resolve(message.activity as UpdateActivity)}}
        else if(message.type==='update.request'&&'id' in message&&typeof message.id==='string'&&'request' in message&&updater){
          const id=message.id
          void updater.command(message.request as UpdateRequest).then(value=>{if(child.connected)child.send({type:'update.response',id,state:value})},cause=>{if(child.connected)child.send({type:'update.response',id,error:cause instanceof Error ? cause.message.slice(0,300) : '无法执行更新操作，请重新读取状态并核对目标版本。'})})
        }
      })
    })
  }
  async function restart() {
    if (transitioning || quitting || updater?.busy) return
    transitioning = true
    update(worker ? 'restarting' : 'starting')
    try {
      await stopWorker()
      if (quitting) return
      await startWorker()
      if (!quitting) update('running')
    } catch (cause) {
      await stopWorker()
      if (!quitting) update('failed', cause instanceof Error ? cause.message : '服务启动失败。')
    } finally { transitioning = false; report(); if (!trayMode && state === 'failed') { process.exitCode = 1; await quit() } }
  }
  async function quit() {
    if (quitting) return
    quitting = true; update('stopping')
    await updater?.close()
    await stopWorker()
    sendTray({ type: 'exit' })
    if (tray && tray.exitCode === null && tray.signalCode === null) {
      const timer = setTimeout(() => tray?.kill(), 2000)
      await once(tray, 'exit').catch(() => {}); clearTimeout(timer)
    }
    await rm(descriptor, { force: true })
    for (const socket of sockets) socket.destroy()
    server.close(() => process.exit(process.exitCode ?? 0))
  }
  async function openHome() {
    if (state !== 'running') throw new Error('工作台尚未就绪，请稍后重试。')
    if (options.open) return options.open(config.url)
    if (process.platform === 'win32') { await windowsAction(config, 'open'); return }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [config.url], { stdio: 'ignore' })
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('无法打开默认浏览器。')))
    })
  }
  function openFromTray() { void openHome().catch(() => sendTray({ type: 'notice', message: '无法打开默认浏览器，请访问 ' + config.url })) }
  let changingStartup = false
  async function toggleStartup() {
    if (changingStartup || quitting) return
    changingStartup = true
    try {
      if (!autoStart) await saveLaunchConfiguration(config)
      autoStart = await windowsAction(config, autoStart ? 'disable' : 'enable')
      sendTray({ type: 'state', ...status() })
    } catch { sendTray({ type: 'notice', message: '开机启动设置失败，请检查当前用户的启动目录。' }) }
    finally { changingStartup = false; sendTray({ type: 'state', ...status() }) }
  }
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy()); socket.setTimeout(3000, () => socket.destroy())
    socket.setEncoding('utf8')
    let buffer = '', handled = false
    socket.on('data', chunk => {
      if (handled) return
      buffer += chunk
      if (buffer.length > 4096) return socket.destroy()
      if (!buffer.includes('\n')) return
      handled = true
      try {
        const message: unknown = JSON.parse(buffer.split('\n')[0]!)
        if (!message || typeof message !== 'object' || !('token' in message) || message.token !== token || !('command' in message)) return socket.destroy()
        if (!['status', 'restart', 'exit', 'open'].includes(String(message.command))) return socket.destroy()
        if (message.command === 'open') {
          socket.setTimeout(20_000)
          void openHome().then(() => socket.end(JSON.stringify(status()) + '\n')).catch(() => socket.end(JSON.stringify({ ...status(), error: '无法打开默认浏览器，请访问 ' + config.url }) + '\n'))
          return
        }
        socket.end(JSON.stringify(status()) + '\n')
        if (message.command === 'restart') void restart()
        if (message.command === 'exit') void quit()
      } catch { socket.destroy() }
    })
  })

  await mkdir(config.runtimeDirectory, { recursive: true, mode: 0o700 })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.pipe, () => { server.removeListener('error', reject); resolve() })
    })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw cause
    // Another launch may have acquired the pipe but not published its descriptor/ready state yet.
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      let existing: Status | undefined
      try { existing = await request(config, 'status') } catch { /* Only discovery is retried. */ }
      if (existing?.state === 'running' || existing?.state === 'failed') {
        let result = existing
        if (existing.state === 'running') {
          try { result = await request(config, 'open') }
          catch { result = { ...existing, error: '打开网页的结果未知，请访问 ' + existing.url } }
        }
        if (process.connected) process.send?.({ ...result, reused: true }, () => process.exit(0))
        else process.exit(0)
        await new Promise(() => {})
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    process.send?.({ ...status(), state: 'failed', error: '已有小站正在启动或退出，请稍后重试。' }, () => process.exit(1))
    if (!process.connected) process.exit(1)
    await new Promise(() => {})
  }
  server.on('error', () => { void quit() })
  try {
    await mkdir(config.runtimeDirectory, { recursive: true })
    const temporary = descriptor + '.' + process.pid
    await writeFile(temporary, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 })
    await rename(temporary, descriptor)
    if (trayMode) {
      autoStart = await refreshStartupConfiguration(config)
      tray = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(windowsFiles(config), 'host.ps1')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      })
      tray.stdin?.on('error', () => { void quit() })
      tray.on('exit', () => { if (!quitting) { update('failed', '托盘已退出，服务正在关闭。'); report(); void quit() } })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Windows 托盘初始化超时。')), 12_000)
        tray!.once('error', () => { clearTimeout(timeout); reject(new Error('Windows 托盘启动失败。')) })
        tray!.once('exit', () => { clearTimeout(timeout); reject(new Error('Windows 托盘已退出。')) })
        const lines = createInterface({ input: tray!.stdout! })
        lines.on('line', line => {
          if (line === 'ready') { clearTimeout(timeout); sendTray({ type: 'state', ...status() }); resolve() }
          else if (line === 'open') openFromTray()
          else if (line === 'restart') void restart()
          else if (line === 'exit') void quit()
          else if (line === 'startup') void toggleStartup()
        })
      })
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void quit() })
    process.on('message', message => { if (message === 'shutdown') void quit() })
    if (!trayMode && process.send) process.on('disconnect', () => { void quit() })
    if(config.installRoot){
      updater=new HostUpdater(config.installRoot,{
        prepare:interrupt=>workerControl('update.prepare',interrupt),
        resume:async()=>{if(worker?.connected)await workerControl('update.resume')},
        stop:async()=>{update('restarting');try{await stopWorker(true)}catch(error){if(!worker){await startWorker(installedVersion);update('running')}throw error}},
        boot:async version=>{await startWorker(version);installedVersion=version;update('running')},
      })
      installedVersion=await updater.initialize()
    }
    await restart()
    updater?.start()
  } catch (cause) {
    update('failed', cause instanceof Error ? cause.message : '托盘启动失败。'); report()
    await quit()
  }

}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await supervise()
