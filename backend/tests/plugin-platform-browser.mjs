import assert from 'node:assert/strict'
import { mkdir, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { platformFixture } from './plugin-platform-fixture.mjs'

const fixture = await platformFixture(); let browser
const screenshots = resolve('../docs/design/screenshots')
await mkdir(screenshots, { recursive: true })
try {
  await fixture.install('source'); await fixture.install('client')
  let executablePath
  for (const file of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) try { await access(file); executablePath = file; break } catch {}
  if (!executablePath) throw new Error('Browser unavailable')
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10000)
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${fixture.port}/#plugins`)
  await page.getByRole('heading', { name: '已安装的插件', exact: true }).waitFor()
  await page.getByRole('button', { name: '协作计数器设置', exact: true }).waitFor()
  await page.screenshot({ path: join(screenshots, 'plugin-installed-overview.png'), fullPage: true })
  await page.getByRole('button', { name: '协作计数器设置', exact: true }).click()
  await page.getByLabel('计数器标题', { exact: true }).fill('同一份设置草稿')
  await page.getByRole('button', { name: '协作计数器', exact: true }).click()
  await page.getByRole('button', { name: '计数器设置', exact: true }).click()
  assert.equal(await page.getByLabel('计数器标题', { exact: true }).inputValue(), '同一份设置草稿')
  assert.equal(await page.getByRole('tab', { name: /协作计数器 · 设置/ }).count(), 1)
  await page.getByRole('button', { name: '关闭插件页面 协作计数器 · 设置', exact: true }).click()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('配置已保存并生效。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '字体与外观', exact: true }).click()
  const range = page.getByRole('slider', { name: '协作计数器 · 当前计数 字号', exact: true })
  await range.fill('38'); await range.dispatchEvent('input')
  await page.screenshot({ path: join(screenshots, 'plugin-settings-fonts.png'), fullPage: true })
  await page.getByRole('button', { name: '协作计数器', exact: true }).click()
  assert.equal(await page.locator('.collaboration-example > p').first().evaluate(element => getComputedStyle(element).fontSize), '38px')
  await page.getByRole('button', { name: '协作观察器', exact: true }).click()
  await page.getByRole('button', { name: '通过另一插件 +1', exact: true }).click()
  await page.getByText(/来自 example.collaboration-source · 版本 1/).waitFor()
  assert.equal(await page.locator('.collaboration-example:visible > p').first().textContent(), '1')
  await page.getByRole('button', { name: '插件中心', exact: true }).click()
  await page.getByRole('button', { name: '停用 协作计数器', exact: true }).click()
  await page.getByRole('button', { name: '启用 协作计数器', exact: true }).waitFor()
  await page.getByRole('button', { name: '协作计数器设置', exact: true }).click()
  await page.getByRole('button', { name: '重新读取插件配置', exact: true }).click()
  await page.getByText('插件已停用。保存配置不会启用插件。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '功能设置', exact: true }).click()
  await page.getByLabel('计数器标题', { exact: true }).fill('停用时修改')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('配置已保存；插件保持停用。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '插件中心', exact: true }).click()
  await page.getByRole('button', { name: '卸载 协作计数器', exact: true }).click()
  await page.getByRole('button', { name: '确认卸载', exact: true }).click()
  await page.getByRole('button', { name: '关闭插件详情', exact: true }).click()
  await page.getByRole('heading', { name: '已安装的插件', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="协作计数器设置"]'))
  assert.equal(await page.getByRole('tab', { name: /协作计数器 · 设置/ }).count(), 0)
  await page.getByRole('button', { name: '协作观察器设置', exact: true }).click()
  await page.getByRole('button', { name: '字体与外观', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(screenshots, 'plugin-settings-mobile.png'), fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No viewport overflow')
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByRole('button', { name: /夜航/ }).click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  await page.screenshot({ path: join(screenshots, 'plugin-settings-dark.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('PASS: independent tools, shared settings draft, dirty guard, fonts applied, service call, disabled settings, uninstall cleanup, narrow layout; screenshots saved.')
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: join(screenshots, 'plugin-platform-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(-6000)) } }
  throw error
} finally { await browser?.close(); await fixture.close() }
