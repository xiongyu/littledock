import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  extensionCipher, extensionProof, extensionTranscript, verifyExtensionProof, randomExtensionNonce, pairingCode,
  isExtensionOrigin, parseExtensionSite, websiteIdentity, websiteOrigin, validateBookmark,
  type ExtensionPairing, type ExtensionStatus, type ExtensionMatch,
} from '@webnav/shared'
import { AppError, integer, publicError, record, string } from '../core/errors.ts'

type PairRow = { id: string; name: string; origin: string; created: number; last_used: number }
type GrantRow = { bookmark_id: string; origin: string; automatic: number }
type PendingPair = { pairing: ExtensionPairing; name: string; owner: string }
type Peer = { ws: WebSocket; pairId?: string }
declare module 'cordis' { interface Context { browserExtension: BrowserExtensionService } }

export class BrowserExtensionService extends Service {
  static inject = ['storage', 'credentials', 'webBookmarks', 'auth']
  private wss = new WebSocketServer({ noServer: true, maxPayload: 36_000, perMessageDeflate: false })
  private pending = new Map<string, PendingPair>()
  private peers = new Set<Peer>()
  private usedOperations = new Map<string, number>()
  private attempts: number[] = []
  private serverId: string
  private endpoint: string
  private stopped = false
  private savingPeer?: Peer
  constructor(ctx: Context, config: { port: number }) {
    super(ctx, 'browserExtension', true)
    this.endpoint = `ws://127.0.0.1:${config.port}/ws/extension`
    this.serverId = ctx.storage.getSetting('extension-server-id') ?? randomUUID()
    ctx.storage.setSetting('extension-server-id', this.serverId)
    ctx.storage.db.exec(`CREATE TABLE IF NOT EXISTS extension_pairs (id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_grants (pair_id TEXT NOT NULL REFERENCES extension_pairs(id) ON DELETE CASCADE,
        bookmark_id TEXT NOT NULL REFERENCES web_bookmarks(id) ON DELETE CASCADE, origin TEXT NOT NULL, automatic INTEGER NOT NULL,
        PRIMARY KEY(pair_id,bookmark_id));
      CREATE TRIGGER IF NOT EXISTS extension_bookmark_url_changed AFTER UPDATE OF url ON web_bookmarks WHEN OLD.url != NEW.url
        BEGIN DELETE FROM extension_grants WHERE bookmark_id=NEW.id; END;`)
    const timer = setInterval(() => this.prune(), 10_000); timer.unref()
    ctx.on('dispose', ctx.credentials.subscribe(() => { if (!ctx.credentials.status().unlocked) { this.pending.clear(); this.closePeers() } }))
    let signature = this.bookmarkSignature()
    ctx.on('dispose', ctx.webBookmarks.subscribe(() => { const next = this.bookmarkSignature(); if (signature !== next) { signature = next; this.closePeers(undefined, this.savingPeer) } }))
    ctx.on('dispose', () => {
      this.stopped = true; clearInterval(timer); this.pending.clear(); this.usedOperations.clear()
      for (const peer of this.peers) peer.ws.terminate()
      this.peers.clear(); this.wss.close()
    })
  }
  private bookmarkSignature() { return JSON.stringify(this.ctx.webBookmarks.snapshot().bookmarks.map(b => [b.id, b.version, b.hasLogin])) }
  private prune() {
    const now = Date.now()
    for (const [id, pending] of this.pending) if (pending.pairing.expiresAt <= now || !this.ctx.auth.authorized(pending.owner)) this.pending.delete(id)
    for (const [id, expiry] of this.usedOperations) if (expiry <= now) this.usedOperations.delete(id)
  }
  private closePeers(id?: string, except?: Peer) { for (const peer of this.peers) if (peer !== except && (!id || peer.pairId === id)) peer.ws.close(4001, 'Authorization changed') }
  status(): ExtensionStatus {
    this.ctx.credentials.requireUnlocked()
    const bookmarks = new Map(this.ctx.webBookmarks.snapshot().bookmarks.map(b => [b.id, b]))
    return { devices: (this.ctx.storage.db.prepare('SELECT * FROM extension_pairs ORDER BY created').all() as PairRow[]).map(row => ({
      id: row.id, name: row.name, origin: row.origin, createdAt: row.created, lastUsedAt: row.last_used,
      grants: (this.ctx.storage.db.prepare('SELECT * FROM extension_grants WHERE pair_id=?').all(row.id) as GrantRow[]).map(g => ({ bookmarkId: g.bookmark_id, name: bookmarks.get(g.bookmark_id)?.name ?? '已删除网站', origin: g.origin, automatic: !!g.automatic })),
    })) }
  }
  async begin(owner: string, input: unknown, operationId: string) {
    const params = record(input), name = string(params.name, 60).trim()
    if (!name) throw new AppError('INVALID_ARGUMENT', '请给浏览器起一个名称。')
    await this.ctx.credentials.verifyReveal(string(params.masterPassword ?? '', 1024, true))
    if (!this.ctx.auth.authorized(owner) || this.stopped) throw new AppError('UNAUTHORIZED', '本机会话已失效。')
    this.prune()
    const operation = `pairing/${owner}/${operationId}`
    if (this.usedOperations.has(operation)) throw new AppError('ALREADY_REQUESTED', '配对码已经生成，请核对当前界面或重新生成。')
    if (this.usedOperations.size >= 1000) throw new AppError('BUSY', '请求过多，请稍后重试。')
    this.usedOperations.set(operation, Date.now() + 600_000)
    if (this.status().devices.length >= 16) throw new AppError('LIMIT', '最多配对 16 个浏览器，请先撤销不再使用的浏览器。')
    for (const [id, pending] of this.pending) if (pending.owner === owner) this.pending.delete(id)
    if (this.pending.size >= 8) throw new AppError('BUSY', '待配对请求过多。')
    const pairing: ExtensionPairing = { v: 1, id: randomUUID(), key: randomExtensionNonce(), serverId: this.serverId, endpoint: this.endpoint, expiresAt: Date.now() + 120_000 }
    this.pending.set(pairing.id, { pairing, name, owner })
    return { id: pairing.id, code: pairingCode(pairing), expiresAt: pairing.expiresAt }
  }
  cancel(owner: string, id: string) { if (this.pending.get(id)?.owner === owner) this.pending.delete(id); return {} }
  revoke(id: string) {
    this.ctx.credentials.requireUnlocked()
    this.ctx.storage.db.transaction(() => {
      this.ctx.storage.db.prepare('DELETE FROM extension_pairs WHERE id=?').run(id)
      this.ctx.storage.db.prepare("DELETE FROM credentials WHERE id=? AND kind='extension-key'").run(`extension:${id}`)
    })()
    this.closePeers(id); return this.status()
  }
  revokeGrant(id: string, bookmarkId: string) {
    this.ctx.credentials.requireUnlocked()
    this.ctx.storage.db.prepare('DELETE FROM extension_grants WHERE pair_id=? AND bookmark_id=?').run(id, bookmarkId)
    this.closePeers(id); return this.status()
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = request.headers.origin ?? '', now = Date.now()
    this.attempts = this.attempts.filter(t => now - t < 60_000)
    if (this.stopped || request.headers.host !== new URL(this.endpoint).host || request.url !== '/ws/extension' || !isExtensionOrigin(origin) || this.wss.clients.size >= 16 || this.attempts.length >= 60) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    this.attempts.push(now)
    this.wss.handleUpgrade(request, socket, head, ws => this.connect(ws, origin))
  }
  private active(peer: Peer) {
    if (this.stopped || peer.ws.readyState !== WebSocket.OPEN) throw new AppError('UNAUTHORIZED', '扩展连接已失效。')
    this.ctx.credentials.requireUnlocked()
    if (!peer.pairId || !this.ctx.storage.db.prepare('SELECT 1 FROM extension_pairs WHERE id=?').get(peer.pairId)) throw new AppError('UNAUTHORIZED', '扩展授权已撤销。')
  }
  private connect(ws: WebSocket, origin: string) {
    const peer: Peer = { ws }; this.peers.add(peer)
    let cipher: Awaited<ReturnType<typeof extensionCipher>> | undefined, queued = 0, sequence = Promise.resolve(), authenticated = false
    const serverNonce = randomExtensionNonce(), seen = new Set<string>()
    const authTimer = setTimeout(() => ws.close(1008, 'Handshake timeout'), 10_000)
    const lifetime = setTimeout(() => ws.close(4000, 'Session expired'), 600_000)
    let alive = true
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping() } }, 20_000)
    ws.on('pong', () => { alive = true })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => { clearTimeout(authTimer); clearTimeout(lifetime); clearInterval(heartbeat); this.peers.delete(peer); cipher = undefined; seen.clear() })
    if (!this.ctx.credentials.status().unlocked) { ws.send(JSON.stringify({ type: 'unavailable', code: 'VAULT_LOCKED' })); ws.close(4001); return }
    ws.send(JSON.stringify({ v: 1, type: 'challenge', serverId: this.serverId, nonce: serverNonce }))
    ws.on('message', (raw, binary) => {
      if (binary || queued >= 8) { ws.close(1008); return }
      queued++
      sequence = sequence.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        const message = record(JSON.parse(raw.toString()))
        if (!authenticated) {
          if (message.type !== 'authenticate' || message.v !== 1) throw new Error('Invalid handshake')
          const id = string(message.id, 36), clientNonce = string(message.nonce, 43), proof = string(message.proof, 43)
          this.prune()
          const pending = this.pending.get(id), old = this.ctx.storage.db.prepare('SELECT * FROM extension_pairs WHERE id=?').get(id) as PairRow | undefined
          const key = pending?.pairing.key ?? (old?.origin === origin ? this.ctx.credentials.extensionKey(id) : undefined)
          if (!key) throw new Error('Unpaired extension')
          const transcript = extensionTranscript(this.serverId, this.endpoint, origin, id, serverNonce, clientNonce)
          if (!await verifyExtensionProof(key, transcript, 'client', proof)) throw new Error('Invalid proof')
          this.ctx.credentials.requireUnlocked()
          if (ws.readyState !== WebSocket.OPEN) return
          if (pending) {
            if (this.pending.get(id) !== pending || pending.pairing.expiresAt <= Date.now() || !this.ctx.auth.authorized(pending.owner)) throw new Error('Pairing expired')
            if (this.status().devices.length >= 16) throw new Error('Pair limit')
            this.ctx.storage.db.transaction(() => {
              this.ctx.storage.db.prepare('INSERT INTO extension_pairs VALUES (?,?,?,?,?)').run(id, pending.name, origin, Date.now(), Date.now())
              this.ctx.credentials.saveExtensionKey(id, key)
            })()
            this.pending.delete(id)
          }
          peer.pairId = id; this.active(peer)
          cipher = await extensionCipher(key, transcript, 'server')
          const serverProof = await extensionProof(key, transcript, 'server')
          this.active(peer)
          authenticated = true; clearTimeout(authTimer)
          this.ctx.storage.db.prepare('UPDATE extension_pairs SET last_used=? WHERE id=?').run(Date.now(), id)
          ws.send(JSON.stringify({ v: 1, type: 'authenticated', proof: serverProof }))
          return
        }
        this.active(peer)
        const request = await cipher!.open(message), id = string(request.id, 100), method = string(request.method, 40)
        if (seen.has(id) || seen.size >= 500) throw new Error('Duplicate or excessive request')
        seen.add(id)
        let response: unknown
        try { response = { id, ok: true, result: this.dispatch(peer, method, record(request.params ?? {})) } }
        catch (cause) { response = { id, ok: false, error: publicError(cause) } }
        const encrypted = await cipher!.seal(response)
        this.active(peer)
        if (ws.bufferedAmount > 64_000) throw new Error('Slow peer')
        ws.send(JSON.stringify(encrypted))
      }).catch(() => { ws.close(1008, 'Extension authorization failed') }).finally(() => { queued-- })
    })
  }
  private entry(params: Record<string, unknown>) {
    let site: ReturnType<typeof parseExtensionSite>
    try { site = parseExtensionSite(params.site) } catch { throw new AppError('INVALID_ARGUMENT', '网页来源不正确。') }
    const id = string(params.bookmarkId, 100), version = integer(params.version, 1, Number.MAX_SAFE_INTEGER)
    const bookmark = this.ctx.webBookmarks.snapshot().bookmarks.find(b => b.id === id && b.hasLogin)
    if (!bookmark || websiteIdentity(bookmark.url) !== websiteIdentity(site.origin)) throw new AppError('NOT_FOUND', '当前网址没有匹配的账号。')
    if (bookmark.version !== version) throw new AppError('REVISION_CONFLICT', '账号已改变，请重新选择。')
    return { bookmark, site }
  }
  private dispatch(peer: Peer, method: string, params: Record<string, unknown>): unknown {
    this.active(peer)
    if (method === 'ping') return {}
    if (method === 'saveTargets' || method === 'saveBookmark') {
      let site: ReturnType<typeof parseExtensionSite>
      try { site = parseExtensionSite(params.site) } catch { throw new AppError('INVALID_ARGUMENT', '网页来源不正确。') }
      const targets = this.ctx.webBookmarks.snapshot().bookmarks.filter(b => websiteIdentity(b.url) === websiteIdentity(site.origin))
      if (method === 'saveTargets') return { targets: targets.map(({ id, name, version, hasLogin }) => ({ id, name, version, hasLogin })) }
      let bookmark: ReturnType<typeof validateBookmark>
      try { bookmark = validateBookmark(params.bookmark) } catch (cause) { throw new AppError('INVALID_ARGUMENT', (cause as Error).message) }
      if (websiteOrigin(bookmark.url) !== site.origin) throw new AppError('INVALID_ARGUMENT', '只能保存当前网页所属网站。')
      const operation = `${peer.pairId}/save/${string(params.operationId, 100)}`
      this.prune()
      if (this.usedOperations.has(operation)) throw new AppError('ALREADY_REQUESTED', '此保存操作已经接收，请在 WebNav 核对结果。')
      const expectedVersion = integer(params.expectedVersion, 0, Number.MAX_SAFE_INTEGER)
      const existing = this.ctx.webBookmarks.snapshot().bookmarks.find(b => b.id === bookmark.id)
      if (expectedVersion > 0 && !targets.some(b => b.id === bookmark.id)) throw new AppError('NOT_FOUND', '只能更新当前网站的已有收藏。')
      if ((existing?.version ?? 0) !== expectedVersion) throw new AppError('REVISION_CONFLICT', '收藏已改变，请重新读取当前网页。')
      if (params.login !== undefined) {
        const login = record(params.login)
        if (Object.keys(login).some(key => !['username', 'password'].includes(key))) throw new AppError('INVALID_ARGUMENT', '账号密码字段不正确。')
        const username = string(login.username, 256, true), password = string(login.password, 4096, true)
        if ((!username && !password) || username.includes('\0') || password.includes('\0')) throw new AppError('INVALID_ARGUMENT', '请填写账号或密码，或取消保存账号密码。')
      }
      if (this.usedOperations.size >= 1000) throw new AppError('BUSY', '操作过多，请稍后重试。')
      this.usedOperations.set(operation, Date.now() + 600_000)
      // Publishing closes other peers immediately. Keep the writer alive to acknowledge this commit;
      // its background closes the connection after receiving the response and clears pending fills.
      this.savingPeer = peer
      try {
        this.ctx.get('maintenance')?.requireAvailable()
        this.ctx.webBookmarks.save({ bookmark, expectedVersion, ...(params.login === undefined ? {} : { login: params.login }) })
        return { saved: true, bookmarkId: bookmark.id, version: expectedVersion + 1 }
      } finally { this.savingPeer = undefined }
    }
    if (method === 'matches') {
      let site: ReturnType<typeof parseExtensionSite>
      try { site = parseExtensionSite(params.site) } catch { throw new AppError('INVALID_ARGUMENT', '网页来源不正确。') }
      const matches: ExtensionMatch[] = this.ctx.webBookmarks.snapshot().bookmarks.filter(b => b.hasLogin && websiteIdentity(b.url) === websiteIdentity(site.origin)).map(b => {
        const grant = this.ctx.storage.db.prepare('SELECT * FROM extension_grants WHERE pair_id=? AND bookmark_id=? AND origin=?').get(peer.pairId!, b.id, websiteIdentity(site.origin)) as GrantRow | undefined
        const name = this.ctx.credentials.bookmarkLogin(b.id).username
        return { id: b.id, name: b.name, version: b.version, usernameHint: name ? name.slice(0, 1) + '•••' : '未保存账号', allowed: !!grant, automatic: !!grant?.automatic }
      })
      return { matches }
    }
    if (method === 'grant') {
      const { bookmark, site } = this.entry(params)
      if (typeof params.automatic !== 'boolean') throw new AppError('INVALID_ARGUMENT', '自动填写选项不正确。')
      const operation = `${peer.pairId}/${string(params.operationId, 100)}`
      this.prune()
      if (this.usedOperations.has(operation)) throw new AppError('ALREADY_REQUESTED', '此操作已接收，请重新读取网站授权。')
      if (this.usedOperations.size >= 1000) throw new AppError('BUSY', '操作过多，请稍后重试。')
      this.usedOperations.set(operation, Date.now() + 600_000)
      this.ctx.storage.db.transaction(() => {
        // A site has at most one automatic account for each paired browser.
        if (params.automatic) this.ctx.storage.db.prepare('UPDATE extension_grants SET automatic=0 WHERE pair_id=? AND origin=?').run(peer.pairId!, websiteIdentity(site.origin))
        this.ctx.storage.db.prepare('INSERT OR REPLACE INTO extension_grants VALUES (?,?,?,?)').run(peer.pairId!, bookmark.id, websiteIdentity(site.origin), params.automatic ? 1 : 0)
      })()
      return { saved: true }
    }
    if (method === 'fill') {
      const { bookmark, site } = this.entry(params)
      const grant = this.ctx.storage.db.prepare('SELECT * FROM extension_grants WHERE pair_id=? AND bookmark_id=? AND origin=?').get(peer.pairId!, bookmark.id, websiteIdentity(site.origin)) as GrantRow | undefined
      if (!grant || (params.automatic !== false && (params.automatic !== true || !grant.automatic))) throw new AppError('CONSENT_REQUIRED', '请先在扩展中允许此账号填写。')
      const documentToken = string(params.documentToken, 100)
      return { ...this.ctx.credentials.bookmarkLogin(bookmark.id), origin: site.origin, documentToken, expiresAt: Date.now() + 5000 }
    }
    throw new AppError('METHOD_NOT_FOUND', '扩展不允许执行此操作。')
  }
}
