import { Service, type Context } from 'cordis'
import Database from 'better-sqlite3'
import { mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseCatalogImport, serializeCatalog, type CatalogDocument } from '@webnav/shared'
import { AppError } from '../core/errors.ts'

declare module 'cordis' { interface Context { storage: StorageService } }
export class StorageService extends Service {
  db: Database.Database
  directory: string
  constructor(ctx: Context, config: { directory: string }) {
    super(ctx, 'storage', true)
    this.directory = config.directory
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[\d-]+/)?.[0]
      if (!sid) throw new Error('Cannot resolve current Windows account')
      execFileSync('icacls.exe', [this.directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true })
    } else chmodSync(this.directory, 0o700)
    this.db = new Database(join(this.directory, 'webnav.sqlite'))
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT OR IGNORE INTO catalog VALUES (1,0,'{"schemaVersion":1,"groups":[],"servers":[]}');
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', secret TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hostkeys (endpoint TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_sessions (hash TEXT PRIMARY KEY, authorized INTEGER NOT NULL, expires INTEGER NOT NULL);`)
    ctx.on('dispose', () => { if (this.db.open) { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.close() } })
  }
  snapshot(): { revision: number; snapshot: CatalogDocument } {
    const row = this.db.prepare('SELECT revision,data FROM catalog WHERE id=1').get() as { revision: number; data: string }
    return { revision: row.revision, snapshot: parseCatalogImport(JSON.parse(row.data)) }
  }
  replace(input: unknown, expectedRevision: number) {
    let data: CatalogDocument
    try { data = parseCatalogImport(input) } catch (cause) { throw new AppError('INVALID_ARGUMENT', cause instanceof Error ? cause.message : '目录格式错误。') }
    return this.db.transaction(() => {
      const current = this.snapshot()
      if (current.revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '目录已改变，请同步后重试。')
      this.db.prepare('UPDATE catalog SET revision=?,data=? WHERE id=1').run(current.revision + 1, serializeCatalog(data.groups, data.servers))
      const retained = new Set(data.servers.flatMap(server => server.connections.map(connection => credentialKey(server.id, connection.id))))
      for (const row of this.db.prepare('SELECT id FROM credentials').all() as {id:string}[]) if (!retained.has(row.id)) this.db.prepare('DELETE FROM credentials WHERE id=?').run(row.id)
      return this.snapshot()
    })()
  }
  getSetting(key: string): string | undefined { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value }
  setSetting(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value) }
  connection(serverId: string, connectionId: string) {
    const server = this.snapshot().snapshot.servers.find(server => server.id === serverId)
    const connection = server?.connections.find(connection => connection.id === connectionId)
    if (!server || !connection) throw new AppError('NOT_FOUND', '连接入口不存在。')
    return { server, connection }
  }
}
export function credentialKey(serverId: string, connectionId: string) { return JSON.stringify([serverId, connectionId]) }
