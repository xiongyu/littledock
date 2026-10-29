import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { parsePluginManifest, createPluginMessages } from '@webnav/shared'
import { readPluginLocales } from '../src/plugin-system/locales.ts'
import { WorkerRpc } from '../src/plugin-system/worker-rpc.ts'
import { publicError } from '../src/core/errors.ts'
const declaration = { defaultLocale: 'zh-CN', locales: { 'zh-CN': 'locales/zh-CN.json', en: 'locales/en.json' } }
const base = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../plugins/builtin.taskManager/webnav.plugin.json', import.meta.url), 'utf8'))
test('manifest validates static locale paths and canonical language names', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parsePluginManifest({ ...base, i18n: declaration }, true).i18n)), declaration)
  for (const i18n of [{ ...declaration, defaultLocale: 'de' }, { ...declaration, locales: { 'zh-CN': '../secret.json' } }, { ...declaration, locales: { 'zh-CN': 'locales/code.js' } }, { ...declaration, locales: { 'zh-CN': 'locales/zh-CN.json', 'en-us': 'locales/a.json', 'en-US': 'locales/b.json' } }]) assert.throws(() => parsePluginManifest({ ...base, i18n }, true))
})
test('disabled plugin language loading reads only bounded JSON, never business code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webnav-locales-'))
  try {
    await mkdir(join(root, 'locales')); await writeFile(join(root, 'main.js'), 'throw Error("Must never execute")')
    await writeFile(join(root, 'locales/zh-CN.json'), JSON.stringify({ text: '中文 {name}' })); await writeFile(join(root, 'locales/en.json'), JSON.stringify({ text: 'English {name}' }))
    const manifest = { ...base, backend: 'main.js', i18n: declaration }
    assert.equal((await readPluginLocales(root, manifest)).locales.en.text, 'English {name}')
    await writeFile(join(root, 'locales/en.json'), JSON.stringify({ text: 'Wrong {other}' })); await assert.rejects(readPluginLocales(root, manifest), /parameters/)
    await writeFile(join(root, 'locales/en.json'), ' '.repeat(512 * 1024 + 1)); await assert.rejects(readPluginLocales(root, manifest), /limit/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('localized errors survive Worker transport and the public error boundary', async () => {
  const channel = new MessageChannel(), caller = new WorkerRpc(channel.port1), worker = new WorkerRpc(channel.port2)
  const messages = createPluginMessages('test.plugin', { defaultLocale: 'zh-CN', locales: { 'zh-CN': { failed: '无法处理 {name}' }, en: { failed: 'Cannot process {name}' } } })
  worker.handler = () => { throw messages.error('PLUGIN_FAILED', 'failed', { name: 'fixture' }) }
  try { await assert.rejects(caller.call('example'), error => { const value = publicError(error); assert.equal(value.code, 'PLUGIN_FAILED'); assert.equal(value.messageRef.namespace, 'test.plugin'); assert.equal(value.messageRef.params.name, 'fixture'); return true }) }
  finally { caller.close(); worker.close(); channel.port1.close(); channel.port2.close() }
})
