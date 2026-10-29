// Real keyboard + xterm, with isolated loopback SSH and application data.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { automationFixture, waitFor } from './automation-fixture.mjs'

const fixture = await automationFixture(); let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixture.origin)
  const pane = name => page.getByRole('region', { name: `终端 Fixture ${name} · SSH`, exact: true, includeHidden: true })
  const id = async name => (await pane(name).getAttribute('id')).slice('terminal-pane-'.length)
  const connected = async name => { await waitFor(async () => (await pane(name).locator('.terminal-status [role="status"]').innerText()).trim() === '已连接') }
  const hint = name => pane(name).getByText('按 Enter 重新连接', { exact: true })
  const currentSessions = () => fixture.ctx.sessions.sessions

  await page.getByRole('button', { name: 'Fixture alpha SSH', exact: true }).click()
  await connected('alpha')
  await page.keyboard.press('Enter')
  await waitFor(() => fixture.stats.inputs.includes('\r'))
  assert.equal(fixture.stats.connections, 1, 'Enter in a live terminal remains shell input')

  const original = await id('alpha')
  fixture.ctx.sessions.close(original, '连接或认证等待超时。')
  await hint('alpha').waitFor()
  assert.match(await pane('alpha').locator('.terminal-status').innerText(), /连接或认证等待超时/)
  await page.getByLabel('搜索服务器、IP 或标签').focus()
  await page.keyboard.press('Enter')
  assert.equal(fixture.stats.connections, 1, 'search Enter must not reconnect a terminal')
  const input = pane('alpha').locator('.xterm-helper-textarea')
  await input.focus()
  for (const event of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }]) {
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...event })
  }
  await page.waitForTimeout(150)
  assert.equal(fixture.stats.connections, 1, 'repeated, modified and composing Enter must not reconnect')
  const received = fixture.stats.inputs.length
  await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter')
  await connected('alpha')
  assert.notEqual(await id('alpha'), original)
  assert.equal(fixture.stats.connections, 2, 'held Enter creates only one replacement session')
  assert.equal(fixture.stats.inputs.length, received, 'reconnect key is never replayed as shell input')

  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: 'Fixture beta SSH', exact: true }).click()
  await connected('beta')
  const beta = await id('beta')
  fixture.ctx.sessions.close(await id('alpha'), 'SSH 连接或认证失败，请检查地址、用户名和认证信息。')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  assert.equal(fixture.stats.connections, 3, 'a hidden disconnected terminal must not capture another terminal input')
  await page.getByRole('tab', { name: /Fixture alpha · SSH/ }).click()
  await hint('alpha').waitFor()
  await page.keyboard.press('Enter'); await connected('alpha')
  assert.equal(await id('beta'), beta, 'reconnecting one terminal preserves its sibling')
  assert.ok(currentSessions().has(beta))

  const preserved=await id('alpha'),shellsBefore=fixture.stats.shells
  currentSessions().get(preserved).ws.terminate()
  await pane('alpha').getByText('按 Enter 恢复原会话',{exact:true}).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await waitFor(async () => { const bounds = await pane('alpha').locator('.terminal-status').boundingBox(); return bounds && bounds.width <= 390 })
  const bounds = await pane('alpha').locator('.terminal-status').boundingBox()
  assert.ok(bounds && bounds.width <= 390)
  assert.equal(await pane('alpha').locator('.terminal-status').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'narrow status keeps the reconnect hint inside the terminal')
  await page.keyboard.press('Enter'); await connected('alpha')
  assert.equal(await id('alpha'),preserved);assert.equal(fixture.stats.shells,shellsBefore)

  // Initial authentication failure must allow Enter before terminal.ready ever arrives.
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.getByRole('button', { name: '关闭终端 Fixture beta · SSH', exact: true }).click()
  const resolve = fixture.ctx.credentials.resolve.bind(fixture.ctx.credentials)
  let rejectAuthentication
  fixture.ctx.credentials.resolve = (serverId, connectionId) => serverId === 'beta' ? new Promise((_, reject) => { rejectAuthentication = reject }) : resolve(serverId, connectionId)
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: 'Fixture beta SSH', exact: true }).click()
  await waitFor(() => !!rejectAuthentication)
  const beforeFailure = fixture.stats.connections
  await page.keyboard.press('Enter')
  assert.equal(fixture.stats.connections, beforeFailure, 'Enter while connecting does not start another attempt')
  rejectAuthentication(new Error('Simulated authentication failure'))
  await hint('beta').waitFor()
  fixture.ctx.credentials.resolve = resolve
  await page.keyboard.press('Enter'); await connected('beta')
  assert.equal(fixture.stats.connections, beforeFailure + 1)
  assert.deepEqual(errors, [])
  await page.getByRole('button',{name:'关闭终端 Fixture alpha · SSH',exact:true}).click()
  await page.getByRole('button',{name:'关闭终端 Fixture beta · SSH',exact:true}).click()
  await page.close(); await waitFor(() => fixture.ctx.sessions.size === 0)
  console.log('Terminal reconnect browser: live input, timeout, focused target, modifiers/repeat/IME, abrupt close, initial failure, narrow layout and cleanup passed')
} catch(error) {
  for(const context of browser?.contexts()??[])for(const page of context.pages())console.error('Reconnect failure statuses:',await page.locator('.terminal-status').allTextContents())
  console.error('Reconnect fixture state:',[...fixture.ctx.sessions.sessions.values()].map(s=>({connected:s.connected,finished:s.finished,queued:s.queued,parsing:s.parsing,viewer:s.terminal?.viewer&&{sent:s.terminal.viewer.sent,ack:s.terminal.viewer.ack,bytes:s.terminal.viewer.bytes}})))
  throw error
} finally { await browser?.close(); await fixture.close() }
