import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePluginManifest } from '@webnav/shared'
import { PluginInteropRegistry, validateInteropDeclarations } from '../src/plugin-system/interop.ts'
import { platformFixture } from './plugin-platform-fixture.mjs'

const source = JSON.parse(await readFile('../examples/plugins/collaboration-source/webnav.plugin.json', 'utf8'))
const client = JSON.parse(await readFile('../examples/plugins/collaboration-client/webnav.plugin.json', 'utf8'))
test('required contracts are resolved before activation; version mismatch, ambiguity and cycles fail independently', () => {
  const required = structuredClone(client); required.interop.requires[0].optional = false
  assert.throws(() => validateInteropDeclarations([required]), { code: 'PLUGIN_DEPENDENCY' })
  validateInteropDeclarations([client]); validateInteropDeclarations([required, source])
  const incompatible = structuredClone(source); incompatible.interop.provides[0].version = 2
  assert.throws(() => validateInteropDeclarations([required, incompatible]), { code: 'PLUGIN_DEPENDENCY' })
  const unbound = structuredClone(required); delete unbound.interop.requires[0].provider
  assert.throws(() => validateInteropDeclarations([unbound, source, { ...source, id: 'example.second' }]), { code: 'PLUGIN_AMBIGUOUS' })
  const cyclicSource = structuredClone(source), cyclicClient = structuredClone(required)
  cyclicSource.interop.requires = [{ id: 'example.other', version: 1, optional: false }]
  cyclicClient.interop.provides = [{ id: 'example.other', version: 1, methods: [], events: [] }]
  assert.throws(() => validateInteropDeclarations([cyclicClient, cyclicSource]), { code: 'PLUGIN_DEPENDENCY' })
})
test('contributions and versioned contracts reject invalid paths, duplicate IDs and unbounded schemas', () => {
  assert.equal(parsePluginManifest(source).contributes.settings.entry, 'settings/main.js')
  for (const override of [
    { contributes: { tools: [{ id: 'main', title: 'Tool', placement: 'document.body' }] } },
    { contributes: { settings: { id: 'main', title: 'Settings', entry: '../escape.js' } } },
    { contributes: { fonts: [{ flag: 'table', name: 'Table', group: 'Main', defaultSize: 4, minSize: 8, maxSize: 24 }] } },
    { interop: { provides: [{ ...source.interop.provides[0], methods: [{ id: 'bad', access: 'read', inputSchema: { type: 'object', $ref: 'https://example.invalid' }, outputSchema: { type: 'object' } }] }] } },
  ]) assert.throws(() => parsePluginManifest({ ...source, ...override }))
})

