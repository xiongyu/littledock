// Isolated fixture only: no real collector, process actions or user data.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { taskManagerUiFixture } from './task-manager-ui-fixture.mjs'

const fixture = await taskManagerUiFixture(); let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) { try { await access(path); executablePath = path; break } catch {} }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const table = page.locator('table[data-resizable-columns="task-manager.processes"]')
  const widths = () => table.locator('th').evaluateAll(headers => headers.map(header => Math.round(header.getBoundingClientRect().width)))
  const checkContrast = async () => {
    await page.waitForTimeout(240) // Wait for the theme's control background transitions.
    const contrast = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d')
      const luminance = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
      }
      return [['.tm-summary-card>header small', '.tm-summary-card>header'], ['.tm-summary-card>strong', '.tm-summary-card'], ['.tm-table th button', '.tm-table th']].map(([text, background]) => {
        const a = luminance(getComputedStyle(document.querySelector(text)).color), b = luminance(getComputedStyle(document.querySelector(background)).backgroundColor)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      })
    })
    assert.ok(contrast.every(ratio => ratio >= 4.5), 'title, caption and body text remain readable: ' + contrast)
  }
  const resetScroll = () => page.evaluate(() => { for (const element of document.querySelectorAll('*')) if (element.scrollTop || element.scrollLeft) { element.scrollTop = 0; element.scrollLeft = 0 } document.activeElement?.blur() })
  const drag = async (grip, delta, cancel = false) => {
    await grip.scrollIntoViewIfNeeded()
    const box = await grip.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + delta, y, { steps: 8 })
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
  }
  await page.goto(fixture.origin)
  await page.getByRole('button', { name: '任务管理器', exact: true }).click()
  await page.getByRole('button', { name: 'node-fixture', exact: true }).waitFor()
  const initial = await widths()
  assert.deepEqual(initial.slice(0, 3), [246, 56, 64], 'compact columns must not stretch with the table')
  assert.equal(await table.getByRole('separator').count(), 6)
  const sorting = await table.locator('th').evaluateAll(headers => headers.map(header => header.getAttribute('aria-sort')))
  for (let index = 0; index < 6; index++) {
    const before = await widths()
    await drag(table.getByRole('separator').nth(index), 18)
    const after = await widths()
    assert.equal(after[index], before[index] + 18, `column ${index} can be dragged`)
    assert.deepEqual(after.filter((_, i) => i !== index), before.filter((_, i) => i !== index), 'resizing one column must not stretch its neighbours')
  }
  assert.deepEqual(await table.locator('th').evaluateAll(headers => headers.map(header => header.getAttribute('aria-sort'))), sorting, 'drag does not change sorting')
  const beforeCancel = await widths()
  await drag(table.getByRole('separator').first(), 80, true)
  assert.deepEqual(await widths(), beforeCancel, 'Escape cancels an active drag')
  await table.getByRole('separator').first().dblclick()
  assert.equal((await widths())[0], 246)
  const pid = table.getByRole('separator').nth(1)
  await pid.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft')
  assert.equal((await widths())[1], 52, 'minimum keeps PID readable')
  await page.keyboard.press('Shift+ArrowRight')
  assert.equal((await widths())[1], 76)
  await page.keyboard.press('Home')
  const customized = await widths()
  await page.getByRole('button', { name: '刷新进程', exact: true }).click()
  await table.getByRole('button', { name: '名称', exact: true }).click()
  assert.deepEqual(await widths(), customized, 'refresh and sort retain widths')
  await page.reload()
  const open = page.getByRole('button', { name: '任务管理器', exact: true })
  if (!await table.count()) await open.click()
  await page.getByRole('button', { name: 'node-fixture', exact: true }).waitFor()
  assert.deepEqual(await widths(), customized, 'widths survive page reload')
  await page.getByRole('button', { name: 'node-fixture', exact: true }).click()
  await page.getByRole('tab', { name: '网络', exact: true }).click()
  const details = page.locator('table[data-resizable-columns="task-manager.connections"]')
  await details.getByRole('cell', { name: '127.0.0.1:5151', exact: true }).waitFor()
  assert.equal(await details.getByRole('separator').count(), 4)
  await details.getByRole('separator').first().focus(); await page.keyboard.press('ArrowRight')
  assert.equal(await details.getByRole('separator').first().getAttribute('aria-valuenow'), '98')
  await page.getByRole('tab', { name: '线程', exact: true }).click()
  await page.getByRole('tab', { name: '网络', exact: true }).click()
  assert.equal(await details.getByRole('separator').first().getAttribute('aria-valuenow'), '98', 'diagnostic tabs restore their own widths')
  await page.getByRole('tab', { name: '历史', exact: true }).click()
  const historyTable = page.locator('table[data-resizable-columns="task-manager.history-processes"]')
  await historyTable.waitFor()
  assert.equal(await historyTable.getByRole('separator').count(), 6)
  await drag(historyTable.getByRole('separator').first(), 25)
  assert.equal(await historyTable.getByRole('separator').first().getAttribute('aria-valuenow'), '271')
  await page.locator('.tm-history-hardware>summary').click()
  const disks = page.locator('table[data-resizable-columns="task-manager.history-disks"]')
  await disks.waitFor()
  assert.equal(await disks.getByRole('separator').count(), 6)
  await disks.getByRole('separator').last().focus(); await page.keyboard.press('ArrowRight')
  assert.equal(await disks.getByRole('separator').last().getAttribute('aria-valuenow'), '188')
  await page.getByRole('tab', { name: '进程', exact: true }).click()
  // Restore compact defaults for the review screenshots, without clearing other preferences.
  for (const grip of await table.getByRole('separator').all()) { await grip.focus(); await page.keyboard.press('Home') }
  await page.locator('.tm-table-scroll').evaluate(element => { element.scrollLeft = 0 })
  await mkdir(resolve('../docs/design/screenshots'), { recursive: true })
  await resetScroll(); await checkContrast()
  await page.screenshot({ path: resolve('../docs/design/screenshots/task-manager-columns-light.png') })
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByRole('button', { name: '夜航 安静的深色', exact: true }).click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  await resetScroll(); await checkContrast()
  await page.screenshot({ path: resolve('../docs/design/screenshots/task-manager-columns-dark.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll stays inside each table')
  assert.deepEqual((await widths()).slice(0, 3), [246, 56, 64])
  const scroll = page.locator('.tm-table-scroll')
  assert.ok(await scroll.evaluate(element => element.scrollWidth > element.clientWidth))
  await drag(table.getByRole('separator').last(), -20)
  assert.equal((await widths()).at(-1), 90, 'last column is adjustable after scrolling on narrow screens')
  await scroll.evaluate(element => { element.scrollLeft = 0 })
  await resetScroll()
  await page.screenshot({ path: resolve('../docs/design/screenshots/task-manager-columns-mobile.png'), fullPage: true })
  assert.equal(fixture.stats.applies, 0)
  assert.deepEqual(errors, [])
  console.log('Task manager columns: compact defaults, all six drags, independent widths, keyboard/minimum/reset/cancel, reload, diagnostic remount, light/dark and 390px passed.')
} finally { await browser?.close(); await fixture.close() }
