import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, open, rm, statfs, lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import semver from 'semver'
import yauzl from 'yauzl'

export const LAUNCHER_VERSION = 1
export const DATA_VERSION = 1
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
export interface ReleaseInfo { schemaVersion: 1; version: string; platform: string; arch: string; dataVersion: number; minLauncherVersion: number }
export interface UpdateManifest extends ReleaseInfo { url: string; size: number; sha256: string; notes: string; publishedAt: number; expiresAt: number }
export interface UpdateSource { feed: string; publicKey: string; channel: 'stable' | 'preview' }
export interface Installation { schemaVersion: 1; current: string; previous?: string; pending?: { from: string; to: string }; recovered?: boolean }
export function giteeReleaseRepository(feed: string) {
  const url = new URL(feed)
  return url.origin === 'https://gitee.com' && /^\/[\w.-]+\/[\w.-]+\/releases\/?$/.test(url.pathname) ? url.pathname.replace(/\/releases\/?$/, '') : undefined
}
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新文件格式不正确。'); return value as Record<string, unknown> }
export function releaseVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !/^[0-9A-Za-z.-]+$/.test(value) || !semver.valid(value)) throw new Error('更新版本无效。')
  return value
}
export function releaseInfo(value: unknown): ReleaseInfo {
  const p = object(value)
  if (p.schemaVersion !== 1 || !['win32','linux','darwin'].includes(String(p.platform)) || !['x64','arm64'].includes(String(p.arch)) || !Number.isSafeInteger(p.dataVersion) || Number(p.dataVersion) < 1 || !Number.isSafeInteger(p.minLauncherVersion) || Number(p.minLauncherVersion) < 1) throw new Error('发布包元信息无效。')
  return { schemaVersion: 1, version: releaseVersion(p.version), platform: String(p.platform), arch: String(p.arch), dataVersion: Number(p.dataVersion), minLauncherVersion: Number(p.minLauncherVersion) }
}
export function sourceConfig(value: unknown): UpdateSource {
  const p = object(value), feed = updateUrl(p.feed)
  if (typeof p.publicKey !== 'string' || p.publicKey.length > 4096 || createPublicKey(p.publicKey).asymmetricKeyType !== 'ed25519' || !['stable','preview'].includes(String(p.channel))) throw new Error('更新源签名配置无效。')
  return { feed: feed.href, publicKey: p.publicKey, channel: p.channel as UpdateSource['channel'] }
}
export function updateUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('更新地址无效。')
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('更新源须使用 HTTPS，本机测试仅允许 127.0.0.1。')
  return url
}
export function verifiedManifest(bytes: Uint8Array, source: UpdateSource, now = Date.now()): UpdateManifest {
  if (bytes.length > 64 * 1024) throw new Error('更新清单过大。')
  const envelope = object(JSON.parse(Buffer.from(bytes).toString('utf8')))
  if (typeof envelope.payload !== 'string' || envelope.payload.length > 60_000 || typeof envelope.signature !== 'string' || envelope.signature.length > 128) throw new Error('更新签名格式无效。')
  const payload = Buffer.from(envelope.payload, 'base64')
  if (!verify(null, Buffer.concat([Buffer.from('webnav-update-v1\0'), payload]), source.publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('更新签名验证失败。')
  const p = object(JSON.parse(payload.toString('utf8'))), info = releaseInfo(p), url = updateUrl(p.url)
  const repository = giteeReleaseRepository(source.feed)
  if (repository && !url.pathname.startsWith(repository + '/releases/download/')) throw new Error('更新附件不属于配置的 Gitee 仓库。')
  if (url.origin !== new URL(source.feed).origin || !Number.isSafeInteger(p.size) || Number(p.size) < 1 || Number(p.size) > MAX_PACKAGE_BYTES || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || typeof p.notes !== 'string' || p.notes.length > 4000) throw new Error('更新下载信息无效。')
  if (!Number.isSafeInteger(p.publishedAt) || !Number.isSafeInteger(p.expiresAt) || Number(p.publishedAt) > now + 300_000 || Number(p.expiresAt) <= now || Number(p.expiresAt) <= Number(p.publishedAt)) throw new Error('更新清单已过期或时间无效。')
  return { ...info, url: url.href, size: Number(p.size), sha256: p.sha256, notes: p.notes, publishedAt: Number(p.publishedAt), expiresAt: Number(p.expiresAt) }
}
/** Gitee renders fenced code verbatim. Read only our bounded, signed marker; never execute page scripts. */
export function releasePageManifest(bytes: Uint8Array, source: UpdateSource): Buffer {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('发行版页面过大。')
  const matches = Buffer.from(bytes).toString('utf8').matchAll(/WEBNAV_UPDATE_V1:([A-Za-z0-9+/=]{1,90000})/g)
  let selected: { manifest: UpdateManifest; bytes: Buffer } | undefined, count = 0
  for (const match of matches) {
    if (++count > 40) throw new Error('发行版页面更新记录过多。')
    try {
      const value = Buffer.from(match[1]!, 'base64'), manifest = verifiedManifest(value, source)
      if (manifest.platform !== process.platform || manifest.arch !== process.arch || (source.channel === 'stable' && semver.prerelease(manifest.version))) continue
      if (!selected || semver.gt(manifest.version, selected.manifest.version)) selected = { manifest, bytes: value }
    } catch { /* Unsigned, expired or malformed page content is never a candidate. */ }
  }
  if (!selected) throw new Error('发行版页面暂未提供有效签名的工作台更新；保留当前版本。')
  return selected.bytes
}

export function updateRedirect(from: string, location: string, source: UpdateSource): string {
  const url = new URL(location, from), initial = new URL(source.feed)
  // Only the observed public Gitee attachment chain is supported. Do not carry cookies or authorization.
  const allowed = giteeReleaseRepository(source.feed) ? ['gitee.com', 'foruda.gitee.com'].includes(url.hostname) && url.protocol === 'https:' && !url.port : url.origin === initial.origin
  if (!allowed || url.username || url.password || url.hash) throw new Error('更新下载跳转到了未允许的地址。')
  return url.href
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}
export async function readInstallation(root: string): Promise<Installation> {
  const p = object(JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')))
  if (p.schemaVersion !== 1) throw new Error('安装记录无效。')
  const current = releaseVersion(p.current), previous = p.previous === undefined ? undefined : releaseVersion(p.previous)
  let pending: Installation['pending']
  if (p.pending) { const q = object(p.pending); pending = { from: releaseVersion(q.from), to: releaseVersion(q.to) }; if (pending.to !== current || pending.from !== previous) throw new Error('安装恢复记录无效。') }
  return { schemaVersion: 1, current, ...(previous ? { previous } : {}), ...(pending ? { pending } : {}), ...(p.recovered === true ? { recovered: true } : {}) }
}
export const releaseDirectory = (root: string, version: string) => join(root, 'releases', releaseVersion(version))
export async function readRelease(root: string, version: string) {
  const info = releaseInfo(JSON.parse(await readFile(join(releaseDirectory(root, version), 'release.json'), 'utf8')))
  if (info.version !== version) throw new Error('安装版本与发布包不一致。')
  return info
}
export async function fileHash(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
export async function spaceAvailable(path: string, bytes: number) { const s = await statfs(path); if (s.bavail * s.bsize < bytes) throw new Error('磁盘空间不足，未切换当前版本。') }
export async function removeOwned(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('临时目录超出安装范围。')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
}
/** Extract only ordinary files into a NEW directory, with Windows-safe names and bounded expansion. */
export async function extractRelease(archive: string, directory: string, signal?: AbortSignal) {
  await mkdir(directory, { recursive: false })
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, file) => error ? reject(error) : resolve(file!)))
  let total = 0, count = 0, entryWork: Promise<void> | undefined
  const extraction = new AbortController()
  const cancel = () => extraction.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) extraction.abort()
  const extractionSignal = extraction.signal
  const names = new Set<string>()
  try {
    await new Promise<void>((resolveDone, reject) => {
      const fail = (error: unknown) => { extraction.abort(); reject(error) }
      zip.once('error', fail); zip.once('end', resolveDone)
      zip.on('entry', (entry: yauzl.Entry) => { entryWork = (async () => {
        extractionSignal.throwIfAborted()
        const name = entry.fileName, parts = name.replace(/\/$/, '').split('/'), key = name.toLowerCase().replace(/\/$/, '')
        if (!name || name.includes('\\') || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) || names.has(key) || name.length > 500) throw new Error('更新包包含不安全或重复路径。')
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000
        if (entry.isEncrypted() || ![0,0o100000,0o040000].includes(kind)) throw new Error('更新包不允许链接或特殊文件。')
        names.add(key); total += entry.uncompressedSize
        if (++count > 100_000 || total > 2 * MAX_PACKAGE_BYTES) throw new Error('更新包解压超出限额。')
        const target = join(directory, ...parts)
        await spaceAvailable(directory, entry.uncompressedSize + 16 * 1024 * 1024)
        if (name.endsWith('/')) await mkdir(target, { recursive: true })
        else {
          await mkdir(dirname(target), { recursive: true })
          const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)))
          let length = 0
          await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, callback) { length += chunk.length; callback(length > entry.uncompressedSize ? new Error('更新包文件长度无效。') : null, chunk) } }), createWriteStream(target, { flags: 'wx', mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600 }), { signal: extractionSignal })
          if (length !== entry.uncompressedSize) throw new Error('更新包文件不完整。')
        }
        extractionSignal.throwIfAborted(); zip.readEntry()
      })().catch(fail) })
      zip.readEntry()
    })
  } finally { extraction.abort(); await entryWork; signal?.removeEventListener('abort', cancel); zip.close() }
  for (const required of ['release.json','backend/dist/main.js','backend/dist/desktop/supervisor.js','frontend/dist/index.html',process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node']) {
    if (!(await lstat(join(directory, required))).isFile()) throw new Error('发布包缺少必要文件。')
  }
}
