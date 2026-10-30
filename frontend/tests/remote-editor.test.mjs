import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { pluginI18n } from '../src/i18n.ts'
import { parsePluginContributions, parsePluginMenuContext } from '@webnav/shared'
const require = createRequire(import.meta.url), ts = require('typescript')
function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  runInNewContext(ts.transpileModule(readFileSync('src/' + file + '.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: id => dependencies[id] ?? require(id), ...globals })
  return exports
}
function fixture() {
  const tabs = [], window = { open(url) { const tab = { url, closed: false, close() { tab.closed = true } }; tabs.push(tab); return tab } }
  return { api: load('remote-editor', {}, { window }), tabs, window }
}

test('checking or replacing an editor request never opens a placeholder tab', () => {
  const { api, tabs } = fixture()
  api.openRemoteEditor('alpha', '', 'Alpha', true)
  api.openRemoteEditor('beta', '', 'Beta', true)
  assert.equal(api.remoteEditorRequest.value.sessionId, 'beta')
  api.closeRemoteEditor()
  assert.equal(api.remoteEditorRequest.value, undefined)
  api.openRemoteEditor('alpha', '/files', 'Alpha')
  assert.equal(tabs.length, 0, 'neither terminal nor file-panel requests create an empty tab')
})

test('ready editors open their URL directly without an opener; blocked tabs report failure without replay', () => {
  const { api, tabs, window } = fixture()
  const url = 'http://127.0.0.1:3000/?folder=/project'
  assert.equal(api.openRemoteEditorTab(url), true)
  assert.equal(tabs[0].url, url)
  assert.equal(tabs[0].opener, null)
  api.closeRemoteEditor()
  assert.equal(tabs[0].closed, false, 'closing the panel does not close an already opened editor')
  window.open = () => null
  assert.equal(api.openRemoteEditorTab(url), false)
  assert.equal(tabs.length, 1)
})

test('plugin menus bind the selected ordinary SSH and reject local, AI, disconnected and legacy contexts', () => {
  const { api } = fixture(), handlers = new Map(), cleanups = []
  load('builtin-plugins/remote-editor/index', {
    '../../remote-editor': api,
    '../../plugin-builtins': { registerBuiltinFrontend(id, activate) { assert.equal(id, 'builtin.remoteEditor'); activate({ i18n: pluginI18n('builtin.remoteEditor'), menus: { registerItem: (id, handler) => handlers.set(id, handler) }, onDispose: cleanup => cleanups.push(cleanup) }) } },
  })
  const owner = parsePluginContributions(JSON.parse(readFileSync('../backend/plugins/builtin.sessions/webnav.plugin.json')).contributes, value => value)
  const menus = parsePluginContributions(JSON.parse(readFileSync('../backend/plugins/builtin.remoteEditor/webnav.plugin.json')).contributes, value => value)
  for (const item of menus.menuItems) {
    const handler = handlers.get(item.id), point = owner.menuPoints.find(p => p.id === item.target.point)
    const base = { sessionId: 'selected-ssh', ready: true, protocol: 'ssh', name: 'Selected SSH', ...(point.id === 'terminal' ? { hasSelection: false } : { groupId: 'split-group', ai: false }) }
    const context = parsePluginMenuContext(point, base)
    assert.equal(handler.when(context), true); assert.equal(handler.enabled(context), true)
    assert.equal(handler.when({ ...context, protocol: 'local' }), false)
    assert.equal(handler.when({ ...context, ai: true }), false)
    assert.equal(handler.when({ sessionId: 'legacy', ready: true }), false)
    assert.equal(handler.enabled({ ...context, ready: false }), false)
    handler.run(context)
    assert.equal(api.remoteEditorRequest.value.sessionId, 'selected-ssh')
    assert.equal(api.remoteEditorRequest.value.folder, '', 'cwd is resolved through WS, not a cached file-panel folder')
    cleanups[0](); assert.equal(api.remoteEditorRequest.value, undefined)
  }
})
