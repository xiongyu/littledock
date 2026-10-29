import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Client, ClientChannel } from 'ssh2'
import type { TaskManagerPlatform } from '@webnav/shared'
import { AppError, record } from '../../core/errors.ts'
import { RemoteFs } from '../ssh-files/remote-fs.ts'
import { marker, packageName, validMarker, type CollectorPackage } from './packages.ts'

export const shQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export const powershell = (script: string) => 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')
const POSIX_PROBE = "printf 'WEBNAV-TASK-MANAGER\\n';uname -s;uname -m;hostname;printf '%s\\n' \"$HOME\";id -un"
const WINDOWS_PROBE = powershell("$a=$env:PROCESSOR_ARCHITEW6432;if(!$a){$a=$env:PROCESSOR_ARCHITECTURE};@{os='win32';arch=$a;hostname=[Environment]::MachineName;home=[Environment]::GetFolderPath('UserProfile');username=[Environment]::UserName}|ConvertTo-Json -Compress")

export function execChannel(client: Client, command: string, signal: AbortSignal): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    let finished = false
    const abort = () => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new AppError('CANCELLED', '监控已关闭。')) }
    const timer = setTimeout(() => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); reject(new AppError('TIMEOUT', 'SSH 通道启动超时。')) }, 15_000)
    signal.addEventListener('abort', abort, { once: true })
    client.exec(command, (error, channel) => {
      if (finished || signal.aborted) { channel?.close(); return }
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(new AppError('SSH_EXEC_FAILED', '无法启动 SSH 采集通道。')); else resolve(channel)
    })
  })
}

async function probeCommand(client: Client, command: string, signal: AbortSignal): Promise<string> {
  const channel = await execChannel(client, command, signal)
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0), total = 0, done = false
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); channel.close(); if (error) reject(error); else resolve(output.toString('utf8').replace(/^\uFEFF/, '')) }
    const abort = () => finish(new AppError('CANCELLED', '监控已关闭。')), timer = setTimeout(() => finish(new AppError('TIMEOUT', '识别目标系统超时。')), 10_000)
    signal.addEventListener('abort', abort, { once: true })
    const read = (data: Buffer, stdout: boolean) => { total += data.length; if (total > 16 * 1024) finish(new AppError('LIMIT', '系统识别响应超出限制。')); else if (stdout) output = Buffer.concat([output, data]) }
    channel.on('data', (data: Buffer) => read(data, true)); channel.stderr.on('data', (data: Buffer) => read(data, false))
    channel.once('error', () => finish(new AppError('SSH_EXEC_FAILED', '目标系统识别失败。')))
    channel.once('close', (code: number) => finish(code === 0 ? undefined : new AppError('PLATFORM_UNKNOWN', '未识别目标系统。')))
    if (signal.aborted) abort()
  })
}

