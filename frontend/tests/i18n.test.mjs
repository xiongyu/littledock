import test from 'node:test'
import assert from 'node:assert/strict'
import { computed } from 'vue'
import { LocaleRegistry, parseLocaleBundle, parseMessageRef, createPluginMessages, formatMessage } from '@webnav/shared'
import { currentLocale, setLocale, pluginI18n, registerLocaleBundle, renderMessage, localizedManifest, cachePluginLocales, installedLocaleBundles } from '../src/i18n.ts'

const bundle = { defaultLocale: 'zh-CN', locales: { 'zh-CN': { hello: '你好，{name}', fallback: '默认文案' }, en: { hello: 'Hello, {name}' } } }
test('plugin dictionaries isolate namespaces and resolve regional and default-language fallbacks', () => {
  const registry = new LocaleRegistry(); registry.register('test.one', { ...bundle, locales: { ...bundle.locales, 'en-GB': {} } })
  registry.register('test.two', { defaultLocale: 'en', locales: { en: { hello: 'Different {name}' } } })
  assert.equal(registry.translate('test.one', 'hello', 'en-GB', { name: 'Alex' }), 'Hello, Alex')
  assert.equal(registry.translate('test.one', 'fallback', 'en'), '默认文案')
  assert.equal(registry.translate('test.one', 'hello', 'fr', { name: 'Alex' }), '你好，Alex')
  assert.equal(registry.translate('test.two', 'hello', 'en', { name: 'Alex' }), 'Different Alex')
  assert.equal(registry.translate('test.none', 'hello', 'en'), 'hello')
})
test('replacement validates before publication and stale cleanup cannot delete the successor', () => {
  const registry = new LocaleRegistry(), dispose = registry.register('test.one', bundle)
  assert.throws(() => registry.register('test.one', { ...bundle, locales: { ...bundle.locales, en: { hello: 'Wrong {other}' } } }), /parameters/)
  assert.equal(registry.translate('test.one', 'hello', 'en', { name: 'Alex' }), 'Hello, Alex')
  const replacement = registry.register('test.one', { defaultLocale: 'en', locales: { en: { hello: 'New' } } })
  dispose(); assert.equal(registry.translate('test.one', 'hello', 'en'), 'New')
  replacement(); assert.equal(registry.translate('test.one', 'hello', 'en'), 'hello')
})
test('locale validation bounds dictionaries and rejects unsafe keys, mismatched placeholders and unknown keys', () => {
  for (const value of [null, { defaultLocale: 'xx_bad', locales: {} }, { defaultLocale: 'en', locales: { zh: {} } }, { defaultLocale: 'en', locales: { en: { 'x.constructor': 'x' } } }, { defaultLocale: 'en', locales: { en: { x: 'a'.repeat(10001) } } }, { defaultLocale: 'en', locales: { en: { x: 'safe' }, fr: { extra: 'extra' } } }]) assert.throws(() => parseLocaleBundle(value))
  assert.throws(() => parseMessageRef({ namespace: 'test', key: 'x', params: { x: { secret: true } } }))
  assert.equal(formatMessage('{value} / {missing}', { value: '<b>{value}</b>' }), '<b>{value}</b> / {missing}')
})
test('default Chinese and live translation share one reactive preference without changing source data', () => {
  assert.equal(currentLocale.value, 'zh-CN')
  const dispose = registerLocaleBundle('test.live', bundle), api = pluginI18n('test.live'), text = computed(() => api.t('hello', { name: '自定义名称' }))
  const reference = api.ref('hello', { name: '自定义名称' }), notice = computed(() => api.message(reference))
  assert.equal(notice.value, '你好，自定义名称')
  assert.equal(text.value, '你好，自定义名称'); setLocale('en'); assert.equal(text.value, 'Hello, 自定义名称')
  assert.equal(notice.value, 'Hello, 自定义名称')
  assert.equal(api.number(1234), '1,234'); assert.throws(() => setLocale('fr'))
  setLocale('zh-CN'); dispose()
})
test('structured Worker errors translate while ordinary remote output and unknown references stay intact', () => {
  const dispose = registerLocaleBundle('test.messages', bundle), messages = createPluginMessages('test.messages', bundle)
  const error = messages.error('PLUGIN_FAILED', 'hello', { name: 'Alex', absent: undefined })
  assert.equal(error.message, '你好，Alex'); setLocale('en')
  assert.equal(renderMessage(JSON.parse(JSON.stringify(error.messageRef))), 'Hello, Alex')
  assert.equal(renderMessage('用户的中文终端输出'), '用户的中文终端输出')
  assert.equal(renderMessage({ namespace: 'missing', key: 'error' }, 'Original diagnostic'), 'Original diagnostic')
  setLocale('zh-CN'); dispose()
})
test('metadata and installed settings dictionaries follow the active language and survive stale cleanup', () => {
  const manifest = { id: 'test.settings', name: '原始名称', description: '原始描述' }
  const first = { defaultLocale: 'zh-CN', locales: { 'zh-CN': { 'metadata.name': '名称' }, en: { 'metadata.name': 'Name' } } }
  cachePluginLocales(manifest.id, 'first', first); const previous = installedLocaleBundles.get(manifest.id)
  cachePluginLocales(manifest.id, 'second', first); previous.dispose(); setLocale('en')
  assert.equal(localizedManifest(manifest).name, 'Name'); assert.equal(manifest.name, '原始名称')
  installedLocaleBundles.get(manifest.id).dispose(); installedLocaleBundles.delete(manifest.id); setLocale('zh-CN')
})
