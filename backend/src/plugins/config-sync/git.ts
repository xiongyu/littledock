import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { chmod, mkdir, mkdtemp, readdir, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { SyncHistory, SyncSettings } from '@webnav/shared'
import { AppError, record, string } from '../../core/errors.ts'
import { digest, MAX_ENVELOPE } from './crypto.ts'

export interface RemoteHead { version: string | null; text: string | null }
export interface SyncRemote {
  read(): Promise<RemoteHead>
  prepare(expected: string | null, text: string): Promise<string>
  publish(expected: string | null, candidate: string): Promise<void>
  contains(candidate: string): Promise<boolean>
  history(cursor?: string): Promise<SyncHistory>
  version(version: string): Promise<string>
  close(): Promise<void>
}
export type RemoteFactory = (settings: SyncSettings, token: string, signal: AbortSignal) => Promise<SyncRemote>
const oid = (text: string) => /^[a-f0-9]{40}$/.test(text)
export function parseSyncSettings(input: unknown): SyncSettings {
  const p = record(input), provider = p.provider
  if (provider !== 'github' && provider !== 'gitee') throw new AppError('INVALID_ARGUMENT', '请选择 GitHub 或 Gitee。')
  let u: URL
  try { u = new URL(string(p.repository, 512)) } catch { throw new AppError('INVALID_ARGUMENT', '请输入仓库 HTTPS 地址。') }
  if (u.protocol !== 'https:' || u.hostname !== (provider === 'github' ? 'github.com' : 'gitee.com') || u.port || u.username || u.password || u.search || u.hash || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(u.pathname)) throw new AppError('INVALID_ARGUMENT', '请填写所选平台的官方 HTTPS 仓库地址，不能包含密码。')
  const branch = string(p.branch ?? 'webnav-sync', 80), spaceId = string(p.spaceId, 32), username = string(p.username ?? '', 100, true)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(branch) || branch.endsWith('/') || branch.includes('//') || !/^[a-f0-9]{32}$/.test(spaceId) || /[\r\n\0]/.test(username)) throw new AppError('INVALID_ARGUMENT', '分支、空间编号或平台用户名不正确。')
  for (const key of ['includeSecrets', 'includePlugins', 'autoSync']) if (typeof p[key] !== 'boolean') throw new AppError('INVALID_ARGUMENT', '同步选项不正确。')
  return { provider, repository: u.origin + u.pathname.replace(/\/$/, '').replace(/\.git$/, '') + '.git', branch, spaceId, username, includeSecrets: p.includeSecrets as boolean, includePlugins: p.includePlugins as boolean, autoSync: p.autoSync as boolean }
}