test('independent Git packages register tools/settings/fonts, communicate, disable and uninstall while preserving local configuration', { timeout: 60000 }, async t => {
  const f = await platformFixture(); t.after(() => f.close())
  await f.install('client')
  assert.equal((await f.ctx.plugins.dispatch('owner', 'plugin.example.collaboration-client.state', {})).available, false)
  await assert.rejects(f.ctx.plugins.dispatch('owner', 'plugin.example.collaboration-client.add', { amount: 1, operationId: 'x' }), { code: 'CAPABILITY_UNAVAILABLE' })
  await f.install('source')
  const endpoint = 'plugin.example.collaboration-client.'
  const transport = f.ctx.transport
  assert.deepEqual(await f.ctx.plugins.dispatch('alice', endpoint + 'add', { amount: 2, operationId: 'once' }), { value: 2 })
  assert.deepEqual(await f.ctx.plugins.dispatch('alice', endpoint + 'add', { amount: 2, operationId: 'once' }), { value: 2 })
  assert.deepEqual(await f.ctx.plugins.dispatch('bob', endpoint + 'add', { amount: 2, operationId: 'once' }), { value: 4 })
  assert.equal((await f.ctx.plugins.dispatch('owner', endpoint + 'state', {})).value.value, 4)
  await assert.rejects(f.ctx.plugins.dispatch('owner', endpoint + 'add', { amount: 11, operationId: 'bad' }), { code: 'INVALID_PARAMS' })
  await f.change('source', 'configure', { config: { label: '保留的标题' } })
  await f.change('source', 'disable')
  assert.equal((await f.ctx.plugins.dispatch('owner', endpoint + 'state', {})).available, false)
  const settings = await f.ctx.plugins.dispatch('owner', 'plugins.settings', { id: source.id })
  assert.equal(settings.enabled, false); assert.equal(settings.running, false); assert.equal(settings.config.label, '保留的标题')
  assert.ok(settings.entry.endsWith('/settings/main.js'))
  const installed = f.ctx.plugins.manager.registry.installed.find(p => p.manifest.id === source.id)
  const origin = `http://127.0.0.1:${f.port}`, response = await fetch(origin), cookie = response.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(origin + settings.entry, { headers: { cookie } })).status, 200)
  await f.change('source', 'uninstall')
  assert.equal((await f.ctx.plugins.manager.state()).installed.some(p => p.manifest.id === source.id), false)
  assert.equal(f.ctx.plugins.assets().some(p => p.id === source.id), false)
  await access(join(f.ctx.plugins.manager.path(installed), 'backend.mjs'))
  await f.restart(); await f.install('source')
  assert.equal(f.ctx.plugins.manager.registry.installed.find(p => p.manifest.id === source.id).config.label, '保留的标题')
  await f.change('source', 'disable'); assert.ok(f.ctx.transport)
  // No actual hosts, collectors, shell sessions or user data were contacted.
  assert.ok(transport)
})

function scope() { let disposed = false; const cleanup = []; return { resources: 0, draining: false, requireActive() { if (disposed) throw Error('disposed') }, acquire(write = false) { this.requireActive(); if (write && this.draining) throw Error('draining'); this.resources++; let released = false; return () => { if (!released) { released = true; this.resources-- } } }, onDispose(fn) { cleanup.push(fn) }, dispose() { disposed = true; for (const fn of cleanup) fn() } } }
test('interop keeps leases until actual completion, propagates identity and cancellation, coalesces state and cleans subscriptions', async () => {
  const registry = new PluginInteropRegistry(), provider = registry.create(parsePluginManifest(source), scope()), consumer = registry.create(parsePluginManifest(client), scope())
  const producer = registry.api(provider), api = registry.api(consumer), states = []; let finish, context
  producer.register('example.counter', 1, { read: () => ({ value: 0 }), add: (_input, call) => { context = call; return new Promise(resolve => { finish = resolve }) } }, { state: { value: 0 } })
  api.subscribe('example.counter', 1, 'state', value => states.push(value))
  registry.validate(new Set(), [provider, consumer]); registry.commit(new Set(), [provider, consumer]); await Promise.resolve()
  assert.equal(states.length, 1)
  producer.publish('example.counter', 1, 'state', { value: 1 }); producer.publish('example.counter', 1, 'state', { value: 2 }); await Promise.resolve()
  assert.equal(states.length, 2); assert.equal(states[1].revision, 2); assert.equal(states[1].value.value, 2)
  await assert.rejects(registry.run('page-owner', () => api.call('example.counter', 1, 'add', { amount: 1, operationId: 'id' }, { timeoutMs: 10 })), { code: 'TIMEOUT' })
  assert.equal(context.owner, 'page-owner'); assert.equal(context.caller, client.id); assert.equal(context.signal.aborted, true)
  assert.equal(provider.scope.resources, 1); assert.equal(consumer.scope.resources, 1)
  finish({ value: 1 }); await new Promise(resolve => setImmediate(resolve)); assert.equal(provider.scope.resources, 0)
  consumer.scope.dispose(); producer.publish('example.counter', 1, 'state', { value: 3 }); await Promise.resolve(); assert.equal(states.length, 2)
  registry.commit(new Set([source.id]), []); provider.scope.dispose()
})
