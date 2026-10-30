// Real Edge + xterm and isolated loopback SSH. No saved target or user clipboard is used.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { automationFixture, waitFor } from './automation-fixture.mjs'

const fixture = await automationFixture(), marker = 'webnav.clipboard-permission-hint.v1'
let browser
const errors = []
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  async function createPage({ blockedStorage = false, english = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
    await context.addInitScript(({ blockedStorage, english }) => {
      if (english) localStorage.setItem('webnav.locale.v1', 'en')
      if (blockedStorage) {
        for (const method of ['getItem', 'setItem']) {
          const original = Storage.prototype[method]
          Storage.prototype[method] = function (key, ...args) {
            if (key === 'webnav.clipboard-permission-hint.v1') throw new DOMException('Unavailable', 'SecurityError')
            return original.call(this, key, ...args)
          }
        }
      }
      // Stub only clipboard data/permission outcomes. Browser focus, click activation, UI and SSH input are real.
      window.clipboardReads = []
      window.clipboardOutcome = 'text'
      Object.defineProperty(navigator.clipboard, 'readText', { value() {
        window.clipboardReads.push({ active: navigator.userActivation.isActive, focused: document.hasFocus() })
        if (window.clipboardOutcome === 'denied') return Promise.reject(new DOMException('Test denial', 'NotAllowedError'))
        if (window.clipboardOutcome === 'pending') return new Promise(resolve => { window.finishClipboard = resolve })
        return Promise.resolve('fixture clipboard 中文')
      } })
    }, { blockedStorage, english })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(fixture.origin)
    await page.getByRole('button', { name: 'Fixture alpha SSH', exact: true }).click()
    await waitFor(async () => (await page.locator('.terminal-status [role=status]').innerText()).trim() === (english ? 'Connected' : '已连接'))
    return page
  }
  const hint = page => page.getByRole('dialog', { name: '首次粘贴：允许剪贴板访问', exact: true })
  async function menuPaste(page, pane = page.locator('.terminal-pane').filter({ visible: true }), name = '粘贴 Ctrl Shift V') {
    await pane.locator('.terminal-canvas').click({ button: 'right', position: { x: 40, y: 60 } })
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const reads = page => page.evaluate(() => window.clipboardReads)
  const inputCount = () => fixture.stats.inputs.length
  async function expectPaste(page, before) {
    await waitFor(() => inputCount() === before + 1)
    assert.equal(fixture.stats.inputs.at(-1), 'fixture clipboard 中文')
    assert.equal(await hint(page).count(), 0)
    assert.ok((await reads(page)).every(read => read.active && read.focused), 'readText stays in a focused user gesture')
  }
  async function closePage(page) {
    const buttons = page.getByRole('button', { name: /^关闭终端 Fixture/ })
    while (await buttons.count()) await buttons.first().click()
    await page.context().close()
  }

  const page = await createPage()
  await menuPaste(page)
  await hint(page).waitFor()
  assert.deepEqual(await reads(page), [])
  assert.equal(inputCount(), 0, 'first hint does not read or send clipboard before continuing')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), marker), 'shown')
  assert.match(await hint(page).innerText(), /地址栏最左侧/)
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await hint(page).boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390)
  assert.equal(await hint(page).evaluate(el => el.scrollWidth <= el.clientWidth), true)
  await page.screenshot({ path: join(tmpdir(), 'littledock-clipboard-hint-mobile.png') })
  await hint(page).getByRole('button', { name: '知道了，继续粘贴', exact: true }).click()
  await expectPaste(page, 0)
  assert.equal((await reads(page)).length, 1)
  await page.setViewportSize({ width: 1280, height: 850 })

  let before = inputCount()
  await menuPaste(page); await expectPaste(page, before)
  const shells = fixture.stats.shells
  await page.reload()
  await waitFor(async () => (await page.locator('.terminal-status [role=status]').innerText()).trim() === '已连接')
  before = inputCount(); await menuPaste(page); await expectPaste(page, before)
  assert.equal(fixture.stats.shells, shells, 'refresh restores the existing shell')
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: 'Fixture beta SSH', exact: true }).click()
  const beta = page.getByRole('region', { name: '终端 Fixture beta · SSH', exact: true })
  await waitFor(async () => (await beta.locator('.terminal-status [role=status]').innerText()).trim() === '已连接')
  before = inputCount(); await menuPaste(page, beta); await expectPaste(page, before)

  await page.evaluate(() => { window.clipboardOutcome = 'denied' })
  before = inputCount(); await menuPaste(page, beta)
  await beta.getByText('无法读取剪贴板，请按 Ctrl+Shift+V 粘贴。', { exact: true }).waitFor()
  assert.equal(inputCount(), before); assert.equal(await hint(page).count(), 0)
  await page.evaluate(() => { window.clipboardOutcome = 'pending' })
  await menuPaste(page, beta)
  const betaId = (await beta.getAttribute('id')).slice('terminal-pane-'.length)
  fixture.ctx.sessions.close(betaId, 'Test disconnect')
  await beta.getByText('按 Enter 重新连接', { exact: true }).waitFor()
  await page.evaluate(() => window.finishClipboard('must not reach a disconnected terminal'))
  await page.waitForTimeout(100)
  assert.equal(inputCount(), before)

  const client = fixture.enroll('Clipboard test AI')
  const call = async (name, params) => (await fixture.ctx.automation.call(client.id, name, params)).data
  const plan = await call('ssh_open', { serverId: 'alpha', connectionId: 'ssh', name: 'Clipboard AI' })
  const job = (await call('workbench_apply', { operationId: plan.operationId, ticket: plan.ticket })).result
  await page.getByRole('tab', { name: /Clipboard AI/ }).click()
  await page.getByRole('button', { name: '解锁并人工接管', exact: true }).waitFor()
  const ai = page.locator('.ai-terminal-pane')
  await ai.locator('.terminal-canvas').click({ button: 'right', position: { x: 40, y: 60 } })
  assert.equal(await page.getByRole('menuitem', { name: '粘贴', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '解锁并人工接管', exact: true }).click()
  await page.getByRole('button', { name: '锁定并交还 AI', exact: true }).waitFor()
  await page.evaluate(() => { window.clipboardOutcome = 'text' })
  before = inputCount(); await menuPaste(page, ai, '粘贴'); await expectPaste(page, before)
  await page.getByRole('button', { name: '锁定并交还 AI', exact: true }).click()
  await call('task_finish', { taskId: job.taskId, outcome: 'succeeded' })
  assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes('fixture clipboard'), 'only hint state is stored')
  await closePage(page)

  const cancelled = await createPage()
  before = inputCount(); await menuPaste(cancelled); await hint(cancelled).waitFor()
  await cancelled.keyboard.press('Escape')
  assert.equal(inputCount(), before); assert.deepEqual(await reads(cancelled), [])
  await cancelled.reload()
  await waitFor(async () => (await cancelled.locator('.terminal-status [role=status]').innerText()).trim() === '已连接')
  await menuPaste(cancelled); await expectPaste(cancelled, before)
  await closePage(cancelled)

  const unavailable = await createPage({ blockedStorage: true })
  await menuPaste(unavailable); await hint(unavailable).waitFor()
  await hint(unavailable).getByRole('button', { name: '取消', exact: true }).click()
  before = inputCount(); await menuPaste(unavailable); await expectPaste(unavailable, before)
  await closePage(unavailable)

  const english = await createPage({ english: true })
  await menuPaste(english, undefined, 'Paste Ctrl Shift V')
  const englishHint = english.getByRole('dialog', { name: 'First paste: allow clipboard access', exact: true })
  await englishHint.waitFor()
  assert.match(await englishHint.innerText(), /far left/)
  await englishHint.getByRole('button', { name: 'Cancel', exact: true }).click()
  await english.context().close()
  assert.deepEqual(errors, [])
  console.log('Terminal clipboard browser: first hint, activation, narrow layout, paste, once across refresh/SSH/AI, cancel, denial, disconnect and storage fallback passed')
} finally {
  await browser?.close()
  await fixture.close()
}
