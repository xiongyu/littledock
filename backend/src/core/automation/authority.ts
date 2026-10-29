import Database from 'better-sqlite3'
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { AutomationGrant } from '@webnav/shared'
import { AppError, record, string } from '../errors.ts'

export interface AiClient { id: string; name: string; publicKey: string; grantId: string; revoked: number }
export interface OperationRow { id: string; client: string; tool: string; digest: string; state: string; expires: number; result: string | null }
export class AutomationAuthority {
  readonly db: Database.Database
  readonly publicKey: string
  private privateKey: ReturnType<typeof createPrivateKey>
  private hmacKey: Buffer
  private pairings = new Map<string, { name: string; grantId: string; expires: number }>()
  constructor(directory: string) {
    const path = join(directory, 'automation-identity.pem')
    let pem: string
    try { pem = readFileSync(path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      writeFileSync(path, pem, { flag: 'wx', mode: 0o600 })
    }
    this.privateKey = createPrivateKey(pem); this.publicKey = createPublicKey(this.privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
    this.hmacKey = createHash('sha256').update(pem).digest()
    this.db = new Database(join(directory, 'automation.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,publicKey TEXT NOT NULL UNIQUE,grantId TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,client TEXT NOT NULL,tool TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,client TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);`)
    if (!(this.db.pragma('table_info(tasks)') as {name:string}[]).some(c=>c.name==='metadata')) this.db.exec('ALTER TABLE tasks ADD COLUMN metadata TEXT')
    this.db.prepare("UPDATE operations SET state='unknown' WHERE state='running'").run()
    this.db.prepare("UPDATE tasks SET state='interrupted' WHERE state IN ('running','waiting_user','finishing','cancelling')").run()
    if (!this.db.prepare('SELECT id FROM grants LIMIT 1').get()) this.saveGrant({ id: 'read', name: '目录只读', scopes: ['catalog.read','plugins.read'], targets: null, paths: [] })
  }
  hash(value: unknown) { return createHmac('sha256', this.hmacKey).update(JSON.stringify(value)).digest('hex') }
  sign(value: string) { return sign(null, Buffer.from(value), this.privateKey).toString('base64') }
  verify(publicKey: string, value: string, signature: string) {
    try { const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' }); return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(value), key, Buffer.from(signature, 'base64')) } catch { return false }
  }
  grants(): AutomationGrant[] { return (this.db.prepare('SELECT json FROM grants').all() as { json: string }[]).map(r => JSON.parse(r.json) as AutomationGrant) }
  saveGrant(input: unknown) {
    const p = record(input), id = p.id ? string(p.id, 100) : randomUUID(), name = string(p.name, 80)
    if (!Array.isArray(p.scopes) || p.scopes.length > 100 || !Array.isArray(p.paths) || p.paths.length > 50 || (p.targets !== null && (!Array.isArray(p.targets) || p.targets.length > 200))) throw new AppError('INVALID_ARGUMENT', '授权模板格式无效。')
    const scopes = [...new Set(p.scopes.map(s => string(s, 100)))], paths = p.paths.map(s => {
      const path = string(s, 1024)
      if (!path.startsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path) || path.split('/').includes('..')) throw new AppError('INVALID_ARGUMENT', '文件授权使用远端绝对路径。')
      return posix.normalize(path).replace(/\/$/, '') || '/'
    })
    const targets = p.targets === null ? null : (p.targets as unknown[]).map(t => { if (!Array.isArray(t) || t.length !== 2) throw new AppError('INVALID_ARGUMENT', '目标需要服务器和入口 ID。'); return [string(t[0],100),string(t[1],100)] as [string,string] })
    const grant: AutomationGrant = { id, name, scopes, targets, paths }
    if (!this.db.prepare('SELECT id FROM grants WHERE id=?').get(id) && this.grants().length >= 50) throw new AppError('BUSY','最多 50 个授权模板。')
    this.db.prepare('INSERT OR REPLACE INTO grants VALUES (?,?)').run(id,JSON.stringify(grant)); return grant
  }
  clients(): Omit<AiClient, 'publicKey'>[] { return this.db.prepare('SELECT id,name,grantId,revoked FROM clients').all() as Omit<AiClient,'publicKey'>[] }
  client(id: string): AiClient {
    const c = this.db.prepare('SELECT * FROM clients WHERE id=?').get(id) as AiClient | undefined
    if (!c || c.revoked) throw new AppError('UNAUTHORIZED','AI 接入已失效，请在工作台重新配对。')
    return c
  }
  grant(client: string) { const c = this.client(client), g = this.grants().find(g => g.id === c.grantId); if (!g) throw new AppError('FORBIDDEN','授权模板不存在。'); return g }
  allow(client: string, scopes: string[], target?: [string,string]) {
    const grant = this.grant(client)
    if (scopes.some(s => !grant.scopes.includes(s)) || (target && grant.targets !== null && !grant.targets.some(t => t[0] === target[0] && t[1] === target[1]))) throw new AppError('FORBIDDEN','此 AI 没有此能力或目标的授权，请在工作台调整授权模板。')
    return grant
  }
  begin(name: string, grantId: string) {
    for (const [key,p] of this.pairings) if (p.expires < Date.now()) this.pairings.delete(key)
    if (!this.grants().some(g => g.id === grantId)) throw new AppError('NOT_FOUND','授权模板不存在。')
    if (this.pairings.size >= 8 || this.clients().filter(c => !c.revoked).length >= 32) throw new AppError('BUSY','AI 接入数量已达上限。')
    const code = randomBytes(24).toString('base64url'), expiresAt = Date.now()+300_000
    this.pairings.set(this.hash(code),{name,grantId,expires:expiresAt}); return {code,expiresAt,serverKey:this.publicKey}
  }
  enroll(code: string, publicKey: string) {
    const hash = this.hash(code), pairing = this.pairings.get(hash)
    if (!pairing || pairing.expires < Date.now()) throw new AppError('UNAUTHORIZED','配对码无效、已使用或过期。')
    this.pairings.delete(hash)
    const id = randomUUID()
    this.db.prepare('INSERT INTO clients VALUES (?,?,?,?,0)').run(id,pairing.name,publicKey,pairing.grantId)
    return id
  }
  revoke(id: string) { this.db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(id) }
  operation(id: string, client: string) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND client=?').get(id,client) as OperationRow | undefined
    if (!row) throw new AppError('UNKNOWN','操作记录不存在，不能重新执行未知的副作用。')
    return row
  }
  prepare(client: string, tool: string, params: unknown, binding: unknown) {
    this.clean()
    if ((this.db.prepare('SELECT count(*) n FROM operations').get() as {n:number}).n >= 10000) throw new AppError('BUSY','操作记录已满。')
    const operationId = randomUUID(), expiresAt = Date.now()+300_000, digest = this.hash([params,binding])
    this.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,NULL)').run(operationId,client,tool,digest,'prepared',expiresAt)
    return {operationId,expiresAt,ticket:this.hash([operationId,client,tool,digest,expiresAt])}
  }
  checkTicket(row: OperationRow, ticket: string) { if (ticket !== this.hash([row.id,row.client,row.tool,row.digest,row.expires])) throw new AppError('FORBIDDEN','操作票据无效。') }
  clean() { this.db.prepare("DELETE FROM operations WHERE expires<? AND state!='running'").run(Date.now()-7*86400_000);this.db.prepare("DELETE FROM tasks WHERE created<? AND state NOT IN ('running','waiting_user','finishing','cancelling')").run(Date.now()-7*86400_000) }
  close() { this.pairings.clear();this.hmacKey.fill(0);this.db.close() }
}
