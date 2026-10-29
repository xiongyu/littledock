import { Service, type Context } from 'cordis'
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { join } from 'node:path'
import { mkdir, writeFile, unlink, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseRdpDisplay, type RdpDisplay } from '@webnav/shared'
import { AppError } from '../core/errors.ts'
import { writeRdpCredential } from './rdp-credentials.ts'

export function rdpArguments(host: string, port: number) {
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || host.startsWith('-') || !Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('INVALID_ARGUMENT', 'RDP 地址或端口不正确。')
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return [`/v:${address}:${port}`]
}
export function rdpFile(host: string, port: number, username: string, display?: RdpDisplay) {
  const [argument] = rdpArguments(host, port)
  if (username.length > 100 || /[\r\n\0]/.test(username)) throw new AppError('INVALID_ARGUMENT', 'RDP 用户名不正确。')
  const lines = [`full address:s:${argument!.slice(3)}`]
  if (username) lines.push(`username:s:${username}`, 'prompt for credentials:i:0')
  if (display !== undefined) {
    try { display = parseRdpDisplay(display) }
    catch { throw new AppError('INVALID_ARGUMENT', 'RDP 显示设置不正确。') }
    lines.push(`screen mode id:i:${display.mode === 'windowed' ? 1 : 2}`, `use multimon:i:${display.mode === 'multimon' ? 1 : 0}`)
    if (display.mode === 'windowed') lines.push(`desktopwidth:i:${display.width}`, `desktopheight:i:${display.height}`, 'dynamic resolution:i:0')
  }
  return lines.join('\r\n') + '\r\n'
}

export type RdpLauncher = {
  writeCredential: typeof writeRdpCredential
  launch: (args: string[]) => Promise<void>
}
const nativeLauncher: RdpLauncher = {
  writeCredential: writeRdpCredential,
  launch: async args => {
    const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, windowsHide: false, detached: true, stdio: 'ignore' })
      child.once('error', () => reject(new AppError('RDP_LAUNCH_FAILED', '无法启动本机远程桌面客户端。')))
      child.once('spawn', () => { child.unref(); resolve() })
    })
  },
}
export class RdpService extends Service {
  static inject = ['storage', 'connectors', 'credentials']
  constructor(ctx: Context, config: { launcher?: RdpLauncher } = {}) {
    super(ctx, 'rdpLocal', true)
    const launcher = config.launcher ?? nativeLauncher
    const directory = join(ctx.storage.directory, 'rdp')
    const pendingFiles = new Map<string, ReturnType<typeof setTimeout>>()
    let disposed = false
    const cleanup = async (path: string) => {
      clearTimeout(pendingFiles.get(path)); pendingFiles.delete(path)
      await unlink(path).catch(() => {})
    }
    const ready = mkdir(directory, { recursive: true, mode: 0o700 }).then(async () => {
      for (const name of await readdir(directory)) {
        if (!/^[0-9a-f-]{36}\.rdp$/.test(name)) continue
        const path = join(directory, name), info = await stat(path).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > 24 * 3600_000) await unlink(path).catch(() => {})
      }
    })
    void ready.catch(() => {}) // Report initialization failure when opening a connection.
    const unregister = ctx.connectors.register('rdp-native', async (_owner, serverId, connectionId) => {
      if (!config.launcher && process.platform !== 'win32') throw new AppError('UNSUPPORTED', '本机 RDP 启动仅支持 Windows。')
      const { server, connection } = ctx.storage.connection(serverId, connectionId)
      let args = rdpArguments(server.host, connection.port)
      const username = connection.username ?? ''
      const contents = username || connection.rdpDisplay !== undefined ? rdpFile(server.host, connection.port, username, connection.rdpDisplay) : undefined
      const password = ctx.credentials.rdpPassword(serverId, connectionId)
      await ready
      if (disposed) throw new AppError('UNAVAILABLE', '本地服务正在关闭。')
      if (pendingFiles.size >= 100) throw new AppError('BUSY', '远程桌面启动过于频繁，请稍后再试。')
      if (password) await launcher.writeCredential(server.host, username, password)
      if (disposed) throw new AppError('UNAVAILABLE', '本地服务正在关闭。')
      let path: string | undefined
      try {
        if (contents) {
          path = join(directory, randomUUID() + '.rdp')
          await writeFile(path, '\ufeff' + contents, { encoding: 'utf16le', mode: 0o600, flag: 'wx' })
          args = [path]
        }
        if (disposed) throw new AppError('UNAVAILABLE', '本地服务正在关闭。')
        await launcher.launch(args)
      } catch (cause) { if (path) await cleanup(path); throw cause }
      if (path) {
        const file = path
        if (disposed) await cleanup(file)
        else { const timer = setTimeout(() => { void cleanup(file) }, 300_000); timer.unref(); pendingFiles.set(file, timer) }
      }
      return { state: 'client-started' }
    })
    ctx.on('dispose', async () => { disposed = true; unregister(); await Promise.all([...pendingFiles.keys()].map(cleanup)) })
  }
}
