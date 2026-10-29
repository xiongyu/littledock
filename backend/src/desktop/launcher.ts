import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { configuration, type RunMode } from './config.ts'
import type { Status } from './control.ts'

export async function launch(mode: RunMode, options: { console?: boolean; sourceBackend?: boolean } = {}) {
  const config = configuration(mode)
  const foreground = options.console === true
  const entry = new URL(import.meta.url.endsWith('.ts') ? './supervisor.ts' : './supervisor.js', import.meta.url)
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(entry), mode, ...(foreground ? ['--console'] : []), ...(options.sourceBackend ? ['--source-backend'] : [])], {
    cwd: config.root, detached: !foreground, windowsHide: true, stdio: ['ignore', foreground ? 'inherit' : 'ignore', foreground ? 'inherit' : 'ignore', 'ipc'], env: process.env,
  })
  const exited = new Promise<number>(resolve => { child.once('exit', code => resolve(code ?? 0)); child.once('error', () => resolve(1)) })
  const stop = () => { if (child.connected) child.send('shutdown', () => {}) }
  const message = (value:unknown) => { if (value === 'shutdown') stop() }
  if (foreground) {
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('message', message)
    if (process.send) process.on('disconnect', stop)
  }
  try {
    const status = await new Promise<Status>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('托盘启动超时，请检查运行环境。')), 50_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`托盘启动失败（${code ?? '进程已结束'}）。`)) })
      child.once('message', message => {
        clearTimeout(timeout)
        if (message && typeof message === 'object' && 'state' in message) resolve(message as Status)
        else reject(new Error('托盘启动失败。'))
      })
    })
    if (status.state !== 'running' || status.error) { console.error(status.error ?? 'WebNav 未启动完成，请检查端口与依赖。'); process.exitCode = 1 }
    else if (status.reused) console.log(`已打开正在运行的 WebNav：${status.url}`)
    else if (status.presentation === 'tray') console.log(`WebNav 已在后台运行：${status.url}\n右下角托盘：打开主页 / 开机启动 / 重启 / 退出。现在可以关闭此终端。`)
    else console.log(`WebNav 已在前台运行：${status.url}（Ctrl+C 退出）`)
    if (foreground) {
      process.send?.({ type: status.state === 'running' ? 'ready' : 'failed' })
      const code = await exited
      if (code) process.exitCode = code
    }
  } catch (error) {
    child.kill()
    throw error
  } finally {
    if (foreground) { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('message', message); process.off('disconnect', stop) }
    if (child.connected) child.disconnect()
    child.unref()
  }
}
