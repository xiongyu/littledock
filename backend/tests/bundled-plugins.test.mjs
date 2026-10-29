import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PluginManager } from '../src/plugin-system/manager.ts'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'webnav-bundled-test-')), bundles = join(root, 'bundles'), source = join(bundles, 'counter'), data = join(root, 'data')
  await mkdir(bundles); await cp(resolve('../examples/plugins/collaboration-source'), source, { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'webnav.plugin.json'), 'utf8'))
  const managers = []
  async function start(safe = false) { const manager = new PluginManager(data, undefined, safe, bundles); managers.push(manager); await manager.initialize(); return manager }
  t.after(async () => { for (const manager of managers) await manager.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }) })
  const change = (manager, action, extra = {}) => manager.change({ id: manifest.id, action, expectedRevision: manager.registry.revision, ...extra })
  return { root, bundles, source, manifest, start, change }
}

test('bundled plugins auto-install from host files, preserve disable/config on upgrade and stay removed across restart', async t => {
  const f = await setup(t); let manager = await f.start()
  const initial = manager.registry.installed[0]
  assert.equal(initial.source, 'bundled'); assert.equal(initial.enabled, true); assert.match(initial.commit, /^[a-f0-9]{64}$/)
  assert.equal((await manager.state()).bundled[0].manifest.id, f.manifest.id)
  await f.change(manager, 'configure', { config: { label: '保留的配置' } }); await f.change(manager, 'disable'); await manager.close()
  await writeFile(join(f.source, 'upgrade-note.txt'), 'host release changed')
  manager = await f.start()
  assert.equal(manager.registry.installed[0].enabled, false); assert.equal(manager.registry.installed[0].config.label, '保留的配置')
  assert.notEqual(manager.registry.installed[0].commit, initial.commit); assert.equal(manager.registry.installed[0].previousCommit, initial.commit)
  const cached = manager.path(manager.registry.installed[0]); await f.change(manager, 'uninstall'); await manager.close()
  manager = await f.start(); assert.equal(manager.registry.installed.length, 0); await access(join(cached, 'webnav.plugin.json'))
  await f.change(manager, 'restore-bundled')
  assert.equal(manager.registry.installed[0].enabled, true); assert.equal(manager.registry.installed[0].config.label, '保留的配置')
  assert.equal(manager.registry.retained.length, 0)
})

test('bundled discovery isolates malformed packages, rejects install scripts and validates immutable cached contents', async t => {
  const f = await setup(t)
  await mkdir(join(f.bundles, 'broken')); await writeFile(join(f.bundles, 'broken/webnav.plugin.json'), '{invalid')
  const manager = await f.start(); assert.equal(manager.registry.installed.length, 1); assert.equal(manager.bundledErrors.length, 1)
  const cached = manager.path(manager.registry.installed[0]); await manager.close()
  await writeFile(join(cached, 'README.md'), 'changed cached content')
  const restored = await f.start(); assert.ok(restored.bundledErrors.some(message => message.includes('校验失败')))
  assert.equal(restored.invalidBundledReleases.size, 1)
  const malicious = { ...f.manifest, id: 'example.install-script', install: [{ command: 'node', args: ['untrusted.mjs'] }] }
  await mkdir(join(f.bundles, 'install')); await writeFile(join(f.bundles, 'install/webnav.plugin.json'), JSON.stringify(malicious))
  const checked = await f.start(true); assert.ok(checked.bundledErrors.some(message => message.includes('安装脚本')))
  assert.equal(checked.registry.installed.some(p => p.manifest.id === malicious.id), false)
})
