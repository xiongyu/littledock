// Real xterm and loopback SSH, with an isolated catalog and no user data.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { automationFixture, waitFor } from './automation-fixture.mjs'

const fixture = await automationFixture()
let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' }), errors = []
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  const pane = name => page.getByRole('region', { name: `终端 Fixture ${name} · SSH`, exact: true, includeHidden: true })
  const panel = page.locator('.connection-theme-panel')
  const selected = () => panel.getByLabel('当前连接配色', { exact: true })
  const save = () => panel.getByRole('button', { name: '保存当前连接配色', exact: true }).click()
  const close = () => page.locator('.panel-header').getByRole('button', { name: '关闭面板', exact: true }).click()
  const id = async name => (await pane(name).getAttribute('id')).slice('terminal-pane-'.length)
  const color = name => pane(name).locator('.xterm-scrollable-element').evaluate(el => getComputedStyle(el).backgroundColor)
  const colors = async (alpha, beta) => {
    try { await waitFor(async () => await color('alpha') === alpha && await color('beta') === beta) }
    catch (error) {
      console.error('Rendered terminal colors:', await pane('alpha').evaluate(el => [...el.querySelectorAll('.terminal-pane,.xterm,.xterm-screen,.xterm-viewport,.xterm-rows')].map(item => [item.className, getComputedStyle(item).backgroundColor])))
      throw error
    }
  }
  const stored = name => fixture.ctx.storage.connection(name, 'ssh').connection.terminalThemeId
  const mutate = change => {
    const current = fixture.ctx.storage.snapshot()
    change(current.snapshot)
    fixture.ctx.storage.replace(current.snapshot, current.revision)
    fixture.ctx.storage.notify()
  }
  async function openColors(name) {
    await page.getByRole('tab', { name: new RegExp(`Fixture ${name} · SSH`) }).click()
    await pane(name).locator('.xterm-screen').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '终端配色…', exact: true }).click()
    await panel.waitFor()
    assert.match(await panel.locator('.connection-theme-target').innerText(), new RegExp(`Fixture ${name}`))
  }
  async function screenshot(name) {
    if (!process.env.WEBNAV_TEST_SCREENSHOTS) return
    await mkdir(process.env.WEBNAV_TEST_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.WEBNAV_TEST_SCREENSHOTS, name + '.png') })
  }
  mutate(catalog => catalog.servers[0].connections.push({ ...catalog.servers[0].connections[0], id: 'other', name: 'Other SSH', terminalThemeId: 'paper' }))
  await page.goto(fixture.origin)
  for (const name of ['alpha', 'beta']) {
    await page.getByRole('button', { name: `Fixture ${name} SSH`, exact: true }).click()
    await waitFor(async () => (await pane(name).locator('.terminal-status [role="status"]').innerText()).trim() === '已连接')
    if (name === 'alpha') await page.getByRole('tab', { name: /服务器目录/ }).click()
  }
  const ids = [await id('alpha'), await id('beta')], shells = fixture.stats.shells
  const originalInput = await pane('alpha').locator('.xterm-helper-textarea').elementHandle()
  await colors('rgb(23, 32, 29)', 'rgb(23, 32, 29)')
  await openColors('alpha')
  assert.equal(await selected().inputValue(), '')
  await selected().selectOption('graphite')
  assert.equal(await color('alpha'), 'rgb(23, 32, 29)', 'preview does not apply before saving')
  await screenshot('connection-colors-light')
  await save()
  await colors('rgb(32, 33, 36)', 'rgb(23, 32, 29)')
  assert.equal(stored('alpha'), 'graphite')
  assert.equal(fixture.ctx.storage.connection('alpha', 'other').connection.terminalThemeId, 'paper')
  assert.equal(fixture.ctx.terminalThemes.snapshot().defaultId, 'forest')
  await close()

  await openColors('beta')
  await selected().selectOption('midnight'); await save(); await close()
  await colors('rgb(32, 33, 36)', 'rgb(16, 24, 39)')
  await openColors('alpha')
  await selected().selectOption('paper'); await close()
  await page.getByRole('button', { name: '不保存', exact: true }).click()
  assert.equal(stored('alpha'), 'graphite', 'discard preserves the stored choice')

  // Create a scheme and return to the same entry, without changing the default.
  await openColors('alpha')
  await panel.getByRole('button', { name: '管理配色方案', exact: true }).click()
  await page.getByRole('button', { name: '新建配色', exact: true }).click()
  await page.getByLabel('配色名称', { exact: true }).fill('Loopback custom')
  await page.getByLabel('背景色值', { exact: true }).fill('#352145')
  await page.getByRole('button', { name: '保存配色', exact: true }).click()
  await waitFor(() => fixture.ctx.terminalThemes.snapshot().themes.length === 1)
  const custom = fixture.ctx.terminalThemes.snapshot().themes[0].id
  await page.getByRole('button', { name: '返回当前连接', exact: true }).click()
  assert.equal(await selected().inputValue(), 'graphite')
  await selected().selectOption(custom); await save(); await close()
  await colors('rgb(53, 33, 69)', 'rgb(16, 24, 39)')
  assert.equal(fixture.ctx.terminalThemes.snapshot().defaultId, 'forest')
  assert.equal(fixture.stats.shells, shells, 'changing colors must not recreate either SSH shell')
  assert.equal(await originalInput.evaluate(el => el.isConnected), true, 'xterm instance and output remain mounted')
  assert.deepEqual([await id('alpha'), await id('beta')], ids)
  await pane('alpha').locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('color-input-check')
  await waitFor(() => fixture.stats.inputs.join('').includes('color-input-check'))

  // Following the default is distinct from explicitly selecting that theme.
  await openColors('alpha'); await selected().selectOption(''); await save(); await close()
  const settings = fixture.ctx.terminalThemes.snapshot()
  fixture.ctx.terminalThemes.save({ ...settings, defaultId: 'paper' })
  await colors('rgb(245, 242, 234)', 'rgb(16, 24, 39)')
  await openColors('alpha'); await selected().selectOption(custom); await save(); await close()
  fixture.ctx.terminalThemes.save({ ...fixture.ctx.terminalThemes.snapshot(), themes: [] })
  await colors('rgb(245, 242, 234)', 'rgb(16, 24, 39)')
  await openColors('alpha')
  assert.match(await selected().innerText(), /配色已移除/)
  await selected().selectOption('graphite'); await save(); await close()

  // Refresh reconnects the viewer to the same shells and retains per-entry choices.
  await page.evaluate(() => localStorage.removeItem('webnav.appearance.v1'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await waitFor(async () => await pane('alpha').count() === 1 && await pane('beta').count() === 1)
  await colors('rgb(32, 33, 36)', 'rgb(16, 24, 39)')
  assert.deepEqual([await id('alpha'), await id('beta')], ids)
  assert.equal(fixture.stats.shells, shells)
  await openColors('alpha'); await screenshot('connection-colors-dark')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.locator('.panel-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await screenshot('connection-colors-mobile')
  await page.setViewportSize({ width: 1280, height: 850 })

  // Late edits cannot silently overwrite this entry; unrelated catalog changes survive.
  await selected().selectOption('paper')
  mutate(catalog => { catalog.servers[0].note = 'unrelated edit'; catalog.servers[1].favorite = true })
  await page.waitForTimeout(100)
  await save()
  assert.equal(fixture.ctx.storage.connection('alpha', 'ssh').server.note, 'unrelated edit')
  assert.equal(fixture.ctx.storage.connection('beta', 'ssh').server.favorite, true)
  mutate(catalog => { catalog.servers[0].connections[0].terminalThemeId = 'midnight' })
  await panel.getByRole('alert').filter({ hasText: '已在其他页面修改' }).waitFor()
  assert.equal(await panel.getByRole('button', { name: '保存当前连接配色', exact: true }).isDisabled(), true)
  await close(); await openColors('alpha')

  // Surface a rejected write and preserve the draft for review, without retrying it.
  const replace = fixture.ctx.storage.replace.bind(fixture.ctx.storage)
  let attempted = 0
  fixture.ctx.storage.replace = () => { attempted++; throw new Error('Synthetic palette save failure') }
  await selected().selectOption('graphite'); await save()
  await panel.getByRole('alert').waitFor()
  assert.equal(attempted, 1)
  assert.equal(stored('alpha'), 'midnight')
  assert.equal(await selected().inputValue(), 'graphite')
  fixture.ctx.storage.replace = replace
  await close(); await page.getByRole('button', { name: '不保存', exact: true }).click()
  await openColors('alpha')
  mutate(catalog => { catalog.servers[0].connections = catalog.servers[0].connections.filter(entry => entry.id !== 'ssh') })
  await panel.getByRole('alert').filter({ hasText: '该连接入口已不存在' }).waitFor()
  assert.equal(await panel.getByRole('button', { name: '保存当前连接配色', exact: true }).isDisabled(), true)
  await close()
  assert.deepEqual(errors, [])
  for (const name of ['alpha', 'beta']) await page.getByRole('button', { name: `关闭终端 Fixture ${name} · SSH`, exact: true }).click()
  await waitFor(() => fixture.ctx.sessions.size === 0)
  console.log('Terminal colors browser passed: per-entry isolation, custom themes, defaults/fallback, preview/discard, live xterm preservation, refresh, conflict/failure/removal, light/dark/390px and cleanup.')
} catch (error) { console.error(error); throw error }
finally { await browser?.close(); await fixture.close() }
