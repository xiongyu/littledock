import { Service, type Context } from 'cordis'
import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../core/errors.ts'
declare module 'cordis' { interface Context { auth: AuthService } }
export class AuthService extends Service {
  static inject = ['storage']
  readonly cookieName: string
  constructor(ctx: Context, config: { port: number }) { super(ctx, 'auth', true); this.cookieName = `webnav_session_${config.port}` }
  create() {
    this.ctx.storage.db.prepare('DELETE FROM browser_sessions WHERE expires<?').run(Date.now())
    if ((this.ctx.storage.db.prepare('SELECT count(*) AS n FROM browser_sessions').get() as {n:number}).n >= 64) throw new AppError('BUSY', '浏览器会话过多。')
    const token = randomBytes(32).toString('hex'), id = this.hash(token)
    this.ctx.storage.db.prepare('INSERT INTO browser_sessions VALUES (?,1,?)').run(id, Date.now() + 30 * 86400_000)
    return token
  }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex') }
  session(cookie: string | undefined) {
    const prefix = this.cookieName + '='
    const token = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length)
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined
    const id = this.hash(token)
    const row = this.ctx.storage.db.prepare('SELECT authorized,expires FROM browser_sessions WHERE hash=?').get(id) as { authorized: number; expires: number } | undefined
    if (!row || row.expires <= Date.now()) return undefined
    // Upgrade cookies issued by the old manual-pairing flow automatically.
    if (!row.authorized) {
      row.expires = Date.now() + 30 * 86400_000
      this.ctx.storage.db.prepare('UPDATE browser_sessions SET authorized=1,expires=? WHERE hash=?').run(row.expires, id)
    }
    return { id, authorized: true, expires: row.expires }
  }
  authorized(id: string) { const row = this.ctx.storage.db.prepare('SELECT authorized,expires FROM browser_sessions WHERE hash=?').get(id) as {authorized:number;expires:number}|undefined; return !!row?.authorized && row.expires > Date.now() }
}
