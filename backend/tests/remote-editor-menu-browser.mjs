// Isolated SSH/SFTP and simulated editor, with real WS, xterm and SSH HTTP forwarding.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { automationFixture, waitFor } from './automation-fixture.mjs'

const fixture = await automationFixture({ editor: true })
// Emulate a backend that was started before the UI/menu update. Keep this cache
// unchanged throughout, including across a browser refresh with live SSH shells.
const builtins = fixture.ctx.plugins.manager.builtinDetails
delete builtins.find(plugin => plugin.id === 'builtin.remoteEditor').manifest.contributes
for (const point of builtins.find(plugin => plugin.id === 'builtin.sessions').manifest.contributes.menuPoints) {
  delete point.fields.name
  if (point.id === 'terminal') delete point.fields.protocol
  else { delete point.fields.ready; delete point.fields.ai }
}
const cachedManifests = JSON.stringify(builtins)
let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = [], calls = [], popups = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('popup', popup => popups.push(popup))
  // The host exposes a service bridge; instrument the isolated test implementation behind it.
  const editorService = fixture.ctx.plugins.slots.get('remoteEditor').bridge.current
  const fileService = fixture.ctx.plugins.slots.get('sshFiles').bridge.current
  const prepare = editorService.prepare.bind(editorService)
  editorService.prepare = (owner, input) => { calls.push(input); return prepare(owner, input) }
  const pane = name => page.getByRole('region', { name: `终端 Fixture ${name} · SSH`, exact: true, includeHidden: true })
  const tab = name => page.getByRole('tab', { name: new RegExp(`Fixture ${name} · SSH`) })
  const item = () => page.getByRole('menuitem', { name: '用 VS Code 打开当前目录 · 远程 VS Code', exact: true })
  const panel = page.getByRole('dialog', { name: '远程 VS Code', exact: true })
  const close = () => panel.getByRole('button', { name: '关闭编辑器面板' }).click()
  async function menu(name, body = false) {
    if (body) { await tab(name).click(); await pane(name).locator('.xterm-screen').click({ button: 'right' }) }
    else await tab(name).click({ button: 'right' })
    try { await item().waitFor() } catch (error) { console.error('Menu:', await page.getByRole('menu').allTextContents(), 'errors:', errors); throw error }
  }
  async function open(name, body = false) {
    await menu(name, body)
    const popup = page.waitForEvent('popup')
    await item().click()
    return popup
  }
  async function ready(popup, path) {
    await popup.waitForURL(url => url.origin !== fixture.origin && url.protocol === 'http:', { timeout: 15000 })
    assert.equal(new URL(popup.url()).searchParams.get('folder'), path)
    await popup.getByRole('heading', { name: '模拟远程编辑器' }).waitFor()
    assert.equal(await popup.evaluate(() => window.opener), null)
    await panel.waitFor({ state: 'hidden' })
    await popup.close()
  }
  async function screenshot(name) {
    if (!process.env.WEBNAV_TEST_SCREENSHOTS) return
    await mkdir(process.env.WEBNAV_TEST_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.WEBNAV_TEST_SCREENSHOTS, name + '.png') })
  }
  await page.goto(fixture.origin)
  for (const name of ['alpha', 'beta']) {
    await page.getByRole('button', { name: `Fixture ${name} SSH`, exact: true }).click()
    await waitFor(async () => (await pane(name).locator('.terminal-status [role="status"]').innerText()).trim() === '已连接')
    if (name === 'alpha') await page.getByRole('tab', { name: /服务器目录/ }).click()
  }
  const shells = fixture.stats.shells, inputs = fixture.stats.inputs.length
  const alphaId = (await pane('alpha').getAttribute('id')).slice('terminal-pane-'.length)
  await page.reload()
  await waitFor(async () => await pane('alpha').count() === 1 && await pane('beta').count() === 1)
  for (const name of ['alpha', 'beta']) await waitFor(async () => (await pane(name).locator('.terminal-status [role="status"]').innerText()).trim() === '已连接')
  assert.equal((await pane('alpha').getAttribute('id')).slice('terminal-pane-'.length), alphaId)
  assert.equal(fixture.stats.shells, shells, 'refresh must reattach the original SSH shells')
  assert.equal(fixture.stats.connections, shells, 'refresh must not create another SSH connection')
  const originalInput = await pane('alpha').locator('.xterm-helper-textarea').elementHandle()
  // Unknown cwd must not silently open home, SFTP selection or another terminal.
  await menu('alpha'); await item().click()
  await panel.getByRole('alert').filter({ hasText: '尚未识别当前 SSH 目录' }).waitFor()
  assert.equal(popups.length, 0, 'unknown cwd must not open an empty tab')
  assert.equal(calls.length, 0)
  await close()
  const [alpha, beta] = fixture.streams
  const report = (stream, path) => stream.write(`\r\n\x1b]7;file://loopback${encodeURI(path)}\x07fixture@loopback:${path}$ `)
  report(alpha, '/home/fixture/projects'); report(beta, '/home/fixture')
  await menu('alpha'); await screenshot('remote-editor-workspace-menu'); await page.keyboard.press('Escape')
  // Alpha's tab is targeted while Beta remains the active workspace.
  await menu('alpha'); await item().click()
  const install = panel.getByRole('button', { name: '安装并启动' })
  await install.waitFor()
  assert.equal(popups.length, 0, 'checking and needs-install must stay in the current tab')
  assert.equal(calls.at(-1).sessionId, alphaId)
  assert.equal(calls.at(-1).folder, '/home/fixture/projects')
  await install.click()
  const finish = panel.getByRole('button', { name: '完成并打开', exact: true })
  await finish.waitFor()
  assert.equal(popups.length, 0, 'installation and completion must wait for the explicit open click')
  await screenshot('remote-editor-finish-install')
  const installed = page.waitForEvent('popup'); await finish.click()
  await ready(await installed, '/home/fixture/projects')
  // Terminal body opens the same prepared session in one click.
  await ready(await open('alpha', true), '/home/fixture/projects')
  // Manual file browsing is independent of the SSH cwd; special characters survive the URL.
  const special = '/home/fixture/中文 项目 # &'
  await mkdir(join(fixture.home, '中文 项目 # &'))
  report(alpha, special)
  const files = page.getByRole('button', { name: '切换文件栏', exact: true })
  if (await files.getAttribute('aria-pressed') !== 'true') await files.click()
  const path = page.getByRole('textbox', { name: '远程目录路径' })
  await path.fill('/home/fixture'); await path.press('Enter')
  await page.locator('.remote-files-table').getByRole('button', { name: 'README.md', exact: true }).waitFor()
  await ready(await open('alpha', true), special)
  // Closing the panel while a read is in flight must ignore its late response.
  const directory = fileService.directory.bind(fileService)
  let release
  fileService.directory = () => new Promise(resolve => { release = resolve })
  await page.getByRole('button', { name: '关闭文件栏', exact: true }).click()
  await menu('beta', true); await item().click()
  const before = calls.length, popupCount = popups.length
  await waitFor(() => !!release); await close()
  release({ path: '/home/fixture', revision: 1 })
  fileService.directory = directory
  await page.waitForTimeout(200)
  assert.equal(popups.length, popupCount, 'cancelled checks must not open a tab')
  assert.equal(calls.length, before, 'late directory response must not start editor')
  // A blocked popup leaves an explicit link instead of retrying window.open asynchronously.
  await page.evaluate(() => { window.__open = window.open; window.__openAttempts = 0; window.open = () => { window.__openAttempts++; return null } })
  await menu('alpha', true); await item().click()
  const fallback = panel.getByRole('button', { name: '打开编辑器', exact: true })
  await fallback.waitFor()
  await page.waitForTimeout(1700)
  assert.equal(await page.evaluate(() => window.__openAttempts), 1, 'polling must not retry a blocked automatic open')
  await close(); await page.evaluate(() => { window.open = window.__open })
  // Locale changes must not turn a translated connection status into a disabled action.
  const language = locale => page.evaluate(value => window.dispatchEvent(new StorageEvent('storage', { key: 'webnav.locale.v1', newValue: value })), locale)
  await language('en')
  await tab('alpha').click({ button: 'right' })
  const english = page.getByRole('menuitem', { name: /^Open current directory with VS Code/ })
  assert.equal(await english.isEnabled(), true)
  const englishPopup = page.waitForEvent('popup'); await english.click()
  await ready(await englishPopup, special)
  await language('zh-CN')
  assert.equal(fixture.stats.shells, shells, 'menus must not reconnect SSH')
  assert.equal(fixture.stats.inputs.length, inputs, 'cwd lookup must not inject terminal input')
  assert.equal(await originalInput.evaluate(el => el.isConnected), true, 'xterm must stay mounted')
  // Narrow menus remain visible and reachable; disconnected terminal actions are disabled.
  await page.setViewportSize({ width: 560, height: 760 })
  await menu('alpha', true)
  const bounds = await item().boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 560)
  await screenshot('remote-editor-terminal-menu')
  await page.keyboard.press('Escape'); alpha.end()
  await waitFor(async () => (await pane('alpha').locator('.terminal-status [role="status"]').innerText()).trim() !== '已连接')
  await menu('alpha', true); assert.equal(await item().isDisabled(), true)
  assert.equal(JSON.stringify(builtins), cachedManifests, 'updated UI must work without reloading backend manifests')
  assert.deepEqual(errors, [])
  console.log('Remote editor menus: cached old backend manifests, same SSH shells across refresh, tab/body target, unknown cwd, install, new tab, encoded path, cancellation, popup fallback, localization and narrow layout passed.')
} finally {
  await browser?.close()
  await fixture.close()
}