function clean(value: unknown, max = 4096) { if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) throw new AppError('PLATFORM_UNKNOWN', '目标系统资料无效。'); return value }
export function remoteHome(value: string, windows: boolean): string {
  const home = clean(value).replace(/\\/g, '/').replace(/\/$/, '')
  if (windows ? !/^\/?[a-z]:\/[^/]/i.test(home) : !/^\/[^/]/.test(home)) throw new AppError('INVALID_HOME', '采集器需要有效的当前用户主目录。')
  if (home.split('/').some(part => part === '.' || part === '..')) throw new AppError('INVALID_HOME', '用户主目录包含无效路径。')
  return home
}
export async function detectPlatform(client: Client, signal: AbortSignal): Promise<TaskManagerPlatform> {
  let raw: { os: unknown; arch: unknown; hostname: unknown; home: unknown; username: unknown } | undefined
  try {
    const output = await probeCommand(client, POSIX_PROBE, signal), lines = output.trim().split(/\r?\n/), index = lines.indexOf('WEBNAV-TASK-MANAGER')
    if (index >= 0 && lines.length === index + 6) raw = { os: lines[index + 1] === 'Linux' ? 'linux' : lines[index + 1] === 'Darwin' ? 'darwin' : undefined, arch: lines[index + 2], hostname: lines[index + 3], home: lines[index + 4], username: lines[index + 5] }
  } catch { signal.throwIfAborted() }
  if (!raw?.os) { const data = record(JSON.parse((await probeCommand(client, WINDOWS_PROBE, signal)).trim())); raw = { os: data.os, arch: data.arch, hostname: data.hostname, home: data.home, username: data.username } }
  const arch = ['x86_64', 'amd64', 'x64'].includes(String(raw.arch).toLowerCase()) ? 'x64' : ['aarch64', 'arm64'].includes(String(raw.arch).toLowerCase()) ? 'arm64' : undefined
  if ((raw.os !== 'linux' && raw.os !== 'darwin' && raw.os !== 'win32') || !arch) throw new AppError('PLATFORM_UNSUPPORTED', '采集器目前支持 Windows、Linux、macOS 的 x64 和 arm64 系统。')
  return { os: raw.os, arch, hostname: clean(raw.hostname, 256), username: clean(raw.username, 256), home: remoteHome(clean(raw.home), raw.os === 'win32') }
}

/** lstat every descendant; existing links/junction-like paths are never followed. */
export async function installDirectory(fs: RemoteFs, home: string, pkg: CollectorPackage, create: boolean): Promise<string | undefined> {
  let path = home
  for (const part of ['.webnav', 'tools', 'task-manager', pkg.version, `${pkg.platform}-${pkg.arch}`]) {
    path = posix.join(path, part)
    let stat = await fs.stat(path)
    if (!stat) { if (!create) return undefined; await fs.mkdir(path); stat = await fs.stat(path) }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AppError('UNSAFE_PATH', '采集器安装路径包含链接或非目录，未继续安装。')
    const actual = await fs.realpath(path)
    const normalize = (value: string) => pkg.platform === 'win32' ? value.replace(/^\//, '').toLowerCase() : value
    if (normalize(actual) !== normalize(path)) throw new AppError('UNSAFE_PATH', '采集器安装目录被重定向，未继续安装。')
  }
  return path
}

async function hashRemote(fs: RemoteFs, path: string, size: number, signal: AbortSignal): Promise<string> {
  const stat = await fs.stat(path)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== size) throw new AppError('PACKAGE_INVALID', '目标采集程序大小或文件类型不正确。')
  const handle = await fs.open(path, 'r'), hash = createHash('sha256'); let offset = 0
  try { while (offset <= size) { signal.throwIfAborted(); const data = await fs.read(handle, offset, Math.min(32 * 1024, size - offset + 1)); if (!data.length) break; offset += data.length; hash.update(data) }; if (offset !== size) throw new AppError('PACKAGE_INVALID', '目标采集程序在校验时发生变化。'); return hash.digest('hex') }
  finally { await fs.close(handle).catch(() => {}) }
}
export async function installedRemote(fs: RemoteFs, directory: string, pkg: CollectorPackage, signal: AbortSignal): Promise<boolean> {
  const markerPath = posix.join(directory, 'install.json'), stat = await fs.stat(markerPath)
  if (!stat) return false
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('UNSAFE_PATH', '采集器安装记录不是普通文件。')
  try { if (!validMarker(JSON.parse((await fs.readFile(markerPath, 4096)).toString('utf8')), pkg)) return false; return await hashRemote(fs, posix.join(directory, packageName(pkg.platform)), pkg.size, signal) === pkg.sha256 }
  catch (error) { signal.throwIfAborted(); if (error instanceof AppError && error.code === 'UNSAFE_PATH') throw error; return false }
}

