// Isolated local fixtures only: no real servers, collector installs, or system optimization writes.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'
import { platformFixture } from './plugin-platform-fixture.mjs'
import { prepareOptimizerFixture } from './system-optimizer-fixture.mjs'
import { taskManagerUiFixture } from './task-manager-ui-fixture.mjs'
import { automationFixture, waitFor } from './automation-fixture.mjs'
import { mockVnc } from './desktop-fixtures.mjs'

let browser, fixture, vnc
const screenshots = join(tmpdir(), 'webnav-i18n-review'); await mkdir(screenshots, { recursive: true })
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) try { await access(path); executablePath = path; break } catch {}
  browser = await chromium.launch({ executablePath, headless: true })
  fixture = await platformFixture({ bundledSource: resolve('../plugins/system-optimizer'), prepareBundled: prepareOptimizerFixture })
  await fixture.install('source'); await fixture.install('client')
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  await page.goto(`http://127.0.0.1:${fixture.port}`)
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  await page.getByRole('button', { name: '系统优化', exact: true }).click()
  await page.getByRole('button', { name: '扫描本机', exact: true }).click()
  await page.getByText('扫描完成。未更改任何系统设置。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '系统设置', exact: true }).click()
  const original = await page.locator('.optimizer-tool').elementHandle()
  const revision = fixture.ctx.plugins.manager.runtimeRevision
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByLabel('界面语言', { exact: true }).selectOption('en')
  await page.getByLabel('Display language', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  await page.getByRole('heading', { name: 'System Optimizer', exact: true }).waitFor()
  await page.getByRole('checkbox', { name: 'Select Show file extensions', exact: true }).waitFor()
  await page.getByText('Scan complete. No system settings were changed.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Apps', exact: true }).waitFor()
  assert.equal(await original.evaluate(node => node === document.querySelector('.optimizer-tool')), true)
  assert.equal(fixture.ctx.plugins.manager.runtimeRevision, revision, 'Language changes must not activate or restart Workers')
  await page.screenshot({ path: join(screenshots, 'optimizer-en.png') })
  await page.getByRole('button', { name: 'Collaboration Counter', exact: true }).click()
  await page.getByRole('button', { name: 'Counter settings', exact: true }).click()
  await page.getByLabel('Counter title', { exact: true }).fill('用户内容保持中文')
  await page.getByRole('button', { name: '打开外观设置', exact: true }).count().then(async count => {
    await page.getByRole('button', { name: count ? '打开外观设置' : 'Open appearance settings', exact: true }).click()
  })
  await page.getByLabel('Display language', { exact: true }).selectOption('zh-CN')
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  assert.equal(await page.getByLabel('计数器标题', { exact: true }).inputValue(), '用户内容保持中文')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('配置已保存并生效。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '插件中心', exact: true }).click()
  await page.getByRole('button', { name: '停用 协作计数器', exact: true }).click()
  await page.getByRole('button', { name: '启用 协作计数器', exact: true }).waitFor()
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByLabel('界面语言', { exact: true }).selectOption('en')
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  await page.getByRole('button', { name: 'Collaboration Counter settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reload plugin configuration', exact: true }).click()
  await page.getByLabel('Counter title', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Counter title', { exact: true }).inputValue(), '用户内容保持中文')
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(screenshots, 'settings-en-mobile.png') })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await page.reload(); assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  assert.deepEqual(errors, [])
  await page.close(); await fixture.close(); fixture = undefined

  fixture = await taskManagerUiFixture()
  const monitor = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await monitor.goto(fixture.origin)
  await monitor.getByRole('button', { name: '任务管理器', exact: true }).click()
  await monitor.getByRole('button', { name: 'node-fixture', exact: true }).click()
  await monitor.getByRole('tab', { name: '网络', exact: true }).click()
  const starts = fixture.stats.starts.length, closes = fixture.stats.closes.length
  await monitor.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await monitor.getByLabel('界面语言', { exact: true }).selectOption('en')
  await monitor.getByRole('button', { name: 'Close panel', exact: true }).click()
  await monitor.getByRole('tab', { name: 'Network', exact: true }).waitFor()
  await monitor.getByRole('cell', { name: '127.0.0.1:5151', exact: true }).waitFor()
  assert.equal(fixture.stats.starts.length, starts); assert.equal(fixture.stats.closes.length, closes)
  await monitor.screenshot({ path: join(screenshots, 'task-manager-en.png') })
  await monitor.close(); await fixture.close(); fixture = undefined
  fixture = await automationFixture()
  vnc = await mockVnc()
  const catalog = fixture.ctx.storage.snapshot()
  catalog.snapshot.servers.push({ id: 'desktop', name: 'Fixture desktop', host: '127.0.0.1', groupId: '', tags: [], note: '', favorite: false, connections: [{ id: 'vnc', name: 'VNC', type: 'vnc', port: vnc.port }] })
  fixture.ctx.storage.replace(catalog.snapshot, catalog.revision)
  const terminal = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await terminal.goto(fixture.origin)
  await terminal.getByRole('button', { name: 'Fixture alpha SSH', exact: true }).click()
  const status = terminal.locator('.terminal-status [role="status"]')
  await waitFor(async () => (await status.innerText()).trim() === '已连接')
  const terminalNode = await terminal.locator('.xterm').elementHandle(), connectionCount = fixture.stats.connections, shellCount = fixture.stats.shells
  await terminal.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await terminal.getByLabel('界面语言', { exact: true }).selectOption('en')
  await terminal.getByRole('button', { name: 'Close panel', exact: true }).click()
  await waitFor(async () => (await status.innerText()).trim() === 'Connected')
  assert.equal(await terminalNode.evaluate(node => node === document.querySelector('.xterm')), true)
  await terminal.locator('.xterm-helper-textarea').focus(); await terminal.keyboard.type('language-keeps-shell')
  await waitFor(() => fixture.stats.inputs.join('').includes('language-keeps-shell'))
  assert.equal(fixture.stats.connections, connectionCount); assert.equal(fixture.stats.shells, shellCount)
  await terminal.screenshot({ path: join(screenshots, 'ssh-en.png') })
  await terminal.getByRole('tab', { name: /Server directory/ }).click()
  await terminal.getByRole('button', { name: 'Fixture desktop VNC', exact: true }).click()
  const desktop = terminal.locator('.desktop-pane'), desktopStatus = desktop.locator('[role="status"]')
  await waitFor(async () => (await desktopStatus.innerText()).trim() === 'Connected')
  const canvas = await desktop.locator('canvas').elementHandle(), desktops = vnc.events.filter(event => event[0] === 'connection').length
  await terminal.getByRole('button', { name: 'Open appearance settings', exact: true }).click()
  await terminal.getByLabel('Display language', { exact: true }).selectOption('zh-CN')
  await terminal.getByRole('button', { name: '关闭面板', exact: true }).click()
  await waitFor(async () => (await desktopStatus.innerText()).trim() === '已连接')
  assert.equal(await canvas.evaluate(node => node === document.querySelector('.desktop-pane canvas')), true)
  assert.equal(vnc.events.filter(event => event[0] === 'connection').length, desktops)
  for (const socket of vnc.sockets) socket.destroy()
  await waitFor(async () => !(await desktopStatus.innerText()).includes('已连接'))
  console.log('PASS: Chinese default, English switch, plugin-owned rule text, retained views and drafts, disabled settings, preference persistence, narrow layout, and unchanged monitor, SSH and VNC connections. Screenshots: ' + screenshots)
} finally { await browser?.close(); await fixture?.close(); await vnc?.close() }
