import { Service, type Context } from 'cordis'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SyncChoice, SyncPreview, SyncSettings, SyncStatus } from '@webnav/shared'
import { AppError, integer, record, string } from '../../core/errors.ts'
import { credentialKey } from '../storage.ts'
import { decrypt, deriveKey, digest, encrypt, freshKeyInfo, parseEnvelope, type KeyInfo } from './crypto.ts'
import { GitSyncRemote, parseSyncSettings, type RemoteFactory, type SyncRemote } from './git.ts'
import { applySnapshot, canonical, capture, localStamp, mergeSnapshots, parsePayload, parseSnapshot, type Payload, type PortableSnapshot } from './snapshot.ts'

interface Pending { expected: string | null; candidate: string; text: string; stamp: string; operationId: string; rotation?: boolean }
interface SavedState { baseline?: string; version?: string | null; hash?: string; lastSuccess?: number; pending?: Pending }
interface Plan { owner: string; public: SyncPreview; candidate: PortableSnapshot; remoteText: string | null; stamp: string; generation: number }
declare module 'cordis' { interface Context { configSync: ConfigSyncService } }

export class ConfigSyncService extends Service {
  static inject = ['storage', 'credentials', 'terminalThemes', 'webBookmarks', 'plugins']
  private settings: SyncSettings | null
  private state: SavedState
  private key?: Buffer
  private info?: KeyInfo
  private token = ''
  private expiresAt: number | null = null
  private timer?: ReturnType<typeof setTimeout>
  private controller = new AbortController()
  private generation = 0
  private busy = false
  private plans = new Map<string, Plan>()
  private listeners = new Set<() => void>()
  private message = '尚未配置同步空间。'
  private factory: RemoteFactory
  private nextCheck = 0
  private observed = ''
  private changedAt = 0
  private backoff = 0
  private disposed = false
  private job?: Promise<unknown>
  constructor(ctx: Context, config: { factory?: RemoteFactory } = {}) {
    super(ctx, 'configSync', true)
    const settings = ctx.storage.getSetting('config-sync-profile')
    this.settings = settings ? parseSyncSettings(JSON.parse(settings)) : null
    this.state = JSON.parse(ctx.storage.getSetting('config-sync-state') ?? '{}') as SavedState
    this.message = this.settings ? '输入同步账号密码解锁。' : this.message
    this.factory = config.factory ?? (async (settings, token, signal) => { const remote = new GitSyncRemote(join(ctx.storage.directory, 'plugins', 'data', 'builtin.configSync', 'git'), settings, token, signal); try { return await remote.initialize() } catch (error) { await remote.close(); throw error } })
    const unwatch = ctx.credentials.subscribe(status => { if (!status.unlocked) this.lock(); if (status.mode === 'local' && ctx.credentials.hasSyncToken()) ctx.credentials.saveSyncToken(null) })
    const automatic = setInterval(() => { void this.tick() }, 5000); automatic.unref()
    ctx.on('dispose', async () => { this.disposed = true; clearInterval(automatic); unwatch(); this.lock(); await this.job?.catch(() => {}); this.listeners.clear() })
  }
  private save() { this.ctx.storage.setSetting('config-sync-state', JSON.stringify(this.state)) }
  private publish() { if (!this.disposed) for (const listener of this.listeners) listener() }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  status(): SyncStatus {
    if (this.disposed) return { settings: this.settings, unlocked: false, expiresAt: null, hasToken: false, tokenSaved: false, busy: false, message: '同步服务已停止。', lastSuccess: this.state.lastSuccess ?? null, pending: !!this.state.pending, hasBaseline: !!this.state.baseline, bindings: [], pluginPlan: [] }
    const bindings = new Set<string>(JSON.parse(this.ctx.storage.getSetting('sync-bindings') ?? '[]') as string[])
    return { settings: this.settings, unlocked: !!this.key, expiresAt: this.expiresAt, hasToken: !!this.token || this.ctx.credentials.hasSyncToken(), tokenSaved: this.ctx.credentials.hasSyncToken(), busy: this.busy, message: this.message, lastSuccess: this.state.lastSuccess ?? null, pending: !!this.state.pending, hasBaseline: !!this.state.baseline,
      bindings: this.ctx.storage.snapshot().snapshot.servers.flatMap(s => s.connections.filter(c => bindings.has(credentialKey(s.id, c.id))).map(c => ({ serverId: s.id, connectionId: c.id, name: `${s.name} / ${c.name}` }))), pluginPlan: JSON.parse(this.ctx.storage.getSetting('sync-plugin-plan') ?? '[]') as SyncStatus['pluginPlan'] }
  }
  lock() { this.generation++; this.controller.abort(); this.controller = new AbortController(); clearTimeout(this.timer); this.key?.fill(0); this.key = undefined; this.info = undefined; this.token = ''; this.expiresAt = null; this.plans.clear(); this.message = this.state.pending ? '同步已锁定，有上传结果需要核对。' : '同步已锁定。'; this.publish(); return this.status() }
  private requireKey() { this.ctx.credentials.requireUnlocked(); if (!this.key || !this.info) throw new AppError('SYNC_LOCKED', '请先输入同步账号密码解锁。'); return { key: this.key, info: this.info } }
  private current() { if (!this.settings) throw new AppError('INVALID_ARGUMENT', '请先保存存储位置。'); return this.settings }
  private async run<T>(message: string, action: (remote: SyncRemote, generation: number) => Promise<T>): Promise<T> {
    this.ctx.credentials.requireUnlocked()
    if (this.busy) throw new AppError('BUSY', '上一项同步任务尚未完成。')
    const settings = this.current(), generation = this.generation
    this.busy = true; this.message = message; this.publish()
    const task = (async () => { const remote = await this.factory(settings, this.token || this.ctx.credentials.syncToken(), this.controller.signal); try { const result = await action(remote, generation); this.checkGeneration(generation); return result } finally { await remote.close() } })()
    this.job = task
    try { return await task }
    catch (error) { this.message = error instanceof AppError ? error.message : '同步未完成，配置已保留。'; throw error }
    finally { this.busy = false; this.job = undefined; this.publish() }
  }
  private checkGeneration(generation: number) { this.ctx.credentials.requireUnlocked(); if (this.disposed || generation !== this.generation) throw new AppError('CANCELLED', '同步已锁定或配置已改变。') }
  configure(input: unknown) {
    this.ctx.credentials.requireUnlocked()
    if (this.busy) throw new AppError('BUSY', '请先完成正在运行的同步任务。')
    const p = record(input), next = parseSyncSettings(p.settings)
    if (this.state.pending && canonical(next) !== canonical(this.settings)) throw new AppError('SYNC_PENDING', '请先核对待处理操作，再改变同步位置或范围。可以先更新同一位置的仓库令牌。')
    if (p.expected !== canonical(this.settings)) throw new AppError('REVISION_CONFLICT', '同步设置已改变，请重新打开。')
    const token = p.token === undefined ? undefined : string(p.token, 4096, true)
    if (token && /[\r\n\0]/.test(token)) throw new AppError('INVALID_ARGUMENT', '仓库令牌格式无效。')
    if (p.saveToken === true && this.ctx.credentials.status().mode !== 'master') throw new AppError('MASTER_PASSWORD_REQUIRED', '保存令牌需要设置本地主密码。')
    const changedSpace = !this.settings || ['repository', 'branch', 'spaceId'].some(k => this.settings![k as keyof SyncSettings] !== next[k as keyof SyncSettings])
    const previousToken = this.token
    this.lock()
    this.ctx.storage.db.transaction(() => {
      if (changedSpace || p.saveToken === false) this.ctx.credentials.saveSyncToken(null)
      if (p.saveToken === true && token) this.ctx.credentials.saveSyncToken(token)
      this.ctx.storage.setSetting('config-sync-profile', JSON.stringify(next))
      if (changedSpace) { this.state = {}; this.save() }
    })()
    this.settings = next; this.token = token ?? (changedSpace ? '' : previousToken); this.message = '存储位置已保存，请解锁同步空间。'; this.publish(); return this.status()
  }
  async check() { return this.run('正在检查仓库访问…', async remote => { const head = await remote.read(); this.message = head.text ? '仓库可读取，已找到同步文件；写权限将在提交时确认。' : '仓库可读取，此空间尚无同步文件。'; return this.status() }) }
  async unlock(input: unknown) {
    const p = record(input), account = string(p.account, 256), password = string(p.password, 1024), minutes = integer(p.minutes ?? 30, 0, 1440)
    const token = p.token === undefined ? undefined : string(p.token, 4096, true)
    if (token && /[\r\n\0]/.test(token)) throw new AppError('INVALID_ARGUMENT', '仓库令牌格式无效。')
    if (token !== undefined) this.token = token
    return this.run('正在读取并解锁同步空间…', async (remote, generation) => {
      const head = await remote.read(), settings = this.current()
      if (!head.text && (this.state.baseline || this.state.pending)) throw new AppError('SYNC_REMOVED', '云端同步文件消失，已停止同步。请检查分支或连接其他空间。')
      if (!head.text && p.create !== true) throw new AppError('SYNC_EMPTY', '此空间尚未创建，请选择“新建同步空间”。')
      let text = this.state.pending?.text ?? head.text, info = text ? parseEnvelope(text, settings.spaceId).header : freshKeyInfo(), key: Buffer | undefined
      try {
        key = await deriveKey(account, password, info, this.controller.signal)
        if (text) parsePayload(decrypt(key, settings.spaceId, text))
        this.checkGeneration(generation)
        this.key?.fill(0); this.key = key; key = undefined; this.info = { salt: info.salt, epoch: info.epoch }
        clearTimeout(this.timer); this.expiresAt = minutes ? Date.now() + minutes * 60_000 : null
        if (minutes) { this.timer = setTimeout(() => this.lock(), minutes * 60_000); this.timer.unref() }
        this.message = this.state.pending ? '已解锁，请核对待处理操作。' : head.text ? '已解锁，可以预览同步差异。' : '已创建本次加密密钥；确认同步后才上传。'
        this.nextCheck = Date.now() + 300_000; return this.status()
      } finally { key?.fill(0) }
    })
  }
  private decode(text: string): Payload {
    const { key, info } = this.requireKey(), header = parseEnvelope(text, this.current().spaceId).header
    if (header.epoch !== info.epoch || header.salt !== info.salt) throw new AppError('SYNC_KEY_CHANGED', '同步账号密码已改变，请锁定后重新解锁。')
    return parsePayload(decrypt(key, this.current().spaceId, text))
  }
  async preview(owner: string, input: unknown): Promise<SyncPreview> {
    this.requireKey()
    if (this.state.pending) throw new AppError('SYNC_PENDING', '请先核对待处理操作。')
    const p = record(input), mode = p.mode ?? 'merge'
    if (!['merge', 'local', 'remote', 'restore'].includes(String(mode))) throw new AppError('INVALID_ARGUMENT', '同步方式无效。')
    const choices = record(p.choices ?? {}) as Record<string, SyncChoice>
    if (Object.keys(choices).length > 25000 || Object.values(choices).some(v => v !== 'local' && v !== 'remote')) throw new AppError('INVALID_ARGUMENT', '冲突选择无效。')
    return this.run('正在比较本机与云端配置…', async (remote, generation) => {
      const head = await remote.read(); this.checkGeneration(generation)
      const remotePayload = head.text ? this.decode(head.text) : null
      if (!head.text && this.state.baseline) throw new AppError('SYNC_REMOVED', '云端同步文件消失，已停止同步。')
      if (head.text && this.state.hash && digest(head.text) !== this.state.hash && !remotePayload!.ancestors.includes(this.state.hash) && p.acceptDiscontinuity !== true) throw new AppError('SYNC_ROLLBACK', '云端历史与本机基线不连续。请核查仓库后勾选“接受已核查的云端历史”并重新预览。')
      const settings = this.current(), local = capture(this.ctx, settings), stamp = localStamp(this.ctx)
      const base = this.state.baseline ? this.decode(this.state.baseline).snapshot : null
      let right = remotePayload?.snapshot ?? structuredClone(local)
      if (mode === 'restore') {
        const text = await remote.version(string(p.version, 40)); this.checkGeneration(generation)
        if (p.oldPassword !== undefined) {
          const info = parseEnvelope(text, settings.spaceId).header, key = await deriveKey(string(p.oldAccount, 256), string(p.oldPassword, 1024), info, this.controller.signal)
          try { right = parsePayload(decrypt(key, settings.spaceId, text)).snapshot } finally { key.fill(0) }
        } else right = this.decode(text).snapshot
      }
      // An unselected section is retained remotely, never represented as deletion.
      if (!settings.includeSecrets) { local.secrets = right.secrets; if (base) base.secrets = right.secrets }
      else if (right.secrets === null) right.secrets = structuredClone(local.secrets)
      if (!settings.includePlugins) { local.plugins = right.plugins; if (base) base.plugins = right.plugins }
      else if (right.plugins === null) right.plugins = structuredClone(local.plugins)
      const merged = mergeSnapshots(base, local, right, choices, mode === 'restore' ? 'remote' : mode as 'merge' | 'local' | 'remote')
      const warnings: string[] = []; let candidate: PortableSnapshot
      try { candidate = parseSnapshot(merged.candidate) } catch (cause) { throw new AppError('SYNC_MERGE_INVALID', `合并结果需要调整：${cause instanceof Error ? cause.message : '引用或层级冲突'}。可选择整体采用本机或云端后重新预览。`) }
      if (mode === 'restore') warnings.push('将把所选旧配置保存为一个新版本，可能删除当前条目。')
      if (!base && head.text) warnings.push('首次接入，请核对合并或覆盖方式；确认后才建立共同基线。')
      if (candidate.catalog.servers.some(s => s.connections.some(c => (['local', 'adb'].includes(c.type) || c.type.startsWith('plugin:')) && !local.catalog.servers.find(x=>x.id===s.id)?.connections.some(x=>x.id===c.id)))) warnings.push('新恢复的本机终端、ADB 或第三方入口需要检查并确认本机绑定。')
      if (!head.text) warnings.push(`首次创建空间，将上传 ${candidate.catalog.servers.length} 台服务器、${candidate.bookmarks.length} 个网页收藏的加密配置。`)
      this.checkGeneration(generation)
      if (localStamp(this.ctx) !== stamp) throw new AppError('REVISION_CONFLICT', '本机配置在预览期间改变，请重试。')
      const preview: SyncPreview = { token: randomUUID(), first: !base, remoteVersion: head.version, changes: [...merged.changes].sort((a,b)=>Number(b.conflict)-Number(a.conflict)).slice(0,200), changeCount: merged.changes.length, hasDeletions: merged.changes.some(c=>c.action==='delete'), conflicts: merged.conflicts, warnings, expiresAt: Date.now() + 300_000, mode: mode as SyncPreview['mode'] }
      for (const [key, plan] of this.plans) if (plan.public.expiresAt < Date.now() || plan.owner === owner) this.plans.delete(key)
      if (this.plans.size >= 8) throw new AppError('BUSY', '同步预览过多，请稍后重试。')
      this.plans.set(preview.token, { owner, public: preview, candidate, stamp, generation, remoteText: head.text }); this.message = preview.conflicts ? `发现 ${preview.conflicts} 项冲突，请选择来源。` : '差异预览已就绪，确认后同步。'; return preview
    })
  }
  private complete(text: string, version: string | null) { this.state = { baseline: text, hash: digest(text), version, lastSuccess: Date.now() }; this.save() }
  async apply(owner: string, input: unknown) {
    const p = record(input), plan = this.plans.get(string(p.token)), { key, info } = this.requireKey()
    if (!plan || plan.owner !== owner || plan.public.expiresAt < Date.now() || plan.generation !== this.generation) throw new AppError('PREVIEW_EXPIRED', '同步预览已失效，请重新预览。')
    if (plan.public.conflicts) throw new AppError('SYNC_CONFLICT', '请解决冲突并更新预览。')
    if (this.state.pending) throw new AppError('SYNC_PENDING', '请先核对待处理操作。')
    return this.run('正在提交加密配置…', async (remote, generation) => {
      if (localStamp(this.ctx) !== plan.stamp) throw new AppError('REVISION_CONFLICT', '本机配置已改变，请重新预览。')
      const head = await remote.read(); this.checkGeneration(generation)
      if (head.version !== plan.public.remoteVersion || head.text !== plan.remoteText) throw new AppError('SYNC_CONFLICT', '云端已改变，请重新预览。')
      const old = head.text ? this.decode(head.text) : null
      if (old && canonical(old.snapshot) === canonical(plan.candidate)) {
        const previous = structuredClone(this.state)
        try { applySnapshot(this.ctx, plan.candidate, this.current(), plan.stamp, () => this.complete(head.text!, head.version)) } catch(error) { this.state = previous; throw error }
        this.plans.clear(); this.message = '已同步，无需上传新版本。'; return this.status()
      }
      const payload: Payload = { version: 1, operationId: randomUUID(), ancestors: head.text ? [digest(head.text), ...(old?.ancestors ?? [])].slice(0, 128) : [], snapshot: plan.candidate }
      const text = encrypt(key, info, this.current().spaceId, payload), candidate = await remote.prepare(head.version, text)
      this.checkGeneration(generation)
      if (localStamp(this.ctx) !== plan.stamp) throw new AppError('REVISION_CONFLICT', '本机配置已改变，请重新预览。')
      this.state.pending = { expected: head.version, candidate, text, stamp: plan.stamp, operationId: payload.operationId }; this.save()
      try { await remote.publish(head.version, candidate) } catch(error) { if(error instanceof AppError && error.code==='SYNC_CONFLICT'){delete this.state.pending;this.save()} throw error }
      this.checkGeneration(generation)
      if (!await remote.contains(candidate)) throw new AppError('SYNC_UNKNOWN', '提交尚未核实，请核对待处理操作。')
      this.checkGeneration(generation)
      const previous = structuredClone(this.state)
      try { applySnapshot(this.ctx, plan.candidate, this.current(), plan.stamp, () => this.complete(text, candidate)) } catch (error) { this.state = previous; throw error }
      this.plans.clear(); this.message = '配置同步完成。'; this.observed = ''; return this.status()
    })
  }
  async recover(input: unknown) {
    this.requireKey(); const p = record(input), pending = this.state.pending
    if (!pending) return this.status()
    return this.run('正在核对待处理提交…', async (remote, generation) => {
      let exists = await remote.contains(pending.candidate)
      if (!exists) {
        const head = await remote.read(); this.checkGeneration(generation)
        if (head.version !== pending.expected) throw new AppError('SYNC_UNKNOWN', '未找到待处理提交，且云端已经变化。保留待处理记录，请检查仓库历史。')
        if (p.retry !== true) { this.message = '当前云端尚未包含此提交。可以明确选择重送原提交，或继续核对。'; return this.status() }
        await remote.publish(pending.expected, pending.candidate); exists = await remote.contains(pending.candidate)
      }
      this.checkGeneration(generation)
      if (!exists) throw new AppError('SYNC_UNKNOWN', '提交结果仍待确认。')
      const payload = this.decode(pending.text), previous = structuredClone(this.state)
      if (pending.rotation) { this.complete(pending.text, pending.candidate); this.message = '新密码提交已确认，本机配置保持不变。' }
      else if (localStamp(this.ctx) !== pending.stamp) {
        // Keep the OLD common base: advancing it would mistake unapplied remote additions for local deletions.
        delete this.state.pending; this.save(); this.message = '远端提交已确认；保留了之后的本机修改，请重新预览同步。'
      } else {
        try { applySnapshot(this.ctx, payload.snapshot, this.current(), pending.stamp, () => this.complete(pending.text, pending.candidate)) } catch (error) { this.state = previous; throw error }
        this.message = '待处理操作已核对并完成。'
      }
      return this.status()
    })
  }
  async history(input: unknown) { this.requireKey(); const p = record(input); return this.run('正在读取加密历史…', async remote => { const result = await remote.history(p.cursor === undefined ? undefined : string(p.cursor, 80)); this.message = '历史列表已读取，恢复前会显示差异。'; return result }) }
  async rotate(input: unknown) {
    this.requireKey(); if (this.state.pending) throw new AppError('SYNC_PENDING', '请先核对待处理操作。')
    const p = record(input)
    if (p.acceptHistory !== true) throw new AppError('INVALID_ARGUMENT', '请确认旧历史仍需要旧密码。')
    return this.run('正在更换同步账号密码…', async (remote, generation) => {
      const head = await remote.read(); if (!head.text) throw new AppError('SYNC_EMPTY', '请先完成首次同步。')
      const current = this.decode(head.text)
      if (this.state.hash !== digest(head.text)) throw new AppError('SYNC_CONFLICT', '请先同步到当前云端版本，再更换密码。')
      const info = freshKeyInfo(), nextKey = await deriveKey(string(p.account, 256), string(p.password, 1024), info, this.controller.signal)
      try {
        this.checkGeneration(generation)
        const payload: Payload = { ...current, operationId: randomUUID(), ancestors: [digest(head.text), ...current.ancestors].slice(0, 128) }, text = encrypt(nextKey, info, this.current().spaceId, payload), candidate = await remote.prepare(head.version, text), stamp = localStamp(this.ctx)
        this.checkGeneration(generation); this.state.pending = { expected: head.version, candidate, text, stamp, operationId: payload.operationId, rotation: true }; this.save()
        // Once a candidate exists, recovery uses the new credentials even after an unknown outcome.
        const oldKey = Buffer.from(this.key!), oldInfo = this.info!
        this.key!.fill(0); this.key = Buffer.from(nextKey); this.info = info
        try { await remote.publish(head.version, candidate) }
        catch(error) {
          if(error instanceof AppError && error.code==='SYNC_CONFLICT' && generation===this.generation) { this.key.fill(0);this.key=Buffer.from(oldKey);this.info=oldInfo;delete this.state.pending;this.save() }
          throw error
        } finally { oldKey.fill(0) }
        this.checkGeneration(generation)
        if (!await remote.contains(candidate)) throw new AppError('SYNC_UNKNOWN', '新密码提交结果待确认，请用新密码核对。')
        this.complete(text, candidate); this.plans.clear(); this.message = '同步账号密码已更换，其他电脑需重新解锁；旧历史仍使用旧密码。'; return this.status()
      } finally { nextKey.fill(0) }
    })
  }
  confirmBinding(input: unknown) {
    this.ctx.credentials.requireUnlocked(); const p = record(input)
    if (p.confirm !== true) throw new AppError('INVALID_ARGUMENT', '请确认已检查本机资源。')
    const serverId = string(p.serverId), connectionId = string(p.connectionId); this.ctx.storage.connection(serverId, connectionId)
    const keys = JSON.parse(this.ctx.storage.getSetting('sync-bindings') ?? '[]') as string[]
    this.ctx.storage.setSetting('sync-bindings', JSON.stringify(keys.filter(k => k !== credentialKey(serverId, connectionId)))); this.publish(); return this.status()
  }
  private async tick() {
    if (this.ctx.get('maintenance')?.draining) return
    if (this.disposed || this.busy || !this.key || !this.settings?.autoSync || !this.state.baseline || this.state.pending || !this.ctx.credentials.status().unlocked) return
    const now = Date.now(), stamp = localStamp(this.ctx)
    if (stamp !== this.observed) { this.observed = stamp; this.changedAt = now }
    if (now < this.nextCheck && (!this.changedAt || now - this.changedAt < 30_000)) return
    this.changedAt = 0; this.nextCheck = now + 300_000 + Math.random() * 30_000
    try {
      const preview = await this.preview('@automatic', {})
      if (preview.conflicts || preview.hasDeletions || preview.warnings.length) { this.message = '自动同步发现需要确认的变更，请打开预览。'; this.publish(); return }
      if (preview.changeCount) await this.apply('@automatic', { token: preview.token })
      else { this.message = '自动检查完成，配置一致。'; this.publish() }
      this.backoff = 0
    } catch { this.backoff = Math.min(3600_000, this.backoff ? this.backoff * 2 : 60_000); this.nextCheck = Date.now() + this.backoff; this.changedAt = 0 }
  }
}
