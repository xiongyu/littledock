import { randomUUID, createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { SFTPWrapper, Stats, FileEntry, OpenMode } from 'ssh2'
import { AppError } from '../../core/errors.ts'
import { validateRemotePath } from '../ssh-inspector.ts'

export const CHUNK = 128 * 1024
// Keep the WS/application chunk size independent of SFTP packet limits.
// Older Windows OpenSSH servers reject large WRITE requests with status 4.
export const SFTP_WRITE_CHUNK = 32 * 1024
export const TEXT_LIMIT = 512 * 1024
export const FILE_LIMIT = 512 * 1024 * 1024
export const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
export const stamp = (stat: Stats | undefined) => stat ? `${stat.size}:${stat.mtime}:${stat.mode}` : null
export function childName(value: unknown) {
  const name = validateRemotePath(value)
  if (name === '.' || name === '..' || /[\\/:]/.test(name) || name.length > 255) throw new AppError('INVALID_ARGUMENT', '名称不能包含路径分隔符。')
  return name
}
export function archiveName(value: string) {
  if (/^[\\/]|^[a-z]:/i.test(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part === '.' || /[\x00-\x1f:]/.test(part))) throw new AppError('INVALID_ARGUMENT', '压缩包中包含不安全的路径。')
  return value.replace(/\/$/, '')
}
function call<T>(run: (cb: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => run((error, value) => error ? reject(error) : resolve(value)))
}
function done(run: (cb: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run(error => error ? reject(error) : resolve()))
}
export class RemoteFs {
  readonly sftp: SFTPWrapper
  constructor(sftp: SFTPWrapper) { this.sftp=sftp }
  realpath(path: string) { return call<string>(cb => this.sftp.realpath(validateRemotePath(path), cb)) }
  async stat(path: string): Promise<Stats | undefined> {
    try { return await call<Stats>(cb => this.sftp.lstat(validateRemotePath(path), cb)) }
    catch (error) { if ((error as { code?: number }).code === 2) return undefined; throw error }
  }
  async fileStat(path: string) {
    const stat = await this.stat(path)
    if (!stat || !stat.isFile()) throw new AppError('INVALID_ARGUMENT', '请选择普通文件，符号链接不能直接改写。')
    return stat
  }
  open(path: string, flags: OpenMode, mode = 0o600) { return call<Buffer>(cb => this.sftp.open(path, flags, mode, cb)) }
  close(handle: Buffer) { return done(cb => this.sftp.close(handle, cb)) }
  async read(handle: Buffer, position: number, length = CHUNK) {
    const buffer = Buffer.alloc(length)
    const bytes = await call<number>(cb => this.sftp.read(handle, buffer, 0, length, position, (error, count) => cb(error, count)))
    return buffer.subarray(0, bytes)
  }
  async write(handle: Buffer, data: Buffer, position: number) {
    for (let offset = 0; offset < data.length; offset += SFTP_WRITE_CHUNK) {
      const length = Math.min(SFTP_WRITE_CHUNK, data.length - offset)
      await done(cb => this.sftp.write(handle, data, offset, length, position + offset, cb))
    }
  }
  unlink(path: string) { return done(cb => this.sftp.unlink(path, cb)) }
  mkdir(path: string) { return done(cb => this.sftp.mkdir(path, {mode:0o755}, cb)) }
  rmdir(path: string) { return done(cb => this.sftp.rmdir(path, cb)) }
  rename(from: string, to: string) { return done(cb => this.sftp.rename(from, to, cb)) }
  chmod(path: string, mode: number) { return done(cb => this.sftp.chmod(path, mode, cb)) }
  async children(path: string) {
    const handle = await call<Buffer>(cb => this.sftp.opendir(path, cb)), entries: FileEntry[] = []
    try {
      for (;;) {
        let batch: FileEntry[] | false
        try { batch = await call<FileEntry[] | false>(cb => this.sftp.readdir(handle, cb)) }
        catch (error) { if ((error as { code?: number }).code === 1) break; throw error }
        if (!batch) break
        entries.push(...batch.filter(file => file.filename !== '.' && file.filename !== '..'))
        if (entries.length > 2000) throw new AppError('LIMIT', '此操作最多处理 2,000 项。')
      }
      return entries
    } finally { await this.close(handle).catch(() => {}) }
  }
  async readFile(path: string, limit: number) {
    const stat = await this.fileStat(path)
    if (stat.size > limit) throw new AppError('LIMIT', `文件超过此操作的 ${Math.round(limit / 1024 / 1024 * 10) / 10} MiB 上限。`)
    const handle = await this.open(path, 'r'), chunks: Buffer[] = []; let offset = 0
    try {
      for (;;) { const bytes = await this.read(handle, offset, Math.min(CHUNK, limit - offset + 1)); if (!bytes.length) break; offset += bytes.length; if (offset > limit) throw new AppError('LIMIT', '文件增长超出限制。'); chunks.push(bytes) }
      return Buffer.concat(chunks)
    } finally { await this.close(handle).catch(() => {}) }
  }
  async destination(path: string) {
    const name = childName(posix.basename(validateRemotePath(path))), parent = await this.realpath(posix.dirname(path))
    return posix.join(parent, name)
  }
  async ensureDirectory(path: string) {
    const stat = await this.stat(path)
    if (stat) { if (!stat.isDirectory()) throw new AppError('CONFLICT', '目标路径不是文件夹。'); return }
    await this.mkdir(path)
  }
  async tree(path: string) {
    const root=await this.stat(path)
    if(root&&!root.isSymbolicLink())path=await this.realpath(path)
    const entries: { path: string; relative: string; stat: Stats }[] = []; let bytes = 0
    const visit = async (target: string, relative: string, depth: number) => {
      if (depth > 32 || entries.length >= 2000) throw new AppError('LIMIT', '目录超过 32 层或 2,000 项限制。')
      const stat = await this.stat(target); if (!stat) throw new AppError('NOT_FOUND', '文件已不存在。')
      bytes += stat.isFile() ? stat.size : 0
      if (bytes > FILE_LIMIT) throw new AppError('LIMIT', '操作总大小超过 512 MiB。')
      entries.push({ path: target, relative, stat })
      if (stat.isDirectory()) for (const entry of await this.children(target)) { childName(entry.filename); await visit(posix.join(target, entry.filename), posix.join(relative, entry.filename), depth + 1) }
    }
    if (path === '/' || /^\/?[a-z]:\/?$/i.test(path)) throw new AppError('INVALID_ARGUMENT', '不能对根目录执行此操作。')
    await visit(path, posix.basename(path), 0); return entries
  }
  async removeTree(path: string) {
    const entries = await this.tree(path)
    for (const item of entries.reverse()) if (item.stat.isDirectory()) await this.rmdir(item.path); else await this.unlink(item.path)
  }
  async commit(temp: string, target: string, expected: string | null, version?: string) {
    const current = await this.stat(target)
    if (stamp(current) !== expected || (version && (!current || hash(await this.readFile(target, 16 * 1024 * 1024)) !== version))) throw new AppError('CONFLICT', '远端文件已变化，未覆盖。请重新打开后合并修改。')
    if (current && !current.isFile()) throw new AppError('CONFLICT', '目标不是普通文件。')
    if (current) await this.chmod(temp, current.mode & 0o777).catch(() => {})
    if (!current) { await this.rename(temp, target); return }
    try { await done(cb => this.sftp.ext_openssh_rename(temp, target, cb)); return }
    catch (error) { if (!/support|unsupported/i.test((error as Error).message) && (error as { code?: number }).code !== 8) throw error }
    // Servers without POSIX rename keep a rollback copy until the staged file is installed.
    const backup = posix.join(posix.dirname(target), '.webnav-backup-' + randomUUID())
    await this.rename(target, backup)
    try { await this.rename(temp, target) } catch (error) { await this.rename(backup, target); throw error }
    await this.unlink(backup)
  }
  async writeFile(path: string, data: Buffer, expected: string | null, version?: string) {
    const target = await this.destination(path), temp = posix.join(posix.dirname(target), '.webnav-upload-' + randomUUID())
    const handle = await this.open(temp, 'wx')
    try { for (let offset = 0; offset < data.length; offset += CHUNK) await this.write(handle, data.subarray(offset, offset + CHUNK), offset) }
    catch (error) { await this.close(handle).catch(() => {}); await this.unlink(temp).catch(() => {}); throw error }
    await this.close(handle)
    try { await this.commit(temp, target, expected, version) } finally { await this.unlink(temp).catch(() => {}) }
  }
}
