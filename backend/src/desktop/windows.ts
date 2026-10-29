import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeConfig } from './config.ts'

export const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
export const windowsFiles = (config: RuntimeConfig) => config.installRoot ? join(config.installRoot, 'launcher/windows') : join(config.root, 'backend/src/desktop/windows')

// Dynamic paths/settings travel as JSON on stdin, never as interpolated shell code.
export function windowsAction(config: RuntimeConfig, action: 'status' | 'enable' | 'disable' | 'open', startupDirectory?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(windowsFiles(config), 'integration.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096) })
    child.stderr.resume()
    const timer = setTimeout(() => child.kill(), 15_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(action === 'open' ? '无法打开浏览器。' : '无法更新开机启动，请检查启动目录是否可写。'))
      resolve(output.trim() === 'true')
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ action, identity: config.identity, url: config.url, launchFile: join(config.runtimeDirectory, 'launch.json'), bootstrap: join(windowsFiles(config), 'launch.ps1'), startupDirectory }) + '\n')
  })
}
export async function saveLaunchConfiguration(config: RuntimeConfig) {
  await mkdir(config.runtimeDirectory, { recursive: true })
  await writeFile(join(config.runtimeDirectory, 'launch.json'), JSON.stringify({ node: config.installRoot ? join(config.installRoot, 'runtime/node.exe') : process.execPath, root: config.installRoot ?? config.root, entry: config.installRoot ? join(config.installRoot, 'launch.mjs') : join(config.root, 'scripts', config.mode === 'dev' ? 'dev.mjs' : 'start.mjs'), environment: config.environment }), { mode: 0o600 })
}

/** Preserve an existing opt-in while moving it to the stable packaged launcher. */
export async function refreshStartupConfiguration(config: RuntimeConfig, startupDirectory?: string) {
  const enabled = await windowsAction(config, 'status', startupDirectory)
  if (enabled) {
    await saveLaunchConfiguration(config)
    if (config.installRoot) await windowsAction(config, 'enable', startupDirectory)
  }
  return enabled
}
