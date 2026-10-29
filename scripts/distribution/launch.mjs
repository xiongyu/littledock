import { readFile, access, copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const record = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'))
const version = record.pending?.from ?? record.current
if (record.schemaVersion !== 1 || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('安装记录无效，请保留目录并使用完整安装包修复。')
const runtime = join(root, 'releases', version, 'runtime/node.exe')
if (!await access(runtime).then(() => true).catch(() => false)) {
  const initial = JSON.parse(await readFile(join(root, 'runtime/initial.json'), 'utf8'))
  if (initial.version !== version) throw new Error('此版本的运行时缺失，请使用完整安装包修复。')
  const source = join(root, 'runtime/node.exe'), hash = createHash('sha256')
  for await (const chunk of createReadStream(source)) hash.update(chunk)
  if (hash.digest('hex') !== initial.sha256) throw new Error('初始运行时完整性检查失败。')
  await mkdir(dirname(runtime), { recursive: true })
  const temporary = runtime + '.' + randomUUID() + '.tmp'
  try {
    await copyFile(source, temporary)
    try { await rename(temporary, runtime) } catch (error) { if (!await access(runtime).then(() => true).catch(() => false)) throw error }
  } finally { await unlink(temporary).catch(() => {}) }
}
process.env.WEBNAV_INSTALL_ROOT = root
const { launch } = await import(pathToFileURL(join(root, 'releases', version, 'backend/dist/desktop/launcher.js')).href)
await launch('start', { console: process.argv.includes('--console') })
