import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { builtinUiManifest, mergeBuiltinUiAssets } from '../src/builtin-ui-assets.ts'

const manifest = id => JSON.parse(readFileSync(`../backend/plugins/${id}/webnav.plugin.json`, 'utf8'))
const builtin = value => ({ id: value.id, name: value.name, manifest: value, iconDataUrl: 'test-icon' })
const asset = value => ({ id: value.id, name: value.name, commit: 'running-version', capabilities: value.capabilities, contributes: value.contributes, builtin: true, styles: [], config: { unchanged: true } })

test('new frontend declarations work with cached older built-ins, including a previously absent UI asset', () => {
  const sessions = manifest('builtin.sessions'), editor = manifest('builtin.remoteEditor')
  const bundled = new Map([sessions, editor].map(value => [value.id, builtinUiManifest(value)]))
  delete editor.contributes
  const workspace = sessions.contributes.menuPoints.find(point => point.id === 'workspace')
  delete workspace.fields.ready; delete workspace.fields.name; delete workspace.fields.ai
  const running = asset(sessions), before = JSON.stringify([sessions, editor, running])
  const result = mergeBuiltinUiAssets([running], [builtin(sessions), builtin(editor)], bundled, () => true)
  assert.equal(result.length, 2)
  assert.ok(result[0].contributes.menuPoints.find(point => point.id === 'workspace').fields.ready)
  assert.equal(result[0].commit, 'running-version')
  assert.equal(result[0].capabilities, running.capabilities)
  assert.equal(result[0].config, running.config)
  assert.equal(result[1].id, editor.id)
  assert.equal(result[1].contributes.menuItems.length, 2)
  assert.equal(JSON.stringify([sessions, editor, running]), before, 'does not alter backend state or imply a backend upgrade')
})

test('frontend declarations do not invent installed plugins or upgrade a backend API/capability contract', () => {
  const current = manifest('builtin.sessions'), ui = builtinUiManifest(current), running = asset(current)
  const bundled = new Map([[ui.id, ui]])
  assert.deepEqual(mergeBuiltinUiAssets([], [], bundled, () => true), [])
  assert.equal(mergeBuiltinUiAssets([running], [builtin(current)], bundled, () => false)[0], running)
  for (const incompatible of [
    { ...ui, apiVersion: 2 },
    { ...ui, capabilities: [{ ...ui.capabilities[0], version: 2 }] },
    { ...ui, capabilities: [...ui.capabilities, { id: 'service:missing', version: 1 }] },
  ]) {
    const catalog = new Map([[ui.id, incompatible]])
    assert.equal(mergeBuiltinUiAssets([running], [builtin(current)], catalog, () => true)[0], running)
    assert.deepEqual(mergeBuiltinUiAssets([], [builtin(current)], catalog, () => true), [])
  }
})

test('external releases and their config, URLs and declarations remain server-owned', () => {
  const current = manifest('builtin.sessions'), bundled = new Map([[current.id, builtinUiManifest(current)]])
  const external = { ...asset(current), builtin: false, entry: '/plugins/test/revision/ui.js' }
  assert.equal(mergeBuiltinUiAssets([external], [builtin(current)], bundled, () => true)[0], external)
})

test('bundled descriptors validate the real static manifests and retain only frontend registration metadata', () => {
  for (const entry of readdirSync('../backend/plugins', { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const ui = builtinUiManifest(manifest(entry.name))
    assert.deepEqual(Object.keys(ui).sort(), ['apiVersion', 'capabilities', 'contributes', 'id'])
  }
  const current = manifest('builtin.sessions')
  assert.throws(() => builtinUiManifest({ ...current, id: 'example.not-builtin' }))
  assert.throws(() => builtinUiManifest({ ...current, contributes: { menuPoints: [{ id: 'bad' }] } }))
})
