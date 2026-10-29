import { i18n } from './localization.ts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { release } from 'node:os'
import type { WindowsAdapter, RegistryTarget, RegistryValue, SystemSnapshot } from './model.ts'
import { parseSnapshot, registryValue } from './model.ts'

const script = fileURLToPath(new URL('../windows/bridge.ps1', import.meta.url))
const rules = fileURLToPath(new URL('../windows/rules.json', import.meta.url))
const scriptHash = '__BRIDGE_SHA256__'
export class NativeWindowsAdapter implements WindowsAdapter {
  private children = new Set<ChildProcessWithoutNullStreams>()
  private closed = false
  private async call<T>(request: Record<string, unknown>, timeout = 30000): Promise<T> {
    if (this.closed || process.platform !== 'win32' || process.arch !== 'x64' || Number(release().split('.')[2]) < 22000) throw i18n.error('PLUGIN_FAILED', 'm0c2fb1d38793')
    if (createHash('sha256').update(await readFile(script)).update('\0').update(await readFile(rules)).digest('hex') !== scriptHash) throw i18n.error('PLUGIN_FAILED', 'm227194214286')
    if (this.children.size >= 2) throw i18n.error('PLUGIN_FAILED', 'm972c4f2ea57c')
    const payload = JSON.stringify(request); if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw i18n.error('PLUGIN_FAILED', 'mb689d9ba11dc')
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return new Promise<T>((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.children.add(child); let output = Buffer.alloc(0), exited = false; let failed: Error | undefined
      const timer = setTimeout(() => { failed = i18n.error('PLUGIN_FAILED', 'm065abab4e59f'); child.kill() }, timeout)
      child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 4 * 1024 * 1024) { failed = i18n.error('PLUGIN_FAILED', 'me03be814a137'); child.kill() } else output = Buffer.concat([output, chunk]) })
      child.stderr.resume() // Never surface registry commands or values through logs.
      child.on('error', () => { failed = i18n.error('PLUGIN_FAILED', 'mdce99a7f4f2e') })
      child.on('close', code => {
        exited = true; clearTimeout(timer); this.children.delete(child)
        if (failed) return reject(failed)
        if (code !== 0) return reject(i18n.error('PLUGIN_FAILED', 'm5cd73c6ab899'))
        try { const result: unknown = JSON.parse(output.toString('utf8').replace(/^\uFEFF/, '')); if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('data' in result)) throw new Error(); resolve(result.data as T) }
        catch { reject(i18n.error('PLUGIN_FAILED', 'md5af417fff45')) }
      })
      child.stdin.on('error', () => { if (!exited) { failed = i18n.error('PLUGIN_FAILED', 'm3d0799b13c4c'); child.kill() } })
      child.stdin.end(payload)
    })
  }
  async snapshot() {
    return parseSnapshot(await this.call<unknown>({ op: 'snapshot' }))
  }
  async read(target: RegistryTarget) { return registryValue(await this.call<unknown>({ op: 'read', target })) }
  async apply(target: RegistryTarget, expected: RegistryValue, desired: RegistryValue) {
    const result = await this.call<unknown>({ op: 'apply', target, expected, desired })
    if (!result || typeof result !== 'object' || !('status' in result) || !['applied', 'conflict'].includes(String(result.status)) || !('current' in result)) throw i18n.error('PLUGIN_FAILED', 'm4231a32bc21a')
    return { status: result.status as 'applied' | 'conflict', current: registryValue(result.current) }
  }
  private async protectedText(op: 'protect' | 'unprotect', value: string) {
    const result = await this.call<unknown>({ op, value })
    if (typeof result !== 'string' || result.length > 2 * 1024 * 1024) throw i18n.error('PLUGIN_FAILED', 'm0e84173fe5b8')
    return result
  }
  protect(value: string) { return this.protectedText('protect', value) }
  unprotect(value: string) { return this.protectedText('unprotect', value) }
  async openSettings(page: 'startup' | 'apps' | 'storage') { await this.call({ op: 'open-settings', page }) }
  async close() { this.closed = true; for (const child of this.children) child.kill(); await Promise.allSettled([...this.children].map(child => new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('close', () => resolve()) }))) }
}