/** Isolated Git plumbing: no worktree, checkout, hooks, global config or persisted credentials. */
export class GitSyncRemote implements SyncRemote {
  private directory: string
  private path: string
  private destination: string
  private server = createServer()
  private sockets = new Set<Socket>()
  private pipe: string
  private authDirectory?: string
  private helper: string
  private children = new Set<ReturnType<typeof spawn>>()
  private signal: AbortSignal
  private abort: () => void
  private settings: SyncSettings
  private closed = false
  private token: string
  constructor(root: string, settings: SyncSettings, token: string, signal: AbortSignal, localTestRepository?: string) {
    this.settings = settings; this.token = token; this.signal = signal
    this.directory = join(root, digest(settings.repository + '/' + settings.branch)); this.path = `spaces/${settings.spaceId}/snapshot.wnsync`; this.destination = localTestRepository ?? settings.repository
    const nonce = randomBytes(24).toString('hex')
    this.pipe = process.platform === 'win32' ? `//./pipe/webnav-sync-${nonce}`.replaceAll('/', String.fromCharCode(92)) : join(root, `auth-${nonce}.sock`)
    this.helper = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './credential-helper.ts' : './credential-helper.js', import.meta.url))
    this.abort = () => { for (const child of this.children) this.stopChild(child); for (const socket of this.sockets) socket.destroy() }
    signal.addEventListener('abort', this.abort, { once: true })
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') { this.authDirectory = await mkdtemp(join(tmpdir(), 'webnav-sync-')); await chmod(this.authDirectory, 0o700); this.pipe = join(this.authDirectory, 'auth.sock') }
    await writeFile(join(this.directory, 'empty-config'), '', { mode: 0o600 })
    this.server.on('connection', socket => {
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy())
      let input = ''
      socket.on('data', bytes => {
        input += bytes.toString(); if (input.length > 4096) { socket.destroy(); return }
        if (!input.endsWith('\n')) return
        try { const p = JSON.parse(input) as Record<string, string>, url = new URL(this.settings.repository)
          if (p.protocol !== 'https' || p.host !== url.host || p.path?.replace(/\/$/, '') !== url.pathname.slice(1)) { socket.end('{}\n'); return }
          socket.end(JSON.stringify({ username: this.settings.username || (this.settings.provider === 'github' ? 'x-access-token' : 'oauth2'), password: this.token }) + '\n')
        } catch { socket.destroy() }
      })
    })
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.pipe, resolve) })
    await this.run(['init', '--bare', '--template=', '.'])
    return this
  }
  private async size(path = this.directory): Promise<number> {
    let bytes = 0
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new AppError('SYNC_CACHE', '同步缓存包含无效链接。')
      try { bytes += entry.isDirectory() ? await this.size(join(path, entry.name)) : (await stat(join(path, entry.name))).size }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error }
      if (bytes > 128 * 1024 * 1024) throw new AppError('LIMIT', '同步缓存达到 128 MiB，请归档后更换同步空间。')
    }
    return bytes
  }
  private stopChild(child: ReturnType<typeof spawn>) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()) }
    else { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() } }
  }
  private run(args: string[], input?: string | Buffer, limit = MAX_ENVELOPE + 4096): Promise<string> {
    if (this.closed || this.signal.aborted) return Promise.reject(new AppError('CANCELLED', '同步已取消。'))
    const quote = (path: string) => '"' + path.replace(/\\/g, '/').replace(/["$`]/g, '\\$&') + '"'
    const helper = `!${quote(process.execPath)} --experimental-strip-types ${quote(this.helper)}`
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.directory, 'empty-config'), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_SSH_COMMAND: '', WEBNAV_SYNC_PIPE: this.pipe, GIT_AUTHOR_NAME: 'WebNav Sync', GIT_AUTHOR_EMAIL: 'sync@webnav.invalid', GIT_COMMITTER_NAME: 'WebNav Sync', GIT_COMMITTER_EMAIL: 'sync@webnav.invalid' }
    // Inherited Git overrides must not redirect plumbing into another repository.
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|TRACE.*|CURL_VERBOSE|EXEC_PATH|SSL_NO_VERIFY)$/.test(key)) delete env[key as keyof typeof env]
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never', '-c', 'protocol.file.allow=' + (this.destination === this.settings.repository ? 'never' : 'always'), '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: this.directory, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      this.children.add(child); const output: Buffer[] = []; let bytes = 0, stderrBytes = 0, exceeded = false
      const timer = setTimeout(() => this.stopChild(child), 60_000)
      const budget = setInterval(() => { void this.size().catch(() => { exceeded = true; this.stopChild(child) }) }, 500); budget.unref()
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) { exceeded = true; this.stopChild(child) } else output.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) { exceeded = true; this.stopChild(child) } })
      child.stdin.on('error', () => {}); child.stdin.end(input)
      const cleanup = () => { clearTimeout(timer); clearInterval(budget); this.children.delete(child) }
      child.on('error', () => { cleanup(); reject(new AppError('SYNC_GIT', 'Git 不可用，请安装 Git 后重试。')) })
      child.on('close', code => { cleanup(); if (code === 0 && !exceeded && !this.signal.aborted) resolve(Buffer.concat(output).toString('utf8')); else reject(new AppError(exceeded ? 'LIMIT' : this.signal.aborted ? 'CANCELLED' : 'SYNC_REMOTE', exceeded ? '同步仓库超过传输或缓存额度。' : '仓库操作未完成，请检查网络、令牌、仓库权限及分支保护。')) })
    })
  }
  private get ref() { return 'refs/heads/' + this.settings.branch }
  private async head(): Promise<string | null> {
    const line = (await this.run(['ls-remote', '--refs', this.destination, this.ref], undefined, 4096)).trim()
    if (!line) return null
    const value = line.split(/\s+/)[0]!
    if (!oid(value)) throw new AppError('SYNC_REMOTE', '远端分支版本无效。')
    return value
  }
  private async fetch(version: string, depth = 1) { if (!oid(version)) throw new AppError('INVALID_ARGUMENT', '历史版本无效。'); await this.run(['fetch', '--no-tags', '--no-recurse-submodules', `--depth=${depth}`, this.destination, version]); await this.size() }
  private async content(version: string): Promise<string | null> {
    const listing = (await this.run(['ls-tree', version, '--', this.path], undefined, 4096)).trim()
    if (!listing) return null
    const match = /^100644 blob ([a-f0-9]{40})\t/.exec(listing)
    if (!match) throw new AppError('SYNC_FORMAT', '同步路径不是普通文件。')
    const size = Number((await this.run(['cat-file', '-s', match[1]!], undefined, 128)).trim())
    if (size > MAX_ENVELOPE) throw new AppError('LIMIT', '同步文件过大。')
    return this.run(['cat-file', 'blob', match[1]!])
  }
  async read() { const version = await this.head(); if (!version) return { version, text: null }; await this.fetch(version); return { version, text: await this.content(version) } }
  async prepare(expected: string | null, text: string) {
    if (Buffer.byteLength(text) > MAX_ENVELOPE) throw new AppError('LIMIT', '同步文件过大。')
    if (expected) await this.fetch(expected)
    await this.run(['read-tree', ...(expected ? [expected] : ['--empty'])])
    const blob = (await this.run(['hash-object', '-w', '--stdin'], text, 128)).trim()
    await this.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${this.path}`])
    const tree = (await this.run(['write-tree'], undefined, 128)).trim()
    return (await this.run(['commit-tree', tree, ...(expected ? ['-p', expected] : [])], 'WebNav encrypted snapshot\n', 128)).trim()
  }
  async publish(expected: string | null, candidate: string) {
    if (!oid(candidate) || (expected !== null && !oid(expected))) throw new AppError('INVALID_ARGUMENT', '提交版本无效。')
    // Read the raw commit because shallow grafts hide parents from rev-list.
    const commit = await this.run(['cat-file', 'commit', candidate], undefined, 4096)
    const parents = [...commit.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m => m[1])
    if (parents.join() !== (expected ?? '')) throw new AppError('SYNC_CONFLICT', '拒绝改写仓库历史。')
    if (await this.head() !== expected) throw new AppError('SYNC_CONFLICT', '云端已改变，请重新预览。')
    try { await this.run(['push', '--porcelain', `--force-with-lease=${this.ref}:${expected ?? ''}`, this.destination, `${candidate}:${this.ref}`], undefined, 4096) }
    catch { throw new AppError('SYNC_UNKNOWN', '上传结果待确认，请使用“核对待处理操作”，不要重新上传。') }
  }
  async contains(candidate: string) {
    const current = await this.head(); if (!current) return false; if (current === candidate) return true
    await this.fetch(current, 128)
    return (await this.run(['rev-list', '--max-count=128', current], undefined, 8192)).split('\n').includes(candidate)
  }
  async history(cursor?: string): Promise<SyncHistory> {
    const match = cursor ? /^([a-f0-9]{40}):(\d+)$/.exec(cursor) : null
    if (cursor && !match) throw new AppError('INVALID_ARGUMENT', '历史分页无效。')
    const head = match?.[1] ?? await this.head(), offset = Number(match?.[2] ?? 0)
    if (!head) return { versions: [], cursor: null }
    if (offset > 100) throw new AppError('LIMIT', '每次最多浏览 120 个历史提交。')
    await this.fetch(head, offset + 21)
    const lines = (await this.run(['log', '--first-parent', `--skip=${offset}`, '--max-count=21', '--format=%H %ct', head, '--', this.path], undefined, 8192)).trim().split('\n').filter(Boolean)
    return { versions: lines.slice(0, 20).map(line => { const [version, time] = line.split(' '); return { version: version!, time: Number(time) * 1000 } }), cursor: lines.length > 20 ? `${head}:${offset + 20}` : null }
  }
  async version(version: string) { if (!oid(version)) throw new AppError('INVALID_ARGUMENT', '历史版本无效。'); await this.fetch(version); const text = await this.content(version); if (!text) throw new AppError('NOT_FOUND', '此历史版本没有同步文件。'); return text }
  async close() { this.closed = true; this.token = ''; this.signal.removeEventListener('abort', this.abort); this.abort(); if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve())); if (this.authDirectory) { await rmdir(this.authDirectory).catch(() => {}); this.authDirectory = undefined } }
}
