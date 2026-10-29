import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url), ts = require('typescript'), vue = require('vue')
function fixture() {
  const exports = {}, saved = new Map()
  runInNewContext(ts.transpileModule(readFileSync('src/plugin-fonts.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => name === 'vue' ? vue : require(name), localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } })
  return exports
}
const definition = { flag: 'table', name: '进程表格', group: '进程列表', defaultSize: 16, minSize: 12, maxSize: 28 }
test('font namespace exposes readable ownership, reactive readonly size and retains override after reload', async () => {
  const api = fixture(), a = api.createPluginFontScope('test.one', '插件甲'), b = api.createPluginFontScope('test.two', '插件乙')
  a.registerFontInfo(definition); b.registerFontInfo(definition); a.commit(); b.commit()
  const font = a.getFontInfo('table'); assert.equal(vue.isReadonly(font), true)
  api.setPluginFontSize('test.one/table', 22); await vue.nextTick()
  assert.equal(font.size, 22); assert.equal(b.getFontInfo('table').size, 16)
  assert.equal(api.registeredFonts.value.find(f => f.key === 'test.one/table').pluginName, '插件甲')
  assert.throws(() => api.setPluginFontSize('test.one/table', 29), /范围/)
  assert.throws(() => a.getFontInfo('missing'), /未注册/)
  a.dispose(); assert.equal(api.registeredFonts.value.some(f => f.pluginId === 'test.one'), false)
  const replacement = api.createPluginFontScope('test.one', '插件甲'); replacement.registerFontInfo(definition); replacement.commit()
  assert.equal(replacement.getFontInfo('table').size, 22)
  api.setPluginFontSize('test.one/table'); assert.equal(replacement.getFontInfo('table').size, 16)
})
test('font registration rejects conflict and late registration while staged defaults remain unpublished', () => {
  const api = fixture(), a = api.createPluginFontScope('test.one', '插件甲')
  a.registerFontInfo(definition); assert.equal(api.registeredFonts.value.some(f => f.pluginId === 'test.one'), false)
  assert.throws(() => a.registerFontInfo({ ...definition, defaultSize: 20 }), /冲突/)
  a.dispose(); assert.throws(() => a.registerFontInfo(definition), /关闭/)
})
