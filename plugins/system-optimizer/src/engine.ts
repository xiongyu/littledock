import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Change, OperationRecord, Plan, RegistryValue, SystemSnapshot, WindowsAdapter } from './model.ts'
import { equivalent, publicSnapshot, registryTarget, registryValue } from './model.ts'

/** One scan/write at a time; plans freeze exact original values and do not contain executable text. */
export class OptimizerEngine {
  private snapshot?: SystemSnapshot
  private plans = new Map<string, Plan>()
  private busy = false
  private records = new Map<string, OperationRecord>()
  private recordIds = new Set<string>()
  private closed = false
  private adapter: WindowsAdapter
  private directory: string
  private lease: () => (() => void) | Promise<() => void>
  private unlocked: () => boolean | Promise<boolean>
  constructor(adapter: WindowsAdapter, directory: string, lease: () => (() => void) | Promise<() => void>, unlocked: () => boolean | Promise<boolean>) { this.adapter = adapter; this.directory = directory; this.lease = lease; this.unlocked = unlocked }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const files = (await readdir(this.directory)).filter(name => /^[a-f0-9-]{36}\.protected$/.test(name))
    if (files.length > 1000) throw new Error('恢复记录已达上限，请先整理记录。')
    this.recordIds = new Set(files.map(file => file.replace('.protected', '')))
  }
  private async record(id: string) {
      if (this.records.has(id)) return this.records.get(id)!
      if (!this.recordIds.has(id)) throw new Error('恢复记录不存在。')
      const file = id + '.protected', path = join(this.directory, file)
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('恢复记录大小异常。')
      const encoded = await readFile(path, 'utf8')
      const record = JSON.parse(await this.adapter.unprotect(encoded)) as OperationRecord
      if (record.id + '.protected' !== file || record.operationId !== id || typeof record.request !== 'string' || !/^[a-f0-9]{64}$/.test(record.request) || typeof record.owner !== 'string' || typeof record.identity !== 'string' || !Number.isSafeInteger(record.createdAt) || !['running','complete','partial','unknown'].includes(record.status) || !Array.isArray(record.items) || record.items.length > 50) throw new Error('恢复记录格式异常，请保留原文件。')
      for (const item of record.items) {
        if (typeof item.name !== 'string' || item.name.length > 1000 || !['pending','applied','conflict','failed','unknown'].includes(item.status)) throw new Error('恢复项目格式异常。')
        item.target = registryTarget(item.target); item.before = registryValue(item.before); item.after = registryValue(item.after)
      }
      if (record.status === 'running') { record.status = 'unknown'; for (const item of record.items) if (item.status === 'pending') item.status = 'unknown' }
      this.records.set(record.id, record)
      if (this.records.size > 40) this.records.delete(this.records.keys().next().value!)
      return record
  }
  private async available() { if (this.closed || !await this.unlocked()) throw new Error('工作台已锁定或插件已停止。'); if (this.busy) throw new Error('系统优化任务仍在处理中。') }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.closed || this.busy) throw new Error('系统优化任务仍在处理中或插件已停止。')
    this.busy = true
    let release: (() => void) | undefined
    try { release = await this.lease(); if (this.closed || !await this.unlocked()) throw new Error('工作台已锁定或插件已停止。'); return await action() } finally { this.busy = false; release?.() }
  }
  async scan() { return this.exclusive(async () => { this.snapshot = await this.adapter.snapshot(); return publicSnapshot(this.snapshot) }) }
  async details(id: string) { await this.available(); const item = this.snapshot?.items.find(item => item.id === id); if (!item) throw new Error('条目已过期，请重新扫描。'); return { name: item.name, details: item.details ?? item.note } }
  async preview(owner: string, ids: string[]) {
    return this.exclusive(async () => {
      if (!this.snapshot || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error('请选择 1–50 个不同项目。')
      const changes: Change[] = []
      for (const id of ids) {
        const item = this.snapshot.items.find(item => item.id === id)
        if (!item?.writable || !item.target || !item.before || !item.desired) throw new Error('所选项目不支持修改。')
        const current = await this.adapter.read(item.target)
        if (!equivalent(current, item.before)) throw new Error(`${item.name} 已变化，请重新扫描。`)
        changes.push({ itemId: id, name: item.name, target: item.target, before: current, after: item.desired, note: item.category === 'startup' ? '停用当前用户的 Run 登记；原始内容加密保存，恢复时不会覆盖其他修改。' : item.note })
      }
      return this.plan(owner, this.snapshot.identity, changes)
    })
  }
  private plan(owner: string, identity: string, changes: Change[], restorationOf?: string) {
    for (const [id, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(id)
    if (this.plans.size >= 32) throw new Error('待确认预览过多，请稍后重试。')
    const plan: Plan = { id: randomUUID(), owner, identity, expiresAt: Date.now() + 300000, changes, ...(restorationOf ? { restorationOf } : {}) }
    this.plans.set(plan.id, plan)
    const describe = (value: RegistryValue) => !value.exists ? '不存在' : typeof value.data === 'number' ? String(value.data) : '已登记（内容已保存）'
    return { id: plan.id, expiresAt: plan.expiresAt, restoring: !!restorationOf, items: changes.map(item => ({ name: item.name, before: describe(item.before), after: describe(item.after), note: item.note })), reversible: true }
  }
  async restorePreview(owner: string, id: string) {
    return this.exclusive(async () => {
      const record = await this.record(id)
      const current = await this.adapter.snapshot()
      if (current.identity !== record.identity) throw new Error('恢复记录属于其他机器或用户。')
      const changes: Change[] = []
      for (const item of record.items) if (item.status === 'applied' || item.status === 'unknown') {
        const value = await this.adapter.read(item.target)
        if (equivalent(value, item.before)) continue
        if (!equivalent(value, item.after)) throw new Error(`${item.name} 已被其他操作修改，不能覆盖恢复。`)
        changes.push({ ...item, before: item.after, after: item.before, note: '恢复到本次修改前的精确值；重新登录后核对效果。' })
      }
      if (!changes.length) throw new Error('没有需要恢复的项目，原值已保持或恢复。')
      return this.plan(owner, record.identity, changes, id)
    })
  }
  async apply(owner: string, planId: string, operationId: string) {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('操作标识无效。')
    const request = createHash('sha256').update(owner + '/' + planId).digest('hex')
    const previous = this.recordIds.has(operationId) ? await this.record(operationId) : undefined
    if (previous) { if (previous.request !== request) throw new Error('操作标识已用于其他请求。'); return this.summary(previous) }
    return this.exclusive(async () => {
      const plan = this.plans.get(planId)
      if (!plan || plan.owner !== owner || plan.expiresAt < Date.now()) throw new Error('预览已过期或不属于当前页面。')
      if (this.recordIds.size >= 1000) throw new Error('恢复记录已达 1,000 次上限，请先整理备份。')
      const current = await this.adapter.snapshot()
      if (current.identity !== plan.identity) throw new Error('目标机器或用户发生变化。')
      const record: OperationRecord = { id: operationId, operationId, request, owner, identity: plan.identity, createdAt: Date.now(), status: 'running', items: plan.changes.map(item => ({ ...item, status: 'pending' })), ...(plan.restorationOf ? { restorationOf: plan.restorationOf } : {}) }
      // Save encrypted recovery material before any registry mutation.
      await this.persist(record); this.records.set(record.id, record); this.recordIds.add(record.id); this.plans.delete(planId)
      if (this.records.size > 40) this.records.delete(this.records.keys().next().value!)
      for (const item of record.items) {
        if (!await this.unlocked()) break
        try { const result = await this.adapter.apply(item.target, item.before, item.after); item.status = result.status; if (result.status === 'applied' && !equivalent(result.current, item.after)) item.status = 'unknown' }
        catch { item.status = 'unknown'; item.message = '执行结果待核对，不会自动重试。' }
        try { await this.persist(record) } catch { record.status = 'unknown'; throw new Error('保存执行结果失败，请保留备份并重新核对。') }
        if (item.status !== 'applied') break
      }
      record.status = record.items.every(item => item.status === 'applied') ? 'complete' : 'partial'
      await this.persist(record); return this.summary(record)
    })
  }
  private async persist(record: OperationRecord) {
    const text = JSON.stringify(record); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('恢复材料过大，已停止本次操作。')
    const encoded = await this.adapter.protect(text), path = join(this.directory, record.id + '.protected'), temporary = path + '.tmp'
    const bytes = (await Promise.all([...this.recordIds].filter(id => id !== record.id).map(async id => (await stat(join(this.directory, id + '.protected'))).size))).reduce((sum, size) => sum + size, 0)
    if (bytes + Buffer.byteLength(encoded) + 4096 > 100 * 1024 * 1024) throw new Error('恢复材料达到 100 MiB 上限，请先整理备份。')
    await writeFile(temporary, encoded, { mode: 0o600, flush: true }); await rename(temporary, path)
  }
  private summary(record: OperationRecord) { return { id: record.id, at: record.createdAt, status: record.status, restoring: !!record.restorationOf, items: record.items.map(item => ({ name: item.name, status: item.status, message: item.message })) } }
  async history(page = 0) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 49) throw new Error('页码无效。')
    const files = await Promise.all([...this.recordIds].map(async id => ({ id, modified: (await stat(join(this.directory, id + '.protected'))).mtimeMs })))
    const result = []
    for (const file of files.sort((a, b) => b.modified - a.modified).slice(page * 20, page * 20 + 20)) result.push(this.summary(await this.record(file.id)))
    return { total: files.length, page, items: result }
  }
  get active() { return this.busy }
  async close() { this.closed = true; this.plans.clear(); this.snapshot = undefined; await this.adapter.close() }
}
