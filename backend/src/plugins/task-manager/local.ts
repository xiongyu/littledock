import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../../core/errors.ts'
import { hashFile, marker, packageName, validMarker, type CollectorPackage } from './packages.ts'

export async function localDirectory(home: string, pkg: CollectorPackage, create: boolean): Promise<string | undefined> {
  let path = await realpath(home)
  for (const part of ['.webnav', 'tools', 'task-manager', pkg.version, `${pkg.platform}-${pkg.arch}`]) {
    path = join(path, part)
    let stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (!stat) { if (!create) return undefined; await mkdir(path, { mode: 0o700 }); stat = await lstat(path) }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new AppError('UNSAFE_PATH', '采集器安装路径包含链接或非目录。')
  }
  return path
}
export async function installedLocal(directory: string, pkg: CollectorPackage): Promise<boolean> {
  try {
    const path = join(directory, 'install.json'), stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('UNSAFE_PATH', '采集器安装记录不是普通文件。')
    if (stat.size > 4096 || !validMarker(JSON.parse(await readFile(path, 'utf8')), pkg)) return false
    return await hashFile(join(directory, packageName(pkg.platform)), pkg.size) === pkg.sha256
  } catch (error) { if (error instanceof AppError && error.code === 'UNSAFE_PATH') throw error; return false }
}
async function replaceFile(source: string, target: string) {
  const stat = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new AppError('UNSAFE_PATH', '采集器目标路径不是普通文件。')
  await rename(source, target)
}
export async function installLocal(directory: string, pkg: CollectorPackage, signal: AbortSignal) {
  const temporary = join(directory, '.upload-' + randomUUID()), temporaryMarker = temporary + '.json'
  try {
    signal.throwIfAborted(); await copyFile(pkg.path, temporary); await chmod(temporary, 0o700)
    if (await hashFile(temporary, pkg.size) !== pkg.sha256) throw new AppError('PACKAGE_INVALID', '采集程序校验失败，未启动。')
    signal.throwIfAborted(); await replaceFile(temporary, join(directory, packageName(pkg.platform)))
    await writeFile(temporaryMarker, JSON.stringify(marker(pkg)), { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted(); await replaceFile(temporaryMarker, join(directory, 'install.json'))
  } finally { await unlink(temporary).catch(() => {}); await unlink(temporaryMarker).catch(() => {}) }
}