async function replaceRemote(fs: RemoteFs, source: string, target: string) {
  const old = await fs.stat(target)
  if (old && (!old.isFile() || old.isSymbolicLink())) throw new AppError('UNSAFE_PATH', '采集器目标路径不是普通文件。')
  if (!old) { await fs.rename(source, target); return }
  const backup = target + '.previous-' + randomUUID()
  await fs.rename(target, backup)
  try { await fs.rename(source, target) } catch (error) { await fs.rename(backup, target).catch(() => {}); throw error }
  await fs.unlink(backup)
}

export async function uploadCollector(fs: RemoteFs, directory: string, pkg: CollectorPackage, signal: AbortSignal, progress: (value: string) => void) {
  const part = posix.join(directory, '.upload-' + randomUUID()), markerPart = part + '.json', source = await open(pkg.path, 'r'); let handle: Buffer | undefined
  try {
    handle = await fs.open(part, 'wx', 0o700)
    const buffer = Buffer.alloc(32 * 1024); let offset = 0, lastPercent = -1
    while (offset < pkg.size) {
      signal.throwIfAborted(); const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, pkg.size - offset), offset)
      if (!bytesRead) throw new AppError('PACKAGE_INVALID', '本机采集程序读取不完整。')
      await fs.write(handle, buffer.subarray(0, bytesRead), offset); offset += bytesRead
      const percent = Math.floor(offset * 100 / pkg.size); if (percent !== lastPercent) { lastPercent = percent; progress(`上传 ${percent}%`) }
    }
    await fs.close(handle); handle = undefined; progress('校验目标文件…')
    if (await hashRemote(fs, part, pkg.size, signal) !== pkg.sha256) throw new AppError('PACKAGE_INVALID', '目标采集程序 SHA-256 校验失败，未启动。')
    signal.throwIfAborted()
    if (pkg.platform !== 'win32') await fs.chmod(part, 0o700)
    await replaceRemote(fs, part, posix.join(directory, packageName(pkg.platform)))
    handle = await fs.open(markerPart, 'wx', 0o600); await fs.write(handle, Buffer.from(JSON.stringify(marker(pkg))), 0); await fs.close(handle); handle = undefined
    signal.throwIfAborted(); await replaceRemote(fs, markerPart, posix.join(directory, 'install.json'))
  } finally { await source.close(); if (handle) await fs.close(handle).catch(() => {}); await fs.unlink(part).catch(() => {}); await fs.unlink(markerPart).catch(() => {}) }
}

export function launchCommand(platform: TaskManagerPlatform, binary: string): string {
  if (platform.os !== 'win32') return 'exec ' + shQuote(binary)
  const path = binary.replace(/^\/(?=[a-z]:\/)/i, '').replaceAll('/', '\\')
  // Windows PowerShell ConsoleStream can stall after the first SSH pipe read.
  // Use the raw stdin handle, without taking ownership of the process handle;
  // keep JSON bytes out of PowerShell's object/text pipeline.
  const native = 'using System;using System.Runtime.InteropServices;public static class WebNavStdin{[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr GetStdHandle(int n);}'
  return powershell(`Add-Type -TypeDefinition ${psQuote(native)};$h=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new([WebNavStdin]::GetStdHandle(-10),$false);$i=[IO.FileStream]::new($h,[IO.FileAccess]::Read,32768,$false);$p=[Diagnostics.Process]::new();$p.StartInfo.FileName=${psQuote(path)};$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true;$p.StartInfo.RedirectStandardInput=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$started=$false;try{[void]$p.Start();$started=$true;$o=$p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$e=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());$b=New-Object byte[] 32768;while(($n=$i.Read($b,0,$b.Length)) -gt 0){$p.StandardInput.BaseStream.Write($b,0,$n);$p.StandardInput.BaseStream.Flush()};$p.StandardInput.Close();$p.WaitForExit();$o.GetAwaiter().GetResult();$e.GetAwaiter().GetResult();exit $p.ExitCode}finally{$i.Dispose();$h.Dispose();if($started -and !$p.HasExited){$p.Kill()};$p.Dispose()}`)
}
