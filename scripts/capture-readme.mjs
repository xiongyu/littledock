// Public README screenshots: only disposable data, generated names and loopback SSH.
import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoScreens, demoRdp, demoVnc } from './readme-demo-peers.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'backend/package.json'))
const { chromium } = require('playwright-core')
process.chdir(join(root, 'backend'))
const { taskManagerUiFixture, waitFor } = await import('../backend/tests/task-manager-ui-fixture.mjs')
const { adbProvider } = await import('../backend/src/plugins/adb/index.ts')
const output = join(root, 'docs/images')
await mkdir(output, { recursive: true })
let browser, fixture, rdpPeer, vncPeer, workspacePage
try {
  let executablePath
  for (const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(candidate); executablePath = candidate; break } catch {}
  }
  if (!executablePath) throw new Error('Install Edge or Chrome before capturing screenshots')
  browser = await chromium.launch({ executablePath, headless: true })
  console.log('Browser ready')
  const screens = await demoScreens(browser)
  rdpPeer = demoRdp(screens.rdp)
  vncPeer = await demoVnc(screens.vnc)
  const thumbnails = new Map()
  const examples = [
    { id: 'docs', name: '团队文档', title: '把知识放在一起', subtitle: '开发手册 · 部署指南 · 团队约定', accent: '#31584b', entries: ['开始使用', '项目架构', '常见问题'] },
    { id: 'status', name: '服务监控', title: '服务状态一览', subtitle: '演示面板 / 所有系统运行正常', accent: '#345e7d', entries: ['API 网关　正常', '数据库　正常', '任务队列　正常'] },
    { id: 'deploy', name: '发布中心', title: '从代码到交付', subtitle: '演示流水线 / main', accent: '#815e40', entries: ['构建　已完成', '检查　已通过', '发布　已就绪'] },
  ]
  const preview = await browser.newPage({ viewport: { width: 640, height: 360 } })
  for (const item of examples) {
    await preview.setContent(`<html lang="zh-CN"><style>*{box-sizing:border-box}body{margin:0;padding:30px;background:#f6f7f4;font:16px 'Segoe UI','Microsoft YaHei',sans-serif;color:#273a33}header{border-bottom:1px solid #dde4df;padding-bottom:18px;color:${item.accent};font-weight:700;letter-spacing:1px}h1{font-size:36px;margin:27px 0 9px}p{color:#697b71;margin:0 0 27px}.row{display:flex;gap:12px}.row span{flex:1;background:white;border:1px solid #e1e7e2;border-left:3px solid ${item.accent};padding:18px 12px;border-radius:6px;font-size:14px}small{position:absolute;right:30px;bottom:20px;color:#84948b}</style><header>${item.name} / LITTLEDOCK DEMO</header><h1>${item.title}</h1><p>${item.subtitle}</p><div class="row">${item.entries.map(text => `<span>${text}</span>`).join('')}</div><small>示例页面</small></html>`)
    await preview.evaluate(() => document.fonts.ready)
    thumbnails.set(`https://${item.id}.example.com/`, await preview.screenshot({ type: 'jpeg', quality: 85 }))
  }
  await preview.close()
  console.log('Demo website thumbnails ready')
  fixture = await taskManagerUiFixture({ disablePlugins: false, rdpEnabled: true, embeddedRdpLauncher: rdpPeer.launch, webCapture: async url => {
    const image = thumbnails.get(url)
    if (!image) throw new Error('Only the three demo websites may be captured')
    return image
  } })
  assert.equal(fixture.ctx.plugins.manager.registry.installed.length, 0)
  // This temporary app uses the real ADB PNG pipeline with a bounded synthetic runner.
  // The production provider and real adb executable are never invoked.
  assert.ok(fixture.ctx.deviceSessions.providers.has('adb'))
  fixture.ctx.deviceSessions.providers.set('adb', adbProvider(async args => {
    if (args.at(-1) === 'get-state') return Buffer.from('device\n')
    if (args.includes('screencap')) return screens.android
    throw new Error('Unexpected ADB request in read-only screenshot fixture')
  }))
  fixture.ctx.plugins.manager.market = async () => ({ repository: 'https://example.invalid/catalog.git', index: { schemaVersion: 1, plugins: [] }, fetchedAt: Date.now(), cached: true })
  console.log('Isolated backend ready')
  const original = fixture.ctx.storage.snapshot(), sshPort = original.snapshot.servers[0].connections[0].port
  const ssh = { id: 'ssh', type: 'ssh', name: 'SSH', port: 22, username: 'demo' }
  const web = { id: 'web', type: 'web', name: '管理页面', port: 443, url: 'https://console.example.com/' }
  const rdp = { id: 'rdp', type: 'rdp', name: '远程桌面', port: 3389, username: 'demo' }
  const vnc = { id: 'vnc', type: 'vnc', name: 'VNC', port: 5900 }
  const adb = { id: 'adb', type: 'adb', name: 'ADB', port: 5555, pluginSettings: { transport: 'usb', serial: 'demo-android', mode: 'screenshot', fps: 1 } }
  const groups = [{ id: 'dev', name: '开发与测试' }, { id: 'lab', name: '家庭实验室' }, { id: 'desktop', name: '桌面与设备' }]
  const rows = [
    ['alpha', '开发服务器', '192.0.2.10', 'dev', ['Linux', '开发'], [ssh, web]],
    ['beta', '预发布环境', '192.0.2.20', 'dev', ['Linux', '测试'], [ssh]],
    ['ci', '构建节点', '192.0.2.30', 'dev', ['CI', '构建'], [ssh, web]],
    ['nas', '家庭 NAS', '198.51.100.10', 'lab', ['存储', '备份'], [ssh, web]],
    ['media', '媒体中心', '198.51.100.20', 'lab', ['影音', '服务'], [ssh, web]],
    ['gateway', '实验室网关', '198.51.100.30', 'lab', ['网络'], [ssh, web]],
    ['windows', 'Windows 工作站', '203.0.113.10', 'desktop', ['Windows'], [rdp, ssh]],
    ['linux-desktop', 'Linux 桌面', '203.0.113.20', 'desktop', ['Linux', '桌面'], [vnc, ssh]],
    ['android', '安卓测试机', '203.0.113.30', 'desktop', ['Android', '设备'], [adb]],
  ]
  const servers = rows.map(([id, name, host, groupId, tags, connections]) => ({ id, name, host, groupId, tags, note: 'README 隔离演示数据', favorite: false, connections }))
  fixture.ctx.storage.replace({ schemaVersion: 1, groups, servers }, original.revision)
  for (const item of examples) fixture.ctx.webBookmarks.save({ bookmark: { id: item.id, name: item.name, url: `https://${item.id}.example.com/` }, expectedVersion: 0 })
  await waitFor(() => fixture.ctx.webBookmarks.snapshot().bookmarks.every(item => item.previewState === 'ready'))
  console.log('Demo catalog and bookmarks ready')
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light', deviceScaleFactor: 1 })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === fixture.origin || ['data:', 'blob:', 'about:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  await context.addInitScript(() => localStorage.setItem('webnav.workspace-layout', JSON.stringify({ navigationWidth: 232, systemOpen: true, systemWidth: 260, filesOpen: true, filesHeight: 260 })))
  const page = await context.newPage(), errors = []
  workspacePage = page
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.goto(fixture.origin)
  console.log('Workspace page loaded')
  await page.getByRole('button', { name: '全局设置', exact: true }).waitFor()
  await page.getByRole('button', { name: '卡片视图', exact: true }).click()
  async function capture(name) {
    console.log('Checking current brand for ' + name)
    await page.locator('.brand-mark').evaluate(image => image.decode())
    assert.equal(await page.locator('.brand-mark').evaluate(image => new URL(image.src).pathname), '/brand/littledock-otter.png')
    assert.equal(await page.locator('.brand-mark').evaluate(image => image.getBoundingClientRect().width), 72)
    assert.equal(await page.locator('.brand strong').innerText(), '小站')
    await page.waitForFunction(() => [...document.images].filter(image => {
      const box = image.getBoundingClientRect()
      return box.width && box.height && box.top < innerHeight && box.bottom > 0
    }).every(image => image.complete))
    await page.mouse.move(1430, 950)
    await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' })
    console.log('Captured ' + name + ' with current otter branding')
  }
  await page.waitForFunction(() => document.querySelectorAll('.web-bookmark-preview img').length === 3)
  await capture('overview')
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByRole('button', { name: /暮色归港/ }).click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  await capture('overview-dark')

  // Only these two catalog entries become connectable, and both point to our loopback mock.
  const current = fixture.ctx.storage.snapshot()
  for (const server of current.snapshot.servers.filter(server => ['alpha', 'beta'].includes(server.id))) {
    server.host = '127.0.0.1'
    server.connections = [{ ...ssh, port: sshPort, username: 'demo', terminalThemeId: server.id === 'beta' ? 'midnight' : 'graphite' }]
  }
  fixture.ctx.storage.replace(current.snapshot, current.revision); fixture.ctx.storage.notify()
  await mkdir(join(fixture.home, 'deploy'), { recursive: true })
  await mkdir(join(fixture.home, 'logs'), { recursive: true })
  await writeFile(join(fixture.home, 'deploy', 'app.env.example'), 'APP_NAME=demo\nAPP_PORT=8080\n')
  await page.getByRole('button', { name: '开发服务器 SSH', exact: true }).click()
  await waitFor(() => fixture.sshStats.shells === 1)
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: '预发布环境 SSH', exact: true }).click()
  await waitFor(() => fixture.sshStats.shells === 2)
  await page.getByRole('tab', { name: /开发服务器 · SSH/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '左右分屏', exact: true }).click()
  // With one eligible peer the product joins it immediately; no picker is shown.
  await page.locator('.terminal-split-handle').waitFor()
  assert.equal(await page.locator('.xterm:visible').count(), 2)
  await page.locator('.ssh-files-panel').waitFor()
  await page.getByRole('button', { name: 'README.md', exact: true }).waitFor()
  const transcripts = [
    ['\x1b[36;1mLittleDock / development\x1b[0m', 'Isolated demo session', '', '\x1b[32mdemo@devbox\x1b[0m ~/workspace $ ls', '\x1b[34mapi/    web/    deploy/    docs/\x1b[0m', 'README.md    compose.yaml', '', '\x1b[32mdemo@devbox\x1b[0m ~/workspace $ ./deploy/check.sh', '', '  \x1b[32mOK\x1b[0m  Configuration loaded', '  \x1b[32mOK\x1b[0m  Database connection', '  \x1b[32mOK\x1b[0m  Static assets ready', '  \x1b[32mOK\x1b[0m  Service health check', '', '\x1b[36mReady to deploy to staging.\x1b[0m', '', '\x1b[32mdemo@devbox\x1b[0m ~/workspace $ '],
    ['\x1b[36;1mLittleDock / staging\x1b[0m', 'Isolated demo session', '', '\x1b[32mdemo@staging\x1b[0m ~/services $ tail app.log', '', '09:41:02  \x1b[32mINFO\x1b[0m  Application started', '09:41:02  \x1b[32mINFO\x1b[0m  Configuration ready', '09:41:03  \x1b[32mINFO\x1b[0m  Worker pool online', '09:41:04  \x1b[32mINFO\x1b[0m  Scheduler ready', '09:41:08  \x1b[32mINFO\x1b[0m  GET /health  200', '09:41:12  \x1b[32mINFO\x1b[0m  GET /api     200', '09:41:16  \x1b[32mINFO\x1b[0m  Backup complete', '', '\x1b[32mdemo@staging\x1b[0m ~/services $ '],
  ]
  for (const [index, stream] of [...fixture.streams].entries()) stream.write('\x1b[2J\x1b[H' + transcripts[index].join('\r\n'))
  await page.waitForTimeout(700)
  await capture('ssh-workspace')
  await page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await page.getByRole('button', { name: /雾松 灰绿与松石/ }).click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()

  const desktopCatalog = fixture.ctx.storage.snapshot()
  const windows = desktopCatalog.snapshot.servers.find(server => server.id === 'windows')
  windows.host = '127.0.0.1'
  windows.connections = [{ ...rdp, rdpDisplay: { mode: 'windowed', width: 1280, height: 800 } }]
  const linux = desktopCatalog.snapshot.servers.find(server => server.id === 'linux-desktop')
  linux.host = '127.0.0.1'; linux.connections = [{ ...vnc, port: vncPeer.port }]
  fixture.ctx.storage.replace(desktopCatalog.snapshot, desktopCatalog.revision); fixture.ctx.storage.notify()
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: 'Windows 工作站 远程桌面', exact: true }).click()
  await page.locator('.desktop-pane:visible canvas:visible').first().waitFor()
  await page.waitForTimeout(500)
  assert.match(await page.locator('.desktop-pane:visible').innerText(), /已连接/)
  await capture('rdp-workspace')
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: 'Linux 桌面 VNC', exact: true }).click()
  await page.locator('.desktop-pane:visible canvas:visible').first().waitFor()
  await page.waitForTimeout(500)
  assert.match(await page.locator('.desktop-pane:visible').innerText(), /已连接/)
  await capture('vnc-workspace')
  await page.getByRole('tab', { name: /服务器目录/ }).click()
  await page.getByRole('button', { name: '安卓测试机 ADB', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.device-stage canvas')?.width === 432)
  await page.locator('.device-placeholder').waitFor({ state: 'hidden' })
  await capture('android-workspace')

  await page.getByRole('button', { name: '任务管理器', exact: true }).click()
  await page.getByRole('button', { name: 'node-fixture', exact: true }).waitFor()
  const monitor = fixture.monitors.get(fixture.stats.starts.at(-1))
  const names = ['node.exe', 'renderer.exe', 'database.exe', 'cache.exe', 'editor.exe', 'pwsh.exe', 'worker.exe', 'agent.exe']
  monitor.processes.forEach((process, index) => { process.name = names[index]; process.username = 'demo'; process.executable = 'C:/Demo/' + names[index] })
  await page.getByRole('button', { name: '刷新进程', exact: true }).click()
  await page.getByRole('button', { name: 'node.exe', exact: true }).click()
  await capture('task-manager')
  await page.getByRole('button', { name: '查看 CPU 性能', exact: true }).click()
  await page.getByRole('button', { name: '整机', exact: true }).click()
  for (let index = 0; index < 10; index++) {
    await page.getByRole('button', { name: '刷新进程', exact: true }).click()
    await page.waitForTimeout(250)
  }
  await capture('task-manager-performance')
  assert.equal(fixture.stats.installs, 0)
  assert.equal(fixture.stats.applies, 0)
  assert.equal(fixture.stats.recordingConfigurations.length, 0)
  await page.getByRole('button', { name: '插件中心', exact: true }).click()
  await page.locator('.plugin-card').first().waitFor()
  assert.equal(await page.locator('.plugin-market-logo').evaluate(image => new URL(image.src).pathname), '/brand/littledock-otter.png')
  assert.equal(await page.locator('.plugin-eyebrow').innerText(), 'LITTLEDOCK · EXTENSIONS')
  await capture('plugins')
  assert.deepEqual(errors, [])
} catch (error) {
  if (workspacePage) console.error('Visible workspace status:', await workspacePage.locator('.desktop-pane:visible, .device-pane:visible').allTextContents())
  console.error(error)
  throw error
} finally {
  await browser?.close()
  await fixture?.close()
  rdpPeer?.close()
  await vncPeer?.close()
}
