import * as i18n from '../src/i18n.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { parsePluginContributions, parsePluginMenuContext } from '@webnav/shared'
const require = createRequire(import.meta.url), ts = require('typescript')
function load(file) {
  const exports = {}
  runInNewContext(ts.transpileModule(readFileSync('src/' + file + '.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => name === './i18n.ts' ? i18n : require(name), structuredClone, AbortController, setTimeout, clearTimeout })
  return exports
}
const { PluginMenuRegistry } = load('plugin-menus'), { PluginUiRegistry } = load('plugin-ui')
const point = (id = 'item', extra = {}) => ({ id, title: '项目', description: '所选项目的公开扩展位置', version: 1, fields: { pid: { type: 'number', required: true, description: '进程 ID' }, startedAt: { type: 'number', required: true, description: '创建时间' } }, ...extra })
const item = (id = 'inspect', extra = {}) => ({ id, title: '诊断', target: { plugin: 'example.owner', point: 'item', version: 1 }, access: 'read', ...extra })
const declaration = c => parsePluginContributions(c, value => value)
function fixture(extra = {}) {
  let available = true, identity = { pid: 42, startedAt: 100 }, current = true
  const notices = [], registry = new PluginMenuRegistry(() => available, value => notices.push(value))
  const owner = registry.createScope('example.owner', '拥有者', declaration({ menuPoints: [point('item', extra)] }))
  owner.registerPoint('item'); owner.seal()
  const binding = { plugin: owner.plugin, point: 'item', context: () => identity, isCurrent: () => current }
  return { registry, owner, notices, binding, identity(value) { identity = value }, current(value) { current = value }, available(value) { available = value }, contributor(handler, definition = item(), id = 'example.addon') { const scope = registry.createScope(id, '扩展来源', declaration({ menuItems: [definition] })); scope.registerItem(definition.id, handler); scope.seal(); return scope } }
}
test('declarations default public; require explanations, bounded flat contexts and valid visibility', () => {
  const parsed = declaration({ menuPoints: [point()] }).menuPoints[0]
  assert.equal(parsed.public, true)
  assert.throws(() => declaration({ menuPoints: [point('item', { description: '' })] }))
  assert.throws(() => declaration({ menuPoints: [point('item', { public: 'false' })] }))
  assert.throws(() => declaration({ menuPoints: [point()], uiPoints: [{ ...point(), kind: 'tabs' }] }))
  assert.throws(() => declaration({ uiPoints: [{ ...point(), kind: 'dom' }] }))
  assert.throws(() => declaration({ menuItems: Array.from({ length: 65 }, (_, i) => item('item-' + i)) }))
  for (const context of [{ pid: 42 }, { pid: '42', startedAt: 1 }, { pid: 42, startedAt: 1, password: 'secret' }, { pid: Infinity, startedAt: 1 }]) assert.throws(() => parsePluginMenuContext(parsed, context))
  const context = parsePluginMenuContext(parsed, { pid: 42, startedAt: 1 }); assert.ok(Object.isFrozen(context))
})
test('registration is staged and sealed, undeclared and duplicate registrations fail', () => {
  const f = fixture(); assert.throws(() => f.registry.session(f.binding)); assert.throws(() => f.owner.registerPoint('item'))
  const broken = f.registry.createScope('example.broken', '失败插件', declaration({ menuItems: [item()] }))
  assert.throws(() => broken.registerItem('missing', { run() {} })); assert.throws(() => broken.seal()); assert.throws(() => f.registry.publish([broken]))
  broken.registerItem('inspect', { run() {} }); assert.throws(() => broken.registerItem('inspect', { run() {} }))
  f.registry.publish([f.owner]); assert.equal(f.registry.session(f.binding).valid(), true)
})
test('native and external menus share validation, current disabled checks, source labels and failure isolation', async () => {
  const f = fixture(); let count = 0, enabled = true, localDisabled = false
  const good = f.contributor({ enabled: () => enabled, run: context => { assert.ok(Object.isFrozen(context)); count++ } })
  const bad = f.contributor({ when() { throw Error('bad predicate') }, run() { throw Error('unreachable') } }, item(), 'example.bad')
  f.registry.publish([f.owner, good, bad]); const session = f.registry.session(f.binding)
  const local = () => [{ id: 'copy', label: '复制', disabled: localDisabled }]
  const items = session.items(local, () => count++)
  assert.equal(items.length, 2); assert.equal(items[1].source, '扩展来源')
  localDisabled = true; await session.execute(items[0].id); enabled = false; await session.execute(items[1].id); assert.equal(count, 0)
  enabled = true; await session.execute(items[1].id); assert.equal(count, 1)
  f.identity({ pid: 42, startedAt: 200 }); await session.execute(items[1].id); assert.equal(count, 1)
})
test('private point refuses foreign menus while own local content remains; versions must match', () => {
  const f = fixture({ public: false }), other = f.contributor({ run() {} })
  f.registry.publish([f.owner, other]); assert.equal(f.registry.session(f.binding).items(() => [{ id: 'copy', label: '复制' }], () => {}).length, 1)
  const g = fixture(), incompatible = g.contributor({ run() {} }, item('inspect', { target: { plugin: 'example.owner', point: 'item', version: 2 } }))
  g.registry.publish([g.owner, incompatible]); assert.equal(g.registry.session(g.binding).items(() => [], () => {}).length, 0)
})
test('old menu receipts cannot call replaced plugins; failed unpublished candidates preserve old actions', async () => {
  const f = fixture(); let oldCalls = 0, newCalls = 0
  const old = f.contributor({ run: () => oldCalls++ }); f.registry.publish([f.owner, old])
  const session = f.registry.session(f.binding), id = session.items(() => [], () => {})[0].id
  f.registry.createScope('example.addon', '未完成候选'); await session.execute(id); assert.equal(oldCalls, 1)
  const next = f.contributor({ run: () => newCalls++ }); f.registry.publish([f.owner, next]); await session.execute(id)
  assert.equal(newCalls, 0); session.items(() => [], () => {}); await session.execute(id); assert.equal(newCalls, 1)
  f.registry.publish([next]); assert.equal(session.valid(), false)
})
test('pending actions are deduplicated, aborted on owner removal/lock, and disposal waits actual completion', async () => {
  const f = fixture(); let signal, complete, calls = 0
  const addon = f.contributor({ run(_, invocation) { calls++; signal = invocation.signal; return new Promise(resolve => complete = resolve) } })
  f.registry.publish([f.owner, addon]); const session = f.registry.session(f.binding), id = session.items(() => [], () => {})[0].id
  const first = session.execute(id); await session.execute(id); assert.equal(calls, 1)
  f.registry.publish([addon]); assert.equal(signal.aborted, true)
  let disposed = false; const cleanup = addon.dispose().then(() => disposed = true); await Promise.resolve(); assert.equal(disposed, false)
  complete(); await first; await cleanup; assert.equal(disposed, true)
  const g = fixture(); const second = g.contributor({ async run(_, { signal }) { await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }) }) } })
  g.registry.publish([g.owner, second]); const s = g.registry.session(g.binding), key = s.items(() => [], () => {})[0].id, operation = s.execute(key)
  g.available(false); g.registry.cancelPending(); await operation; assert.equal(s.valid(), false)
})
test('runtime handler failure reports once without exposing thrown content', async () => {
  const f = fixture(), addon = f.contributor({ run() { throw Error('secret body') } }); f.registry.publish([f.owner, addon])
  const s = f.registry.session(f.binding); await s.execute(s.items(() => [], () => {})[0].id)
  assert.equal(f.notices.length, 1); assert.doesNotMatch(f.notices[0], /secret/)
})
function uiFixture(isPublic = true) {
  const registry = new PluginUiRegistry(), owner = registry.createScope('example.owner', '拥有者', declaration({ uiPoints: [point('item', { kind: 'tabs', public: isPublic })] }))
  owner.registerPoint('item'); owner.seal()
  const addon = registry.createScope('example.addon', '扩展', declaration({ uiItems: [item()] })); addon.registerItem('inspect', { component: { render() {} } }); addon.seal()
  registry.publish([owner, addon]); return { registry, owner, addon }
}
test('public instance lookup returns metadata; own contribution activation tracks exact instance and context', () => {
  const f = uiFixture(); let selected = '', context = { pid: 42, startedAt: 100 }
  assert.equal(f.registry.listPoints()[0].description, '所选项目的公开扩展位置'); assert.equal(f.registry.find().length, 0)
  const instance = f.registry.mount('example.owner', 'item', () => context, () => true, id => selected = id)
  assert.equal(f.registry.find({ kind: 'tabs' })[0].id, instance.id); assert.equal(instance.items().length, 1)
  assert.equal(f.registry.activate(f.addon, instance.id, 'inspect'), true); assert.equal(selected, 'example.addon/inspect')
  assert.equal(f.registry.activate(f.owner, instance.id, 'inspect'), false)
  const descriptor = f.registry.find()[0]; descriptor.fields.pid.description = 'changed'; assert.equal(f.registry.find()[0].fields.pid.description, '进程 ID')
  context = { pid: 42, startedAt: 200 }; assert.equal(f.registry.find().length, 0); assert.equal(f.registry.activate(f.addon, instance.id, 'inspect'), false)
  instance.dispose(); instance.dispose(); assert.equal(instance.valid(), false)
})
test('private controls are absent from discovery and refuse even guessed foreign handles', () => {
  const f = uiFixture(false), instance = f.registry.mount('example.owner', 'item', () => ({ pid: 1, startedAt: 2 }), () => true, () => { throw Error('must not activate') })
  assert.equal(instance.valid(), true); assert.equal(f.registry.listPoints().length, 0); assert.equal(f.registry.find().length, 0); assert.equal(instance.items().length, 0)
  assert.equal(f.registry.activate(f.addon, instance.id, 'inspect'), false); instance.dispose()
})
test('contribution and owner unload invalidate content, instance IDs never reused', () => {
  const f = uiFixture(), instance = f.registry.mount('example.owner', 'item', () => ({ pid: 1, startedAt: 2 }), () => true, () => {})
  f.registry.publish([f.owner]); assert.equal(instance.items().length, 0); assert.equal(f.registry.activate(f.addon, instance.id, 'inspect'), false)
  f.registry.publish([]); assert.equal(instance.valid(), false); assert.equal(f.registry.find().length, 0)
  f.registry.publish([f.owner, f.addon]); const next = f.registry.mount('example.owner', 'item', () => ({ pid: 1, startedAt: 2 }), () => true, () => {})
  assert.notEqual(next.id, instance.id); instance.dispose(); next.dispose()
})
