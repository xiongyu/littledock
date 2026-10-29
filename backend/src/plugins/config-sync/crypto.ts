import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { AppError } from '../../core/errors.ts'

export const MAX_PLAIN = 4 * 1024 * 1024
export const MAX_ENVELOPE = 8 * 1024 * 1024
export interface KeyInfo { salt: string; epoch: string }
interface Header extends KeyInfo { version: 1; profile: 'argon2id-64m-3-4'; space: string; snapshot: string; nonce: string }
export interface Envelope { header: string; body: string; tag: string }
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const freshKeyInfo = (): KeyInfo => ({ salt: randomBytes(16).toString('hex'), epoch: randomBytes(16).toString('hex') })
export function parseEnvelope(text: string, space: string): { envelope: Envelope; header: Header } {
  try {
    if (Buffer.byteLength(text) > MAX_ENVELOPE) throw new Error()
    const e = JSON.parse(text) as Envelope
    if (!e || Object.keys(e).sort().join() !== 'body,header,tag' || typeof e.header !== 'string' || e.header.length > 2048 || typeof e.body !== 'string' || typeof e.tag !== 'string') throw new Error()
    const h = JSON.parse(e.header) as Header
    if (Object.keys(h).sort().join() !== 'epoch,nonce,profile,salt,snapshot,space,version' || h.version !== 1 || h.profile !== 'argon2id-64m-3-4' || h.space !== space || !/^[a-f0-9]{32}$/.test(h.salt) || !/^[a-f0-9]{32}$/.test(h.epoch) || !/^[a-f0-9]{64}$/.test(h.snapshot) || !/^[a-f0-9]{24}$/.test(h.nonce)) throw new Error()
    for (const [s, max] of [[e.body, MAX_PLAIN], [e.tag, 16]] as const) if (Buffer.from(s, 'base64').toString('base64') !== s || Buffer.from(s, 'base64').length > max) throw new Error()
    if (Buffer.from(e.tag, 'base64').length !== 16) throw new Error()
    return { envelope: e, header: h }
  } catch { throw new AppError('SYNC_FORMAT', '同步文件损坏、过大或版本不受支持。') }
}
export async function deriveKey(account: string, password: string, info: KeyInfo, signal?: AbortSignal): Promise<Buffer> {
  account = account.normalize('NFC').trim()
  if (!account || account.length > 256 || password.length < 12 || password.length > 1024 || Buffer.from(account).toString() !== account || Buffer.from(password).toString() !== password) throw new AppError('INVALID_ARGUMENT', '同步账号需要 1–256 个字符，密码需要 12–1,024 个字符。')
  const parts = ['webnav-sync-key-v1', account, password].flatMap(text => { const bytes = Buffer.from(text), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes] })
  const input = Buffer.concat(parts); for (const part of parts) part.fill(0)
  const source = import.meta.url.endsWith('.ts')
  const worker = new Worker(new URL(source ? './kdf-worker.ts' : './kdf-worker.js', import.meta.url), { execArgv: source ? ['--experimental-strip-types'] : [] })
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const abort = () => { void worker.terminate(); reject(new AppError('CANCELLED', '同步已锁定或取消。')) }
      const timer = setTimeout(abort, 30_000)
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('message', (result: unknown) => { done(); if (!(result instanceof Uint8Array) || result.length !== 32) reject(new AppError('SYNC_CRYPTO', '密钥计算失败。')); else resolve(Buffer.from(result)) })
      worker.once('error', () => { done(); reject(new AppError('SYNC_CRYPTO', '密钥计算失败。')) })
      worker.once('exit', code => { done(); if (code !== 0) reject(new AppError('CANCELLED', '密钥计算已停止。')) })
      if (signal?.aborted) abort(); else worker.postMessage({ input, salt: Buffer.from(info.salt, 'hex') })
    })
  } finally { input.fill(0); await worker.terminate() }
}
export function encrypt(root: Buffer, info: KeyInfo, space: string, input: unknown): string {
  const plain = Buffer.from(JSON.stringify(input))
  if (plain.length > MAX_PLAIN) { plain.fill(0); throw new AppError('LIMIT', '同步配置超过 4 MiB。') }
  const h: Header = { version: 1, profile: 'argon2id-64m-3-4', ...info, space, snapshot: randomBytes(32).toString('hex'), nonce: randomBytes(12).toString('hex') }
  const header = JSON.stringify(h), key = Buffer.from(hkdfSync('sha256', root, Buffer.from(h.snapshot, 'hex'), Buffer.from('webnav-sync-content-v1'), 32))
  try { const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(h.nonce, 'hex')); cipher.setAAD(Buffer.from(header)); const body = Buffer.concat([cipher.update(plain), cipher.final()]); return JSON.stringify({ header, body: body.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) }
  finally { plain.fill(0); key.fill(0) }
}
export function decrypt(root: Buffer, space: string, text: string): unknown {
  const { header: h, envelope: e } = parseEnvelope(text, space)
  const key = Buffer.from(hkdfSync('sha256', root, Buffer.from(h.snapshot, 'hex'), Buffer.from('webnav-sync-content-v1'), 32))
  let plain: Buffer | undefined
  try { const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(h.nonce, 'hex')); cipher.setAAD(Buffer.from(e.header)); cipher.setAuthTag(Buffer.from(e.tag, 'base64')); plain = Buffer.concat([cipher.update(Buffer.from(e.body, 'base64')), cipher.final()]); return JSON.parse(plain.toString('utf8')) as unknown }
  catch { throw new AppError('SYNC_DECRYPT', '同步账号、密码不匹配，或文件已损坏。') }
  finally { plain?.fill(0); key.fill(0) }
}
