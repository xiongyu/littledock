import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AppError } from '../../core/errors.ts'

const root = fileURLToPath(new URL('../../../native/rdp/', import.meta.url))
let prepared: Promise<string> | undefined
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Bundled and hash-checked; no download, installer, compiler or external daemon at runtime. */
export function prepareRdpRuntime(): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.reject(new AppError('RDP_UNAVAILABLE', '内嵌 RDP 当前提供 Windows x64 组件。'))
  prepared ??= (async () => {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package/manifest.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || !('sha256' in manifest) || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid RDP package manifest')
    const directory = join(root, 'runtime/win32-x64'), executable = join(directory, `webnav-rdp-${manifest.sha256.slice(0, 16)}.exe`)
    const current = await readFile(executable).catch(() => undefined)
    if (current && hash(current) === manifest.sha256) return executable
    const compressed = await readFile(join(root, 'package/webnav-rdp-win32-x64.exe.gz'))
    const binary = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
    if (hash(binary) !== manifest.sha256 || binary.subarray(0, 2).toString() !== 'MZ') throw new Error('RDP component checksum mismatch')
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, binary, { flag: 'wx', mode: 0o700 })
      try { await rename(temporary, executable) }
      catch (error) { if (hash(await readFile(executable)) !== manifest.sha256) throw error }
    } finally { await unlink(temporary).catch(() => {}) }
    return executable
  })().catch(cause => { prepared = undefined; throw new AppError('RDP_UNAVAILABLE', cause instanceof AppError ? cause.message : 'RDP 本机组件不完整，请恢复随项目附带的 RDP 组件包。') })
  return prepared
}
