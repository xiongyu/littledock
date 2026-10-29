import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { OptimizerEngine } from '../../plugins/system-optimizer/src/engine.ts'
import { equivalent, parseSnapshot } from '../../plugins/system-optimizer/src/model.ts'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-optimizer-test-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const target = { hive: 'CurrentUser', view: 'Registry64', path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'Fixture Startup' }
  const original = { exists: true, type: 'ExpandString', data: '%TEMP%\\fixture.exe --private fixture-secret' }
  const values = new Map([[target.name, original], ['Second', { exists: true, type: 'DWord', data: 1 }]])
  let writes = 0, active = 0, unlocked = true, protectCount = 0, decryptions = 0, protectFailure = 0, afterApply
  const key = randomBytes(32)
  const adapter = {
    async snapshot() { return { identity: 'fixture-machine-user', computer: '模拟电脑', user: 'fixture', build: 26200, scannedAt: Date.now(), coverage: ['fixture'], warnings: [], items: [...values].map(([name, before], index) => ({ id: String(index), name, category: index === 0 ? 'startup' : 'settings', source: 'fixture', state: 'registered', writable: true, note: 'fixture', target: { ...target, name }, before: structuredClone(before), desired: index === 0 ? { exists: false } : { exists: true, type: 'DWord', data: 0 }, details: 'private details' })) } },
    async read(t) { return structuredClone(values.get(t.name) ?? { exists: false }) },
    async apply(t, expected, desired) { const current = await this.read(t); if (!equivalent(current, expected)) return { status: 'conflict', current }; writes++; values.set(t.name, structuredClone(desired)); afterApply?.(); return { status: 'applied', current: desired } },
    async protect(value) { protectCount++; if (protectCount === protectFailure) throw new Error('fixture disk failure'); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64') },
    async unprotect(value) { decryptions++; const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8') },
    async openSettings() {}, async close() {},
  }
  const create = async () => { const engine = new OptimizerEngine(adapter, directory, () => { active++; let released = false; return () => { if (!released) { active--; released = true } } }, () => unlocked); await engine.initialize(); return engine }
  return { directory, adapter, values, target, original, create, engine: await create(), get writes() { return writes }, get active() { return active }, get decryptions() { return decryptions }, set unlocked(value) { unlocked = value }, set protectFailure(value) { protectFailure = value }, set afterApply(value) { afterApply = value } }
}
test('optimizer scan is read-only, strips private command data, previews explicitly and rejects foreign or stale selections', async t => {
  const f = await fixture(t), scan = await f.engine.scan()
  assert.equal(f.writes, 0); assert.ok(!JSON.stringify(scan).includes('fixture-secret')); assert.ok(!('target' in scan.items[0]))
  await assert.rejects(f.engine.preview('owner', ['0','0']))
  const plan = await f.engine.preview('owner', ['0']); assert.equal(f.writes, 0)
  await assert.rejects(f.engine.apply('another-owner', plan.id, randomUUID()), /预览/)
  f.values.set(f.target.name, { exists: true, type: 'String', data: 'changed' })
  await assert.rejects(f.engine.preview('owner', ['0']), /变化/)
  const result = await f.engine.apply('owner', plan.id, randomUUID()); assert.equal(result.items[0].status, 'conflict'); assert.equal(f.writes, 0)
})
test('optimizer journals before write, persists deduplication across restart and restores exact registry type/value', async t => {
  const f = await fixture(t); await f.engine.scan(); const plan = await f.engine.preview('owner', ['0']), operation = randomUUID()
  const result = await f.engine.apply('owner', plan.id, operation)
  assert.equal(result.status, 'complete'); assert.equal(f.writes, 1); assert.equal(f.active, 0)
  const files = await readdir(f.directory); assert.equal(files.length, 1)
  assert.ok(!(await readFile(join(f.directory, files[0]), 'utf8')).includes('fixture-secret'))
  await f.engine.apply('owner', plan.id, operation); assert.equal(f.writes, 1)
  const restarted = await f.create(); assert.equal(f.decryptions, 0, 'Activation does not decrypt the entire history')
  await restarted.apply('owner', plan.id, operation); assert.equal(f.writes, 1)
  const restore = await restarted.restorePreview('owner', result.id)
  await restarted.apply('owner', restore.id, randomUUID()); assert.deepEqual(f.values.get(f.target.name), f.original)
  await assert.rejects(restarted.restorePreview('owner', result.id), /没有需要恢复/)
})
test('optimizer stops on lock and never overwrites changes made outside its own operation', async t => {
  const f = await fixture(t); await f.engine.scan(); const plan = await f.engine.preview('owner', ['0','1'])
  f.afterApply = () => { f.unlocked = false }
  const result = await f.engine.apply('owner', plan.id, randomUUID())
  assert.equal(result.status, 'partial'); assert.equal(f.writes, 1); assert.equal(result.items[1].status, 'pending')
  f.unlocked = true; f.values.set(f.target.name, { exists: true, type: 'String', data: 'independent change' })
  await assert.rejects(f.engine.restorePreview('owner', result.id), /其他操作修改/)
})
test('failed backup prevents mutation; lost result remains unknown and is not replayed after restart', async t => {
  const f = await fixture(t); await f.engine.scan(); const plan = await f.engine.preview('owner', ['0'])
  f.protectFailure = 1; await assert.rejects(f.engine.apply('owner', plan.id, randomUUID())); assert.equal(f.writes, 0)
  f.protectFailure = 3; const operation = randomUUID()
  await assert.rejects(f.engine.apply('owner', plan.id, operation), /保存执行结果失败/); assert.equal(f.writes, 1)
  const restarted = await f.create(), result = await restarted.apply('owner', plan.id, operation)
  assert.equal(result.status, 'unknown'); assert.equal(f.writes, 1)
  const restore = await restarted.restorePreview('owner', result.id); assert.equal(restore.items.length, 1)
})
test('native snapshot contract rejects malformed and duplicate entries instead of rendering misleading data', async t => {
  const f = await fixture(t), value = await f.adapter.snapshot(); assert.equal(parseSnapshot(value).items.length, 2)
  assert.throws(() => parseSnapshot({ ...value, items: [{ ...value.items[0], name: ['not','a','name'] }] }))
  assert.throws(() => parseSnapshot({ ...value, items: [value.items[0], value.items[0]] }))
})
