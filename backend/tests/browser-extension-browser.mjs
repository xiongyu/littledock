// Isolated local browser acceptance: no user browser profile, credentials, or real remote site.
import { chromium } from 'playwright-core'
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'

const root = resolve(import.meta.dirname, '../..'), directory = await mkdtemp(join(tmpdir(), 'webnav-extension-browser-'))
let context, app, plain, secure
const checks = []
try {
  const html = '<!doctype html><html><head><title>本机登录测试</title><style>body{font:16px system-ui;padding:40px}input{display:block;margin:12px 0;padding:10px;width:260px}</style></head><body><h1>本机登录测试</h1><form onsubmit="event.preventDefault()"><label>账号<input id="username" autocomplete="username"></label><label>密码<input id="password" type="password" autocomplete="current-password"></label><button>登录</button></form></body></html>'
  plain = httpServer((_req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html) }); plain.listen(0, '127.0.0.1'); await once(plain, 'listening')
  const httpPort = plain.address().port
  const key = join(directory, 'fixture.key'), cert = join(directory, 'fixture.crt')
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=webnav-extension.test','-addext','subjectAltName=DNS:webnav-extension.test'], { stdio: 'ignore', windowsHide: true })
  secure = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html) }); secure.listen(0, '127.0.0.1'); await once(secure, 'listening')
  const httpsPort = secure.address().port
  const probe = httpServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  app = await createApp({ directory: join(directory, 'data'), port, frontendRoot: join(root, 'frontend/dist'), disablePlugins: true, webCapture: async () => Buffer.from([255,216,255,217]) })
  app.webBookmarks.save({ bookmark: { id: 'test-http', name: 'HTTP 模拟管理台', url: `https://webnav-extension.test:${httpPort}/login` }, expectedVersion: 0, login: { username: 'fixture-account', password: 'fixture-only-secret' } })
  app.webBookmarks.save({ bookmark: { id: 'test-https', name: 'HTTPS 模拟管理台', url: `http://webnav-extension.test:${httpsPort}/login` }, expectedVersion: 0, login: { username: 'fixture-secure', password: 'fixture-https-secret' } })
  const extensionPath = join(directory, 'test-extension')
  await cp(join(root, 'extension/dist/chrome'), extensionPath, { recursive: true })
  // Headless Chrome cannot click its permission bubble. Pregrant only the local fixture host.
  // Production packages retain optional, per-site permissions; this does not alter shipped manifests.
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'))
  manifest.host_permissions.push('http://webnav-extension.test/*', 'https://webnav-extension.test/*')
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest))
  context = await chromium.launchPersistentContext(join(directory, 'browser'), {
    channel: 'chromium', executablePath: process.env.WEBNAV_TEST_BROWSER, headless: true, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--host-resolver-rules=MAP webnav-extension.test 127.0.0.1', '--no-proxy-server'],
  })
  context.setDefaultTimeout(10_000)
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10_000 })
  const extensionId = new URL(worker.url()).hostname
  const nav = await context.newPage(); await nav.goto(`http://127.0.0.1:${port}/`)
  for (const target of ['chrome', 'edge', 'firefox']) {
    const archive = await context.request.get(`http://127.0.0.1:${port}/extensions/webnav-${target}.zip`)
    assert.equal(archive.status(), 200); assert.equal((await archive.body()).subarray(0, 2).toString(), 'PK')
  }
  await nav.getByRole('button', { name: '全局设置', exact: true }).click()
  await nav.getByRole('button', { name: /浏览器自动填写/ }).click()
  await nav.getByRole('button', { name: '生成一次性配对码' }).click()
  const code = await nav.getByRole('textbox', { name: '一次性配对码' }).inputValue()
  assert.ok(code.startsWith('wn1.'))
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.locator('#pair-code').fill(code); await popup.getByRole('button', { name: '配对此浏览器' }).click()
  await popup.locator('#paired-tools').waitFor({ state: 'visible' })
  assert.equal(app.browserExtension.status().devices.length, 1); checks.push('真实扩展后台与设置页面配对')
  const login = await context.newPage(); await login.goto(`http://webnav-extension.test:${httpPort}/`)
  // Loopback IP URLs are secure contexts even over HTTP; a mapped test hostname exercises ordinary HTTP.
  assert.equal(await login.evaluate(() => isSecureContext), false)
  const send = async (type, params = {}) => {
    const reply = await popup.evaluate(async data => chrome.runtime.sendMessage(data), { type, ...params })
    assert.equal(reply.ok, true, reply.error); return reply.result
  }
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, login.url())
  let found = await send('matches', { tabId, origin: new URL(login.url()).origin }); assert.deepEqual(found.matches.map(m => m.id), ['test-http'])
  await send('manualFill', { tabId, origin: new URL(login.url()).origin, bookmarkId: 'test-http', automatic: false })
  assert.equal(await login.locator('#username').inputValue(), 'fixture-account'); assert.equal(await login.locator('#password').inputValue(), 'fixture-only-secret')
  checks.push('HTTP 页面匹配 HTTPS 收藏且无需额外勾选')
  await login.goto(`https://webnav-extension.test:${httpsPort}/`)
  found = await send('matches', { tabId, origin: new URL(login.url()).origin }); assert.deepEqual(found.matches.map(m => m.id), ['test-https'])
  await send('manualFill', { tabId, origin: new URL(login.url()).origin, bookmarkId: 'test-https', automatic: true })
  assert.equal(await login.locator('#username').inputValue(), 'fixture-secure'); assert.equal(await login.locator('#password').inputValue(), 'fixture-https-secret')
  checks.push('HTTPS 页面匹配 HTTP 收藏，非默认端口隔离')
  await login.reload(); await login.waitForFunction(() => document.querySelector('#password').value === 'fixture-https-secret')
  checks.push('授权网站刷新后自动填写')
  const oldDocument = await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'webnav.probe' }, { frameId: 0 }), tabId)
  await login.reload(); await login.waitForFunction(() => document.querySelector('#password').value === 'fixture-https-secret')
  await login.locator('#username').fill(''); await login.locator('#password').fill('')
  const stale = await worker.evaluate(async ({ id, token, origin }) => chrome.tabs.sendMessage(id, { type: 'webnav.fill', documentToken: token, origin, expiresAt: Date.now() + 5000, username: 'stale-account', password: 'stale-secret' }, { frameId: 0 }), { id: tabId, token: oldDocument.documentToken, origin: new URL(login.url()).origin })
  assert.equal(stale.filled, false); assert.equal(await login.locator('#password').inputValue(), '')
  await login.locator('form').evaluate(form => form.action = 'https://example.invalid/')
  assert.equal((await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'webnav.probe' }, { frameId: 0 }), tabId)).fillable, false)
  await login.locator('form').evaluate(form => form.removeAttribute('action'))
  await login.locator('#password').evaluate(input => input.hidden = true)
  assert.equal((await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'webnav.probe' }, { frameId: 0 }), tabId)).fillable, false)
  await login.locator('#password').evaluate(input => input.hidden = false)
  checks.push('旧页面响应、隐藏密码框和跨网站表单被拒绝')
  await login.locator('#username').fill('my-own-input'); await login.locator('#password').fill('')
  const blocked = await popup.evaluate(async data => chrome.runtime.sendMessage(data), { type: 'manualFill', tabId, origin: new URL(login.url()).origin, bookmarkId: 'test-https', automatic: true })
  assert.equal(blocked.ok, false); assert.equal(await login.locator('#username').inputValue(), 'my-own-input'); assert.equal(await login.locator('#password').inputValue(), '')
  checks.push('已有输入不被覆盖')
  const pairId = app.browserExtension.status().devices[0].id
  app.browserExtension.revokeGrant(pairId, 'test-https')
  await login.reload(); await login.waitForTimeout(800); assert.equal(await login.locator('#password').inputValue(), '')
  checks.push('撤销网站授权后停止自动填写')
  await nav.getByRole('button', { name: '刷新授权列表' }).click()
  await nav.setViewportSize({ width: 390, height: 844 })
  assert.equal(await nav.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await mkdir(join(root, 'docs/design/screenshots'), { recursive: true })
  await nav.screenshot({ path: join(root, 'docs/design/screenshots/browser-extension-mobile.png') })
  await nav.setViewportSize({ width: 1280, height: 900 }); await nav.screenshot({ path: join(root, 'docs/design/screenshots/browser-extension.png') })
  await login.bringToFront(); await popup.reload(); await popup.locator('#fill-form').waitFor({ state: 'visible' })
  await popup.locator('body').screenshot({ path: join(root, 'docs/design/screenshots/browser-extension-popup.png') })
  checks.push('设置入口、扩展弹窗和 390px 窄屏')
  const openCapture = async () => {
    await login.bringToFront(); await popup.reload(); await popup.locator('#capture-page').waitFor({ state: 'visible' })
    await popup.getByRole('button', { name: '收藏当前网页', exact: true }).click(); await popup.locator('#save-form').waitFor({ state: 'visible' })
  }
  const submitted = async () => {
    await popup.locator('#save-submit').click()
    await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存到 WebNav'))
    assert.equal(await popup.locator('#save-password').inputValue(), '')
  }
  await login.locator('#username').fill('captured-account'); await login.locator('#password').fill('captured-test-password')
  assert.equal(app.webBookmarks.snapshot().bookmarks.length, 2)
  await openCapture()
  assert.equal(await popup.locator('#save-name').inputValue(), '本机登录测试')
  assert.equal(await popup.locator('#save-url').inputValue(), login.url())
  assert.equal(await popup.locator('#save-username').inputValue(), 'captured-account')
  assert.equal(await popup.locator('#save-password').inputValue(), 'captured-test-password')
  assert.equal(await popup.locator('#save-password').getAttribute('type'), 'password')
  await popup.locator('body').screenshot({ path: join(root, 'docs/design/screenshots/browser-extension-save.png') })
  await popup.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await popup.locator('#save-password').inputValue(), ''); assert.equal(app.webBookmarks.snapshot().bookmarks.length, 2)
  await openCapture(); await popup.locator('#save-name').fill('从扩展保存的测试收藏'); await submitted()
  const saved = app.webBookmarks.snapshot().bookmarks.find(b => b.name === '从扩展保存的测试收藏')
  assert.ok(saved); assert.equal(app.webBookmarks.snapshot().bookmarks.length, 3)
  assert.deepEqual(app.credentials.bookmarkLogin(saved.id), { username: 'captured-account', password: 'captured-test-password' })
  // The normal WebNav subscription reflects extension writes without a reload.
  await nav.getByRole('button', { name: '关闭面板', exact: true }).click()
  await nav.getByText('从扩展保存的测试收藏', { exact: true }).waitFor()
  checks.push('点击读取网页标题、网址和已输入账密；取消清理；确认后首页立即出现收藏')
  await openCapture(); await popup.locator('#save-target').selectOption(saved.id)
  await popup.locator('#save-username').fill('updated-account'); await popup.locator('#save-password').fill('updated-test-password'); await submitted()
  assert.equal(app.webBookmarks.snapshot().bookmarks.length, 3)
  assert.equal(app.credentials.bookmarkLogin(saved.id).password, 'updated-test-password')
  await openCapture(); await popup.locator('#save-target').selectOption(saved.id); await popup.locator('#save-login').uncheck(); await submitted()
  assert.equal(app.credentials.bookmarkLogin(saved.id).password, 'updated-test-password')
  checks.push('明确选择更新已有收藏；只更新网页时保留已有账密')
  await openCapture(); await login.reload(); await popup.locator('#save-form').waitFor({ state: 'hidden' })
  assert.equal(await popup.locator('#save-password').inputValue(), '')
  const forged = await worker.evaluate(async id => chrome.scripting.executeScript({ target: { tabId: id }, func: async () => {
    try { return await chrome.runtime.sendMessage({ type: 'capturePage', tabId: 1, origin: location.origin }) } catch { return undefined }
  } }), tabId)
  assert.ok(forged[0].result == null); assert.equal(app.webBookmarks.snapshot().bookmarks.length, 3)
  await login.locator('#username').fill('hidden-account'); await login.locator('#password').fill('hidden-test-password'); await login.locator('#password').evaluate(input => input.hidden = true)
  await openCapture(); assert.equal(await popup.locator('#save-login').isChecked(), false); assert.equal(await popup.locator('#save-password').inputValue(), '')
  await popup.locator('#save-name').fill('仅收藏网页'); await submitted()
  assert.equal(app.webBookmarks.snapshot().bookmarks.find(b => b.name === '仅收藏网页').hasLogin, false)
  await login.locator('#password').evaluate(input => input.hidden = false)
  checks.push('刷新清除预览；页面脚本不能发起采集；隐藏输入不读取；可只收藏网页')
  await app.credentials.update({ mode: 'master', password: 'fixture-capture-master', unlockMinutes: 5 })
  await openCapture(); assert.equal(await popup.locator('#save-password').inputValue(), 'hidden-test-password')
  app.credentials.lock(); await popup.locator('#save-form').waitFor({ state: 'hidden' })
  assert.equal(await popup.locator('#save-password').inputValue(), '')
  checks.push('主密码锁定清除扩展中的账号密码预览')
  console.log(JSON.stringify({ browser: await context.browser().version(), checks }, null, 2))
} finally {
  await context?.close(); await app?.stop()
  if (plain) { plain.closeAllConnections(); await new Promise(resolve => plain.close(resolve)) }
  if (secure) { secure.closeAllConnections(); await new Promise(resolve => secure.close(resolve)) }
  assert.ok(directory.startsWith(join(tmpdir(), 'webnav-extension-browser-')))
  await rm(directory, { recursive: true, force: true })
}
