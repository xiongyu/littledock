import { Service, type Context } from 'cordis'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as derive } from 'node:crypto'
import type { SyncSecret } from './config-sync/snapshot.ts'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import ssh2 from 'ssh2'
const { utils } = ssh2
import { AppError, integer, record, string } from '../core/errors.ts'
import { bookmarkCredentialKey, credentialKey } from './storage.ts'
import type { CatalogDocument, WebsiteLogin } from '@webnav/shared'

function scrypt(password:string,salt:Buffer):Promise<Buffer>{return new Promise((resolve,reject)=>derive(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)))}
type VaultSettings = ({ mode: 'local' } | { mode: 'master'; salt: string; verifier: string }) & { unlockMinutes?: number }
export type VaultStatus = { configured: true; mode: 'local' | 'master'; unlocked: boolean; unlockMinutes: number; expiresAt: number | null }
type CredentialRow = { id: string; kind: 'password' | 'key' | 'web-login' | 'sync-token' | 'extension-key'; path: string; secret: string | null; updated: number }
declare module 'cordis' { interface Context { credentials: CredentialService } }

export function seal(key: Buffer, text: string, aad: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(value => value.toString('base64')).join('.')
}
export function unseal(key: Buffer, text: string, aad: string): string {
  const [iv, tag, body] = text.split('.').map(value => Buffer.from(value, 'base64'))
  if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted record')
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
export class CredentialService extends Service {
  static inject = ['storage']
  private key?: Buffer
  private busy = false
  private retryAt = 0
  private expiresAt: number | null = null
  private expiryTimer?: ReturnType<typeof setTimeout>
  private listeners = new Set<(status: VaultStatus) => void>()
  private now: () => number
  constructor(ctx: Context, config: { now?: () => number } = {}) {
    super(ctx, 'credentials', true)
    this.now = config.now ?? Date.now
    ctx.on('dispose', () => { this.clearKey(); this.listeners.clear() })
  }
  private settings(): VaultSettings { const value = this.ctx.storage.getSetting('vault'); return value ? JSON.parse(value) as VaultSettings : { mode: 'local', unlockMinutes: 0 } }
  status(): VaultStatus {
    this.expire()
    const settings = this.settings()
    return { configured: true, mode: settings.mode, unlocked: settings.mode === 'local' || !!this.key, unlockMinutes: settings.unlockMinutes ?? 0, expiresAt: this.expiresAt }
  }
  subscribe(listener: (status: VaultStatus) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() { const status = this.status(); for (const listener of this.listeners) listener(status) }
  private expire() {
    if (this.key && this.expiresAt !== null && this.now() >= this.expiresAt) { this.clearKey(); this.publish() }
  }
  private scheduleExpiry(minutes: number) {
    clearTimeout(this.expiryTimer)
    this.expiresAt = this.key && minutes > 0 ? this.now() + minutes * 60_000 : null
    const schedule = () => {
      this.expire()
      if (this.expiresAt !== null) {
        // Long durations must not overflow Node's 32-bit timer delay.
        this.expiryTimer = setTimeout(schedule, Math.min(2_147_483_647, Math.max(1, this.expiresAt - this.now())))
        this.expiryTimer.unref()
      }
    }
    schedule()
  }
  private clearKey() { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; this.expiresAt = null; this.key?.fill(0); this.key = undefined }
  lock() { if (this.busy) throw new AppError('BUSY', '正在处理凭据设置。'); this.clearKey(); this.publish() }
  async configure(mode: 'local' | 'master', password: string) {
    if (this.ctx.storage.getSetting('vault')) throw new AppError('CONFLICT', '已设置保存方式。请在全局设置中修改。')
    return this.changeMode(mode, password)
  }
  async update(input: unknown) {
    this.requireUnlocked()
    const params = record(input), mode = params.mode
    if (mode !== 'local' && mode !== 'master') throw new AppError('INVALID_ARGUMENT', '保存方式不正确。')
    const minutes = integer(params.unlockMinutes, 0, 525600)
    const password = params.password === undefined ? undefined : string(params.password, 1024)
    if (mode !== this.settings().mode || password !== undefined) return this.changeMode(mode, password ?? '', minutes)
    if (this.busy) throw new AppError('BUSY', '正在处理凭据设置。')
    this.ctx.storage.setSetting('vault', JSON.stringify({ ...this.settings(), unlockMinutes: minutes }))
    this.scheduleExpiry(minutes); this.publish()
    return this.status()
  }
  async changeMode(mode: 'local' | 'master', password: string, unlockMinutes = this.settings().unlockMinutes ?? 0) {
    this.requireUnlocked()
    integer(unlockMinutes, 0, 525600)
    if (this.busy) throw new AppError('BUSY', '正在处理凭据设置。')
    this.busy = true
    let nextKey: Buffer | undefined
    try {
      if (mode !== 'local' && mode !== 'master') throw new AppError('INVALID_ARGUMENT', '保存方式不正确。')
      let settings: VaultSettings = { mode: 'local', unlockMinutes }
      if (mode === 'master') {
        if (password.length < 8 || password.length > 1024) throw new AppError('INVALID_ARGUMENT', '主密码需要 8 到 1,024 个字符。')
        const salt = randomBytes(32)
        nextKey = await scrypt(password, salt)
        settings = { mode, unlockMinutes, salt: salt.toString('base64'), verifier: seal(nextKey, 'WebNav vault v1', 'vault-verifier') }
      }
      // Derivation is asynchronous: expiry during it must not allow a partial migration.
      this.requireUnlocked()
      const rows = this.ctx.storage.db.prepare('SELECT * FROM credentials WHERE secret IS NOT NULL').all() as CredentialRow[]
      const migrated = rows.filter(row => !(mode === 'local' && row.kind === 'sync-token')).map(row => ({ id: row.id, secret: this.decode(row) }))
      this.ctx.storage.db.transaction(() => {
        if (mode === 'local') this.ctx.storage.db.prepare("DELETE FROM credentials WHERE kind='sync-token'").run()
        for (const row of migrated) this.ctx.storage.db.prepare('UPDATE credentials SET secret=? WHERE id=?').run(nextKey ? seal(nextKey, row.secret, row.id) : Buffer.from(row.secret).toString('base64'), row.id)
        this.ctx.storage.setSetting('vault', JSON.stringify(settings))
      })()
      this.clearKey(); this.key = nextKey; nextKey = undefined
      this.scheduleExpiry(unlockMinutes); this.publish()
      return this.status()
    } finally { nextKey?.fill(0); this.busy = false }
  }
  async unlock(password: string) {
    const settings = this.settings()
    if (settings.mode === 'local') return this.status()
    if (this.busy || this.now() < this.retryAt) throw new AppError('BUSY', '请稍后再试。')
    this.busy = true
    let key: Buffer | undefined
    try {
      key = await scrypt(password, Buffer.from(settings.salt, 'base64'))
      if (unseal(key, settings.verifier, 'vault-verifier') !== 'WebNav vault v1') throw new Error('Invalid master password')
      this.clearKey(); this.key = key; key = undefined
      this.retryAt = 0; this.scheduleExpiry(settings.unlockMinutes ?? 0); this.publish()
      return this.status()
    } catch { this.retryAt = this.now() + 2000; throw new AppError('WRONG_PASSWORD', '主密码不正确，或凭据库无法解锁。') }
    finally { key?.fill(0); this.busy = false }
  }
  requireUnlocked() { if (!this.status().unlocked) throw new AppError('VAULT_LOCKED', '请输入主密码解锁小站。') }
  /** A reveal verifies again; it never reuses or extends the global unlock period. */
  async verifyReveal(password: string) {
    this.requireUnlocked()
    const settings = this.settings()
    if (settings.mode === 'local') return
    if (!password) throw new AppError('MASTER_PASSWORD_REQUIRED', '查看账号密码需要再次输入主密码。')
    if (this.busy || this.now() < this.retryAt) throw new AppError('BUSY', '请稍后再试。')
    this.busy = true
    let key: Buffer | undefined
    try {
      key = await scrypt(password, Buffer.from(settings.salt, 'base64'))
      try {
        if (unseal(key, settings.verifier, 'vault-verifier') !== 'WebNav vault v1') throw new Error()
      } catch { this.retryAt = this.now() + 2000; throw new AppError('WRONG_PASSWORD', '主密码不正确。') }
      this.retryAt = 0
      this.requireUnlocked()
    } finally { key?.fill(0); this.busy = false }
  }
  /** Called only inside the bookmark transaction. Undefined fields retain their saved values. */
  saveBookmarkLogin(bookmarkId: string, input: unknown) {
    if (input === undefined) return
    this.requireUnlocked()
    const id = bookmarkCredentialKey(bookmarkId)
    if (input === null) { this.ctx.storage.db.prepare('DELETE FROM credentials WHERE id=?').run(id); return }
    const params = record(input)
    if (Object.keys(params).some(key => !['username', 'password'].includes(key))) throw new AppError('INVALID_ARGUMENT', '网站账密字段不正确。')
    const old = this.bookmarkLogin(bookmarkId)
    const login = {
      username: params.username === undefined ? old.username : string(params.username, 256, true),
      password: params.password === undefined ? old.password : string(params.password, 4096, true),
    }
    if (login.username.includes('\0') || login.password.includes('\0')) throw new AppError('INVALID_ARGUMENT', '账号密码不能包含 NUL。')
    if (!login.username && !login.password) { this.ctx.storage.db.prepare('DELETE FROM credentials WHERE id=?').run(id); return }
    const text = JSON.stringify(login)
    const stored = this.settings().mode === 'local' ? Buffer.from(text).toString('base64') : seal(this.key!, text, id)
    this.ctx.storage.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?,?)').run(id, 'web-login', '', stored, Date.now())
  }
  bookmarkLogin(bookmarkId: string): WebsiteLogin {
    this.requireUnlocked()
    const row = this.ctx.storage.db.prepare("SELECT * FROM credentials WHERE id=? AND kind='web-login'").get(bookmarkCredentialKey(bookmarkId)) as CredentialRow | undefined
    return row ? JSON.parse(this.decode(row)) as WebsiteLogin : { username: '', password: '' }
  }
  /** Local extension identity keys migrate with the vault, but never enter portable sync/export. */
  saveExtensionKey(pairId: string, key: string) {
    this.requireUnlocked()
    const id = `extension:${pairId}`, secret = this.settings().mode === 'local' ? Buffer.from(key).toString('base64') : seal(this.key!, key, id)
    this.ctx.storage.db.prepare('INSERT INTO credentials VALUES (?,?,?,?,?)').run(id, 'extension-key', '', secret, Date.now())
  }
  extensionKey(pairId: string): string | undefined {
    this.requireUnlocked()
    const row = this.ctx.storage.db.prepare("SELECT * FROM credentials WHERE id=? AND kind='extension-key'").get(`extension:${pairId}`) as CredentialRow | undefined
    return row ? this.decode(row) : undefined
  }
  /** Internal sync boundary. Paths, trust, tokens and the local vault format never leave this service. */
  exportSyncSecrets(): SyncSecret[] {
    this.requireUnlocked()
    const rows = this.ctx.storage.db.prepare("SELECT * FROM credentials WHERE kind IN ('password','key','web-login') ORDER BY id").all() as CredentialRow[]
    return rows.map(row => ({ id: row.id, kind: row.kind as SyncSecret['kind'], secret: this.decode(row) }))
  }
  syncRevision(): string { return createHash('sha256').update(JSON.stringify(this.ctx.storage.db.prepare("SELECT * FROM credentials WHERE kind IN ('password','key','web-login') ORDER BY id").all())).digest('hex') }
  hasSyncToken() { return !!this.ctx.storage.db.prepare("SELECT 1 FROM credentials WHERE id='config-sync-token' AND kind='sync-token'").get() }
  syncToken(): string { const row = this.ctx.storage.db.prepare("SELECT * FROM credentials WHERE id='config-sync-token' AND kind='sync-token'").get() as CredentialRow | undefined; return row ? this.decode(row) : '' }
  saveSyncToken(token: string | null) {
    this.requireUnlocked()
    if (token === null) { this.ctx.storage.db.prepare("DELETE FROM credentials WHERE id='config-sync-token'").run(); return }
    if (this.settings().mode !== 'master') throw new AppError('MASTER_PASSWORD_REQUIRED', '保存仓库令牌需要先设置本地主密码。')
    const id = 'config-sync-token'
    this.ctx.storage.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?,?)').run(id, 'sync-token', '', seal(this.key!, token, id), Date.now())
  }
  prepareSyncSecrets(secrets: SyncSecret[] | null, include: boolean, catalog: CatalogDocument, bookmarks: { id: string }[]): () => void {
    this.requireUnlocked()
    if (!include || secrets === null) return () => {}
    const valid = new Set(catalog.servers.flatMap(s => s.connections.map(c => credentialKey(s.id, c.id))).concat(bookmarks.map(b => bookmarkCredentialKey(b.id))))
    const prepared = secrets.map(s => {
      if (!valid.has(s.id)) throw new AppError('INVALID_ARGUMENT', '凭据引用无效。')
      const old = this.ctx.storage.db.prepare('SELECT * FROM credentials WHERE id=?').get(s.id) as CredentialRow | undefined
      return { ...s, path: s.kind === 'key' && old?.kind === 'key' ? old.path : '', encoded: this.settings().mode === 'local' ? Buffer.from(s.secret).toString('base64') : seal(this.key!, s.secret, s.id) }
    })
    return () => {
      this.requireUnlocked()
      this.ctx.storage.db.prepare("DELETE FROM credentials WHERE kind IN ('password','key','web-login')").run()
      for (const s of prepared) this.ctx.storage.db.prepare('INSERT INTO credentials VALUES (?,?,?,?,?)').run(s.id, s.kind, s.path, s.encoded, Date.now())
    }
  }
  private row(serverId: string, connectionId: string) { return this.ctx.storage.db.prepare('SELECT * FROM credentials WHERE id=?').get(credentialKey(serverId, connectionId)) as CredentialRow | undefined }
  describe(serverId: string, connectionId: string) {
    const { connection } = this.ctx.storage.connection(serverId, connectionId)
    const row = this.row(serverId, connectionId)
    return row ? { configured: true, kind: row.kind, path: row.path, hasSecret: !!row.secret } : { configured: false, kind: ['rdp', 'vnc', 'wdb'].includes(connection.type) ? 'password' : 'key', path: '', hasSecret: false }
  }
  /** Prepare only; the caller commits these writes inside the catalog transaction. */
  prepareRdpPasswords(input: unknown, catalog: CatalogDocument): () => void { return this.prepareDesktopPasswords(input, catalog, true) }
  prepareDesktopPasswords(input: unknown, catalog: CatalogDocument, rdpOnly = false): () => void {
    if (input === undefined) return () => {}
    if (!Array.isArray(input) || input.length > 12) throw new AppError('INVALID_ARGUMENT', '桌面密码更新数量不正确。')
    if (input.length) this.requireUnlocked()
    const seen = new Set<string>()
    const updates = input.map(value => {
      const item = record(value), serverId = string(item.serverId), connectionId = string(item.connectionId)
      const connection = catalog.servers.find(server => server.id === serverId)?.connections.find(connection => connection.id === connectionId)
      if (!connection || !(rdpOnly ? ['rdp'] : ['rdp', 'vnc', 'wdb']).includes(connection.type)) throw new AppError('INVALID_ARGUMENT', '密码必须对应本次保存的远程桌面入口。')
      const id = credentialKey(serverId, connectionId)
      if (seen.has(id)) throw new AppError('INVALID_ARGUMENT', '不能重复更新同一个入口的密码。')
      seen.add(id)
      if (item.secret === null) return { id, secret: null }
      const secret = string(item.secret, 1280)
      if (secret.includes('\0') || (['rdp','wdb'].includes(connection.type) && (!connection.username?.trim() || /[\r\n\0]/.test(connection.username)))) throw new AppError('INVALID_ARGUMENT', '请填写有效的远程桌面账号密码。')
      return { id, secret: this.settings()?.mode === 'local' ? Buffer.from(secret).toString('base64') : seal(this.key!, secret, id) }
    })
    return () => {
      for (const update of updates) {
        if (update.secret === null) this.ctx.storage.db.prepare('DELETE FROM credentials WHERE id=?').run(update.id)
        else this.ctx.storage.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?,?)').run(update.id, 'password', '', update.secret, Date.now())
      }
    }
  }
  rdpPassword(serverId: string, connectionId: string): string | undefined {
    return this.desktopPassword(serverId, connectionId)
  }
  desktopPassword(serverId: string, connectionId: string): string | undefined {
    this.requireUnlocked()
    const row = this.row(serverId, connectionId)
    if (!row) return undefined
    if (row.kind !== 'password') throw new AppError('INVALID_ARGUMENT', '请重新设置此桌面入口的登录密码。')
    return this.decode(row)
  }
  private decode(row: CredentialRow) { this.requireUnlocked(); if (!row.secret) return ''; return this.settings()?.mode === 'local' ? Buffer.from(row.secret, 'base64').toString('utf8') : unseal(this.key!, row.secret, row.id) }
  async save(input: unknown) {
    this.requireUnlocked()
    const params = record(input), serverId = string(params.serverId), connectionId = string(params.connectionId)
    const { connection } = this.ctx.storage.connection(serverId, connectionId)
    if (connection.type !== 'ssh') throw new AppError('INVALID_ARGUMENT', '该入口不支持 SSH 认证。')
    const kind = params.kind
    if (kind !== 'password' && kind !== 'key') throw new AppError('INVALID_ARGUMENT', '认证类型不正确。')
    const path = kind === 'key' ? string(params.path, 2048) : ''
    const old = this.row(serverId, connectionId)
    const secret = params.secret === undefined ? (old?.kind === kind && old.path === path ? this.decode(old) : '') : string(params.secret, 4096, true)
    if (kind === 'password' && !secret) throw new AppError('INVALID_ARGUMENT', '请输入登录密码。')
    if (kind === 'key') (await readPrivateKey(path, secret)).fill(0)
    this.requireUnlocked()
    const id = credentialKey(serverId, connectionId)
    const stored = this.settings()?.mode === 'local' ? Buffer.from(secret).toString('base64') : seal(this.key!, secret, id)
    this.ctx.storage.db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,?,?)').run(id, kind, path, secret ? stored : null, Date.now())
    return this.describe(serverId, connectionId)
  }
  importKeyReference(serverId: string, connectionId: string, path: string) {
    if (!isAbsolute(path)) throw new AppError('INVALID_ARGUMENT', '私钥路径必须是绝对路径。')
    this.ctx.storage.db.prepare('INSERT OR IGNORE INTO credentials VALUES (?,?,?,NULL,?)').run(credentialKey(serverId, connectionId), 'key', path, Date.now())
  }
  async resolve(serverId: string, connectionId: string):Promise<{password?:string;privateKey?:Buffer;passphrase?:string}> {
    this.requireUnlocked()
    const row = this.row(serverId, connectionId)
    if (!row) throw new AppError('CREDENTIAL_REQUIRED', '请先保存这个连接的认证信息。')
    const secret = this.decode(row)
    return row.kind === 'password' ? { password: secret } : { privateKey: await readPrivateKey(row.path, secret), ...(secret ? { passphrase: secret } : {}) }
  }
}
export async function readPrivateKey(path: string, passphrase = ''): Promise<Buffer> {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new AppError('INVALID_ARGUMENT', '请输入本机私钥文件的绝对路径。')
  let bytes: Buffer
  try { const info = await stat(path); if (!info.isFile() || info.size > 1024 * 1024) throw new Error(); bytes = await readFile(path) } catch { throw new AppError('KEY_UNREADABLE', '私钥文件不存在、无法读取或过大。') }
  const key = utils.parseKey(bytes, passphrase || undefined)
  if (key instanceof Error) { bytes.fill(0); throw new AppError('KEY_INVALID', '无法解析私钥，请检查文件和私钥口令。') }
  return bytes
}
