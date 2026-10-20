import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url))
const sharedRequire = createRequire(new URL('../shared/package.json', import.meta.url))
const backendPort = Number(process.env.WEBNAV_PORT ?? 3030)
const uiPort = Number(process.env.WEBNAV_UI_PORT ?? 5173)
for (const port of [backendPort, uiPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WebNav 端口须为 1024–65535 的整数。')
}
if (backendPort === uiPort) throw new Error('前后端开发端口不能相同。')
const backendOrigin = `http://127.0.0.1:${backendPort}`
const uiOrigin = `http://127.0.0.1:${uiPort}`
const directory = process.env.WEBNAV_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'WebNav')

execFileSync(process.execPath, [sharedRequire.resolve('typescript/bin/tsc'), '-p', join(root, 'shared/tsconfig.json')], { stdio: 'inherit', windowsHide: true })
let backend, vite, stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await vite?.close()
  await backend?.stop()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop().then(() => process.exit(0)) })
process.on('message', message => { if (message === 'shutdown') void stop().then(() => process.exit(0)) })
try {
  let existing
  try { existing = await fetch(backendOrigin + '/favicon.ico', { redirect: 'manual', signal: AbortSignal.timeout(1500) }) }
  catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw new Error(`无法确认后端端口 ${backendPort} 的状态。`, { cause: error }) }
  if (existing) {
    const compatible = existing.headers.get('X-WebNav-Dev-Origin') === uiOrigin && existing.headers.get('X-WebNav-Service') === '1'
    await existing.body?.cancel()
    if (!compatible) throw new Error(`端口 ${backendPort} 已被其他服务或旧的 WebNav 占用，请先关闭该服务。`)
    console.log(`复用已运行的 WebNav 后端：${backendOrigin}`)
  } else {
    const { createApp } = await import('../backend/src/app.ts')
    backend = await createApp({ directory, port: backendPort, frontendRoot: join(root, 'frontend/dist'), devOrigin: uiOrigin })
    console.log(`数据目录：${directory}`)
    console.log(`已载入 ${backend.storage.snapshot().snapshot.servers.length} 台服务器。`)
  }
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href)
  vite = await createServer({ root: join(root, 'frontend'), configFile: join(root, 'frontend/vite.config.ts') })
  await vite.listen()
  console.log(`WebNav 前后端已就绪：${uiOrigin}`)
  vite.printUrls()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'WebNav 启动失败。')
  await stop()
  process.exitCode = 1
}
