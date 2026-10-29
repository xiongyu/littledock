// Isolated bundled copies and mock collectors only. Never touches user plugins or real processes.
import assert from 'node:assert/strict'
import { access, cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { chromium } from 'playwright-core'
import { taskManagerUiFixture, waitFor } from './task-manager-ui-fixture.mjs'
const root = await mkdtemp(join(tmpdir(), 'webnav-ui-extensions-'))
let browser, fixture
try {
  for (const name of ['ui-extension-host','process-inspector']) await cp(resolve('../examples/plugins/' + name), join(root,name), { recursive: true })
  // A failing contributed view must be contained to that view.
  const file = join(root,'process-inspector','webnav.plugin.json'), manifest = JSON.parse(await readFile(file,'utf8'))
  manifest.contributes.uiItems.push({ id: 'broken', title: '错误隔离测试', target: { plugin: 'example.ui-extension-host', point: 'details', version: 1 } })
  const menuTargets = [['terminal','builtin.sessions','terminal'],['workspace','builtin.sessions','workspace'],['file','builtin.sshFiles','entry'],['ai','builtin.mcp','terminal']]
  for (const [id,plugin,point] of menuTargets) manifest.contributes.menuItems.push({ id, title:'测试 '+id, target:{plugin,point,version:1}, access:'read' })
  await writeFile(file,JSON.stringify(manifest))
  const entry = join(root,'process-inspector','ui/main.js')
  await writeFile(entry,(await readFile(entry,'utf8')).replace('const { h, ref } = api.vue', "api.ui.registerItem('broken', { component: { setup() { throw Error('fixture render failure') } } });\n" + menuTargets.map(([id])=>`api.menus.registerItem('${id}', { run(context) { globalThis.__fixtureMenuContext = context } });`).join('\n') + "\n  const { h, ref } = api.vue"))
  fixture = await taskManagerUiFixture({ disablePlugins: false, bundledPluginsDirectory: root })
  fixture.ctx.plugins.manager.market = async () => ({ repository: 'https://example.invalid/index.git', index: { schemaVersion: 1, plugins: [] }, fetchedAt: Date.now(), cached: true })
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']) { try { await access(path); executablePath = path; break } catch {} }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixture.origin)
  const button = name => page.getByRole('button', { name, exact: true })
  const menu = name => page.getByRole('menuitem', { name, exact: true })
  const row = name => page.locator('.tm-processes tbody tr').filter({ has: button(name) })
  const change = async (id,action) => { const manager = fixture.ctx.plugins.manager; await manager.change({ id, action, expectedRevision: manager.registry.revision }) }
  await button('任务管理器').click(); await button('node-fixture').waitFor()
  await row('node-fixture').click({ button: 'right' })
  const inspect = menu('打开扩展诊断 · 进程诊断示例')
  await inspect.waitFor(); assert.equal(await inspect.locator('small').innerText(), '进程诊断示例')
  await inspect.click()
  await page.locator('.example-process-inspector').waitFor()
  assert.match(await page.locator('.example-process-inspector').innerText(), /node-fixture · PID 120/)
  assert.equal(await page.getByRole('tab', { name: '扩展诊断 · 进程诊断示例', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(fixture.stats.details, 0, 'plugin tab must not trigger native detail requests')
  await button('database-fixture').click()
  await page.getByText('database-fixture · PID 122', { exact: true }).waitFor()
  const shots = resolve('../docs/design/screenshots'); await mkdir(shots,{recursive:true})
  await page.locator('.example-process-inspector').scrollIntoViewIfNeeded()
  assert.notEqual(await page.locator('.tm-details .plugin-ui-tabs').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(shots,'plugin-ui-process-extension.png'), fullPage:true })
  await row('database-fixture').click({ button:'right' }); await inspect.waitFor()
  await change('example.process-inspector','disable')
  await inspect.waitFor({state:'detached'}); await page.locator('.example-process-inspector').waitFor({state:'detached'})
  assert.equal(await page.getByRole('tab',{name:'概览',exact:true}).getAttribute('aria-selected'),'true')
  await page.keyboard.press('Escape')
  await change('example.process-inspector','enable')
  await page.getByRole('tab',{name:'扩展诊断 · 进程诊断示例',exact:true}).waitFor()
  // PID reuse closes the menu and removes stale detail context, even though the number is the same.
  await row('database-fixture').click({button:'right'}); await inspect.waitFor()
  const monitor = fixture.monitors.get(fixture.stats.starts.at(-1)), sequence = monitor.sequence
  monitor.processes.find(p=>p.pid===122).startedAt++
  await button('刷新进程').click(); await waitFor(()=>monitor.sequence>sequence)
  await page.getByRole('menu').waitFor({state:'detached'})
  await page.locator('.tm-inspector').waitFor({state:'detached'})
  // The same external contribution path also applies to existing workspace, terminal and file menus.
  await page.getByRole('tab',{name:/服务器目录/}).click()
  await button('Fixture alpha SSH').click()
  const terminal = page.getByRole('region',{name:'终端 Fixture alpha · SSH',exact:true})
  await waitFor(async()=> (await terminal.locator('.terminal-status [role=status]').innerText()).trim()==='已连接')
  await terminal.locator('.xterm-screen').click({button:'right',position:{x:30,y:20}})
  await menu('测试 terminal · 进程诊断示例').click()
  assert.deepEqual(Object.keys(await page.evaluate(()=>globalThis.__fixtureMenuContext)).sort(),['hasSelection','ready','sessionId'])
  await page.getByRole('tab',{name:/Fixture alpha · SSH/}).click({button:'right'})
  await menu('测试 workspace · 进程诊断示例').click()
  assert.equal(await page.evaluate(()=>globalThis.__fixtureMenuContext.protocol),'ssh')
  if (!await page.getByRole('region',{name:'远程文件',exact:true}).isVisible()) await button('切换文件栏').click()
  await waitFor(async()=> !(await button('刷新文件列表').isDisabled()))
  await page.getByRole('region',{name:'远程文件',exact:true}).click({button:'right',position:{x:20,y:12}})
  await menu('测试 file · 进程诊断示例').click()
  assert.equal(await page.evaluate(()=>typeof globalThis.__fixtureMenuContext.path),'string')
  const client=fixture.enroll('UI extension fixture'), call=async(name,params)=>(await fixture.ctx.automation.call(client.id,name,params)).data
  const plan=await call('ssh_open',{serverId:'alpha',connectionId:'ssh',name:'扩展菜单 AI 测试'}), job=(await call('workbench_apply',{operationId:plan.operationId,ticket:plan.ticket})).result
  await page.getByRole('tab',{name:/扩展菜单 AI 测试/}).click()
  await button('解锁并人工接管').waitFor()
  await page.locator('.ai-terminal-pane .xterm-screen').click({button:'right',position:{x:30,y:20}})
  await menu('测试 ai · 进程诊断示例').click()
  assert.equal(await page.evaluate(()=>globalThis.__fixtureMenuContext.writable),false)
  await call('task_finish',{taskId:job.taskId,outcome:'succeeded'})
  await button('界面扩展示例').click()
  await page.getByText('跨插件面板：example-item',{exact:true}).waitFor()
  await button('示例操作 0').click(); await button('示例操作 1').waitFor()
  await button('右键打开示例菜单').click({button:'right'})
  await menu('打开扩展详情 · 进程诊断示例').click()
  await page.getByText('另一个插件提供的标签内容',{exact:true}).waitFor()
  await page.getByRole('tab',{name:'错误隔离测试 · 进程诊断示例',exact:true}).click()
  await page.getByText('进程诊断示例 的扩展内容暂时不可用。',{exact:true}).waitFor()
  await page.getByRole('tab',{name:'扩展详情 · 进程诊断示例',exact:true}).click()
  await page.screenshot({path:join(shots,'plugin-ui-cross-plugin.png'),fullPage:true})
  await button('打开外观设置').click(); await button('夜航 安静的深色').click(); await button('关闭面板').click()
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark')
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:join(shots,'plugin-ui-mobile-dark.png'),fullPage:true})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no document overflow on narrow screen')
  await change('example.process-inspector','uninstall')
  await page.getByText('跨插件面板：example-item',{exact:true}).waitFor({state:'detached'})
  await button('示例操作 1').waitFor({state:'detached'})
  assert.equal(await page.getByRole('tab',{name:'默认标签',exact:true}).getAttribute('aria-selected'),'true')
  await change('example.ui-extension-host','disable')
  await button('界面扩展示例').waitFor({state:'detached'})
  assert.deepEqual(errors,[])
  assert.equal(fixture.stats.applies,0,'no process actions performed')
  console.log('Plugin UI: independent packages extend task-manager menus/tabs and third-party menus/tabs/panels/actions; exact process context, source labels, failure isolation, disable/re-enable/uninstall and dark/390px passed.')
} finally {
  await browser?.close(); await fixture?.close()
  if (!/^webnav-ui-extensions-[\w-]+$/.test(relative(tmpdir(),root))) throw Error('Unexpected fixture root')
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
