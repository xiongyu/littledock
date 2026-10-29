import { execFile, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { AppError } from '../core/errors.ts'
const commands = new Map<ChildProcess, string>()
const stopped = new Set<string>()
const within = (root: string, path: string) => { const rel = relative(root, resolve(path)); return !rel.startsWith('..') && !isAbsolute(rel) }
export function resumePluginCommands(root: string) { stopped.delete(resolve(root)) }
export async function stopPluginCommands(root: string) {
  stopped.add(resolve(root))
  await Promise.all([...commands].filter(([, cwd]) => within(root, cwd)).map(async ([child]) => {
    if (!child.pid || child.exitCode !== null) return
    if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
    else child.kill('SIGTERM')
  }))
}

export async function runFile(command: string, args: string[], cwd: string, timeout = 120_000, cleanGit = false): Promise<string> {
  if ([...stopped].some(root => within(root, cwd))) throw new AppError('PLUGIN_STOPPED', '插件服务正在关闭。')
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
  if (cleanGit) {
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXEC_PATH'].includes(key)) delete env[key as keyof typeof env]
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '0' })
  }
  return new Promise((resolve, reject) => { const child = execFile(command, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false, env }, (error, stdout) => {
    commands.delete(child)
    if (error) reject(new AppError('PLUGIN_COMMAND_FAILED', `无法完成 ${command === 'git' ? 'Git 仓库操作，请检查地址、版本和网络，或确认已安装 Git' : '插件安装步骤，请检查依赖与插件说明'}。`))
    else resolve(stdout)
  }); commands.set(child, cwd) })
}
export async function fetchRepository(repository: string, ref: string, directory: string): Promise<string> {
  if (ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref) || ref.length > 200) throw new AppError('INVALID_ARGUMENT', 'Git 版本无效。')
  await mkdir(directory, { recursive: true })
  await runFile('git', ['init', '--bare', directory], directory, 30_000, true)
  await runFile('git', ['-c', 'core.hooksPath=', '-c', 'gc.auto=0', '-c', 'protocol.file.allow=never', 'fetch', '--depth=1', '--no-tags', '--', repository, ref || 'HEAD'], directory, 120_000, true)
  const commit = (await runFile('git', ['rev-parse', 'FETCH_HEAD^{commit}'], directory, 30_000, true)).trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new AppError('INVALID_ARGUMENT', '无法解析 Git 提交。')
  await runFile('git', ['update-ref', 'refs/webnav/' + commit, commit], directory, 30_000, true)
  return commit
}
export async function gitText(directory: string, commit: string, path: string, limit = 128 * 1024) {
  const text = await runFile('git', ['show', `${commit}:${path}`], directory, 30_000, true)
  if (Buffer.byteLength(text) > limit) throw new AppError('INVALID_ARGUMENT', '插件描述文件过大。')
  return text
}
export async function gitIcon(directory: string, commit: string, path: string) {
  const mime = path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : ''
  if (!mime) throw new AppError('INVALID_ARGUMENT', '插件图标需要 SVG、PNG 或 WebP。')
  const bytes = await new Promise<Buffer>((resolve, reject) => execFile('git', ['show', `${commit}:${path}`], { cwd: directory, windowsHide: true, timeout: 30_000, encoding: 'buffer', maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(new AppError('INVALID_ARGUMENT', '无法读取插件图标，图标最多 128 KiB。')) : resolve(stdout)))
  return `data:${mime};base64,${bytes.toString('base64')}`
}
/** Resolve symlinks too: only public assets/entries within this release may be served or loaded. */
export async function releaseFile(root: string, path: string) {
  const base = await realpath(root), target = await realpath(resolve(base, path)), rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !(await stat(target)).isFile()) throw new AppError('INVALID_ARGUMENT', '插件文件不在发布目录内。')
  return target
}
export async function hasCommand(command: string) {
  if (command === 'node') return true
  if (command === 'npm') return !!await npmCli()
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) for (const ext of extensions) {
    try { if ((await stat(join(dir, command + ext))).isFile()) return true } catch { /* next PATH entry */ }
  }
  return false
}
async function npmCli() {
  for (const dir of [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]) {
    const path = join(dir, 'node_modules/npm/bin/npm-cli.js')
    try { await stat(path); return path } catch { /* next Node installation */ }
  }
}
export async function installStep(command: string, args: string[], cwd: string) {
  if (command === 'npm') { const cli = await npmCli(); if (!cli) throw new AppError('DEPENDENCY_MISSING', '请安装包含 npm 的 Node.js。'); await runFile(process.execPath, [cli, ...args], cwd, 600_000) }
  else await runFile(command === 'node' ? process.execPath : command, args, cwd, 600_000)
}
