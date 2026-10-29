import { Service, type Context } from 'cordis'
import { validateBookmark, type BookmarkSnapshot, type WebBookmark } from '@webnav/shared'
import { AppError, integer, record } from '../core/errors.ts'
import { bookmarkCredentialKey } from './storage.ts'
import { captureWebsite, type WebCapture } from './web-capture.ts'

type Row = { id: string; name: string; url: string; version: number; captured_at: number | null; preview_state: WebBookmark['previewState']; has_login: number }
type CaptureJob = { id: string; url: string; version: number }
declare module 'cordis' { interface Context { webBookmarks: WebBookmarkService } }

export class WebBookmarkService extends Service {
  static inject = ['storage', 'credentials']
  private listeners = new Set<() => void>()
  private queue = new Map<string, CaptureJob>()
  private running?: Promise<void>
  get activity() { return this.queue.size + (this.running ? 1 : 0) }
  private active?: CaptureJob
  private controller?: AbortController
  private disposed = false
  private capture: WebCapture
  constructor(ctx: Context, config: { capture?: WebCapture } = {}) {
    super(ctx, 'webBookmarks', true)
    this.capture = config.capture ?? captureWebsite
    if (ctx.storage.db.prepare("UPDATE web_bookmarks SET preview_state='failed' WHERE preview_state IN ('pending','capturing')").run().changes) this.advance()
    ctx.on('dispose', async () => {
      this.disposed = true; this.queue.clear(); this.listeners.clear(); this.controller?.abort()
      await this.running
    })
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private advance() {
    this.ctx.storage.setSetting('bookmarksRevision', String(Number(this.ctx.storage.getSetting('bookmarksRevision') ?? 0) + 1))
  }
  private publish() { for (const listener of this.listeners) listener() }
  /** Caller owns the outer transaction; capture is explicit after a sync restore. */
  replaceForSync(input: { id: string; name: string; url: string }[]) {
    const next = input.map(validateBookmark), retained = new Set(next.map(b => b.id))
    this.ctx.storage.setSetting('bookmarks-order', JSON.stringify(next.map(b => b.id)))
    for (const old of this.snapshot().bookmarks) if (!retained.has(old.id)) { this.ctx.storage.db.prepare('DELETE FROM web_bookmarks WHERE id=?').run(old.id); this.ctx.storage.db.prepare('DELETE FROM credentials WHERE id=?').run(bookmarkCredentialKey(old.id)) }
    for (const entry of next) {
      const old = this.ctx.storage.db.prepare('SELECT name,url,version FROM web_bookmarks WHERE id=?').get(entry.id) as { name: string; url: string; version: number } | undefined
      if (!old) this.ctx.storage.db.prepare("INSERT INTO web_bookmarks(id,name,url,version,preview_state) VALUES(?,?,?,1,'failed')").run(entry.id, entry.name, entry.url)
      else if (old.name !== entry.name || old.url !== entry.url) {
        this.ctx.storage.db.prepare('UPDATE web_bookmarks SET name=?,url=?,version=version+1 WHERE id=?').run(entry.name, entry.url, entry.id)
        if (old.url !== entry.url) this.ctx.storage.db.prepare("UPDATE web_bookmarks SET thumbnail=NULL,captured_at=NULL,preview_state='failed' WHERE id=?").run(entry.id)
      }
    }
    this.advance()
  }
  notifySync() { this.queue.clear(); this.controller?.abort(); this.publish() }
  snapshot(): BookmarkSnapshot {
    const rows = this.ctx.storage.db.prepare(`SELECT b.id,b.name,b.url,b.version,b.captured_at,b.preview_state,
      EXISTS(SELECT 1 FROM credentials c WHERE c.id=('bookmark:' || b.id) AND c.kind='web-login') AS has_login
      FROM web_bookmarks b ORDER BY b.rowid`).all() as Row[]
    const order = new Map((JSON.parse(this.ctx.storage.getSetting('bookmarks-order') ?? '[]') as string[]).map((id, index) => [id, index]))
    rows.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    return { revision: Number(this.ctx.storage.getSetting('bookmarksRevision') ?? 0), bookmarks: rows.map(row => ({
      id: row.id, name: row.name, url: row.url, version: row.version, hasLogin: !!row.has_login,
      previewState: row.preview_state, capturedAt: row.captured_at,
    })) }
  }
  private entry(id: string) {
    const row = this.ctx.storage.db.prepare('SELECT id,name,url,version FROM web_bookmarks WHERE id=?').get(id) as CaptureJob & { name: string } | undefined
    if (!row) throw new AppError('NOT_FOUND', '网页收藏已不存在。')
    return row
  }
  save(input: unknown) {
    const params = record(input)
    let bookmark: ReturnType<typeof validateBookmark>
    try { bookmark = validateBookmark(params.bookmark) } catch (cause) { throw new AppError('INVALID_ARGUMENT', (cause as Error).message) }
    const expected = integer(params.expectedVersion, 0, Number.MAX_SAFE_INTEGER)
    let capture = false
    this.ctx.storage.db.transaction(() => {
      const old = this.ctx.storage.db.prepare('SELECT url,version FROM web_bookmarks WHERE id=?').get(bookmark.id) as { url: string; version: number } | undefined
      if ((old?.version ?? 0) !== expected) throw new AppError('REVISION_CONFLICT', '此网页收藏已改变，请重新打开编辑。')
      if (!old && (this.ctx.storage.db.prepare('SELECT COUNT(*) AS n FROM web_bookmarks').get() as { n: number }).n >= 200) throw new AppError('LIMIT', '最多保存 200 个网页收藏。')
      capture = !old || old.url !== bookmark.url
      if (old) {
        this.ctx.storage.db.prepare('UPDATE web_bookmarks SET name=?,url=?,version=version+1 WHERE id=?').run(bookmark.name, bookmark.url, bookmark.id)
        if (capture) this.ctx.storage.db.prepare("UPDATE web_bookmarks SET thumbnail=NULL,captured_at=NULL,preview_state='pending' WHERE id=?").run(bookmark.id)
      } else this.ctx.storage.db.prepare('INSERT INTO web_bookmarks(id,name,url,version) VALUES (?,?,?,1)').run(bookmark.id, bookmark.name, bookmark.url)
      this.ctx.credentials.saveBookmarkLogin(bookmark.id, params.login)
      this.advance()
    })()
    // An edit during capture replaces the queued job; old results can never overwrite it.
    if (capture || this.active?.id === bookmark.id || this.queue.has(bookmark.id)) this.enqueue(bookmark.id)
    this.publish()
    return this.snapshot()
  }
  remove(id: string, expected: number) {
    this.ctx.storage.db.transaction(() => {
      if (this.entry(id).version !== expected) throw new AppError('REVISION_CONFLICT', '此网页收藏已改变，请重新打开编辑。')
      this.ctx.storage.db.prepare('DELETE FROM credentials WHERE id=?').run(bookmarkCredentialKey(id))
      this.ctx.storage.db.prepare('DELETE FROM web_bookmarks WHERE id=?').run(id); this.advance()
    })()
    this.queue.delete(id)
    if (this.active?.id === id) this.controller?.abort()
    this.publish(); return this.snapshot()
  }
  refresh(id: string) {
    this.entry(id)
    if (this.active?.id !== id && !this.queue.has(id)) {
      this.ctx.storage.db.prepare("UPDATE web_bookmarks SET preview_state='pending' WHERE id=?").run(id)
      this.advance(); this.enqueue(id); this.publish()
    }
    return this.snapshot()
  }
  thumbnail(id: string) {
    this.entry(id)
    const row = this.ctx.storage.db.prepare('SELECT thumbnail,captured_at FROM web_bookmarks WHERE id=?').get(id) as { thumbnail: Buffer | null; captured_at: number | null }
    return { capturedAt: row.captured_at, dataUrl: row.thumbnail ? `data:image/jpeg;base64,${row.thumbnail.toString('base64')}` : null }
  }
  async reveal(id: string, version: number, password: string) {
    if (this.entry(id).version !== version) throw new AppError('REVISION_CONFLICT', '此网页收藏已改变，请重新打开。')
    await this.ctx.credentials.verifyReveal(password)
    if (this.entry(id).version !== version) throw new AppError('REVISION_CONFLICT', '此网页收藏已改变，请重新打开。')
    return this.ctx.credentials.bookmarkLogin(id)
  }
  private enqueue(id: string) {
    this.queue.set(id, this.entry(id))
    if (!this.running) {
      this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = undefined })
    }
  }
  private async drain() {
    while (!this.disposed && this.queue.size) {
      const job = this.queue.values().next().value!
      this.queue.delete(job.id); this.active = job; this.controller = new AbortController()
      this.ctx.storage.db.prepare("UPDATE web_bookmarks SET preview_state='capturing' WHERE id=?").run(job.id)
      this.advance(); this.publish()
      try {
        const image = await this.capture(job.url, this.controller.signal)
        if (image.length > 256 * 1024 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new Error('Invalid thumbnail')
        if (!this.disposed) this.commitPreview(job, image)
      } catch { if (!this.disposed) this.commitPreview(job) }
      finally { this.active = undefined; this.controller = undefined }
    }
  }
  private commitPreview(job: CaptureJob, image?: Buffer) {
    const result = image
      ? this.ctx.storage.db.prepare("UPDATE web_bookmarks SET thumbnail=?,captured_at=?,preview_state='ready' WHERE id=? AND version=? AND url=?").run(image, Date.now(), job.id, job.version, job.url)
      : this.ctx.storage.db.prepare("UPDATE web_bookmarks SET preview_state='failed' WHERE id=? AND version=? AND url=?").run(job.id, job.version, job.url)
    if (result.changes) { this.advance(); this.publish() }
  }
}
