import { createHash } from 'node:crypto'
import { open, readFile, realpath, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TaskManagerArch, TaskManagerOS } from '@webnav/shared'
import { AppError, record } from '../../core/errors.ts'

export const COLLECTOR_VERSION = '0.3.1'
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
export const defaultPackageDirectory = fileURLToPath(new URL('../../../native/task-manager/package/', import.meta.url))
export interface CollectorPackage { version: string; platform: TaskManagerOS; arch: TaskManagerArch; file: string; path: string; sha256: string; size: number }
export const packageName = (platform: TaskManagerOS) => 'webnav-collector' + (platform === 'win32' ? '.exe' : '')

export async function hashFile(path: string, expectedSize: number): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize || stat.size > MAX_PACKAGE_BYTES) throw new AppError('PACKAGE_INVALID', '采集程序大小或文件类型不正确。')
  const handle = await open(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(32 * 1024)
  try {
    let offset = 0
    while (offset <= expectedSize) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - offset + 1), offset); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead }
    if (offset !== expectedSize) throw new AppError('PACKAGE_INVALID', '采集程序在校验时发生变化。')
    return hash.digest('hex')
  } finally { await handle.close() }
}

/** The host ships this fixed manifest; no target downloads or latest-version lookup. */
export async function collectorPackage(directory: string, platform: TaskManagerOS, arch: TaskManagerArch): Promise<CollectorPackage> {
  let data: Record<string, unknown>
  try {
    const path = join(directory, 'manifest.json'), stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('invalid manifest')
    data = record(JSON.parse(await readFile(path, 'utf8')))
  } catch { throw new AppError('PACKAGE_UNAVAILABLE', '本机缺少固定版本采集程序，请运行 pnpm collector:build 准备安装包，或安装包含采集器的完整小站版本。') }
  if (data.schemaVersion !== 1 || data.version !== COLLECTOR_VERSION || data.protocol !== 1 || !Array.isArray(data.artifacts) || data.artifacts.length > 6) throw new AppError('PACKAGE_INVALID', '采集程序发行清单不兼容。')
  const artifacts = data.artifacts.map(record), matches = artifacts.filter(value => value.platform === platform && value.arch === arch)
  if (matches.length !== 1) throw new AppError('PACKAGE_UNAVAILABLE', '当前小站安装包没有包含此目标系统和架构的采集程序。')
  const item = matches[0]!, file = `${platform}-${arch}/${packageName(platform)}`
  if (item.file !== file || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_PACKAGE_BYTES) throw new AppError('PACKAGE_INVALID', '采集程序发行记录无效。')
  const path = join(directory, file), root = await realpath(directory), actual = await realpath(path), rel = relative(root, actual)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..') || (await lstat(dirname(path))).isSymbolicLink()) throw new AppError('PACKAGE_INVALID', '采集程序路径超出发行目录。')
  if (await hashFile(path, item.size) !== item.sha256) throw new AppError('PACKAGE_INVALID', '采集程序校验失败，未启动或上传。')
  return { version: COLLECTOR_VERSION, platform, arch, file, path, size: item.size, sha256: item.sha256 }
}

export function marker(pkg: CollectorPackage) { return { version: pkg.version, protocol: 1, platform: pkg.platform, arch: pkg.arch, sha256: pkg.sha256, size: pkg.size } }
export function validMarker(value: unknown, pkg: CollectorPackage): boolean {
  try { const data = record(value); return Object.entries(marker(pkg)).every(([key, expected]) => data[key] === expected) } catch { return false }
}
