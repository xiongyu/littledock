// Mock collector / process actions only; no real system process is modified.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { taskManagerUiFixture, waitFor } from './task-manager-ui-fixture.mjs'
const fixture = await taskManagerUiFixture(); let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']) { try { await access(path); executablePath=path; break } catch {} }
  browser=await chromium.launch({executablePath,headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']})
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(fixture.origin)
  const button=name=>page.getByRole('button',{name,exact:true}), check=(name,pid)=>page.getByRole('checkbox',{name:`勾选 ${name} PID ${pid}`,exact:true})
  await button('任务管理器').click();await button('node-fixture').waitFor()
  const monitor=fixture.monitors.get(fixture.stats.starts.at(-1)), table=page.locator('.tm-processes tbody'), refresh=async()=>{const sequence=monitor.sequence;await button('刷新进程').click();await waitFor(()=>monitor.sequence>sequence);await page.waitForTimeout(80)}
  assert.equal(await table.locator('input[type=checkbox]').count(),8)
  await check('node-fixture',120).check();await check('database-fixture',122).check()
  assert.equal(await page.locator('.tm-inspector').count(),0,'checkboxes do not focus details')
  assert.equal(fixture.stats.commandLines,0,'no automatic all-process command line collection')
  assert.equal(await page.getByRole('checkbox',{name:'勾选当前页进程',exact:true}).evaluate(el=>el.indeterminate),true)
  await button('只看勾选进程').click();assert.equal(await table.locator('tr').count(),2)
  await page.locator('.tm-watch article').first().waitFor()
  const order=await table.locator('.tm-name-select').allTextContents(),nodeCard=page.locator('.tm-watch article').filter({hasText:'node-fixture'})
  monitor.processes.find(p=>p.pid===120).memoryBytes+=64*1024**2;monitor.processes.find(p=>p.pid===120).cpuPercent=0
  await refresh();assert.deepEqual(await table.locator('.tm-name-select').allTextContents(),order)
  assert.match(await nodeCard.innerText(),/\+64\.0 MiB/);assert.match(await nodeCard.innerText(),/0\.0%/)
  assert.ok(await nodeCard.locator('.primary-series').last().getAttribute('d'))
  await button('复制 PID').click();assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),'120\n122')
  await button('node-fixture').click();await page.locator('.tm-command-line pre').waitFor()
  assert.match(await page.locator('.tm-command-line pre').innerText(),/--title="two words 中文"/)
  await button('复制命令行').click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/node-fixture --port=9000/)
  const shots=resolve('../docs/design/screenshots');await mkdir(shots,{recursive:true})
  await page.locator('.tm-watch').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(shots,'task-manager-watch-light.png')})
  await page.locator('.tm-command-line').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(shots,'task-manager-command-line.png')})
  // A delayed command line response cannot reappear under another process.
  const release=fixture.delayCommand(),count=fixture.stats.commandLines
  await button('刷新启动参数').click();await waitFor(()=>fixture.stats.commandLines>count)
  await button('database-fixture').click();await waitFor(()=>fixture.stats.commandLines>count+1);release()
  await page.waitForTimeout(150);assert.match(await page.locator('.tm-command-line pre').innerText(),/^database-fixture/)
  fixture.commandMode('permission');await button('刷新启动参数').click();await page.getByText('当前用户没有读取此进程启动参数的权限。',{exact:true}).waitFor();assert.equal(await page.locator('.tm-command-line pre').count(),0)
  fixture.commandMode('ok')
  fixture.reusePid(monitor.state.id);await refresh()
  assert.match(await nodeCard.innerText(),/未采集/);assert.equal(await table.getByRole('button',{name:'reused-pid-fixture',exact:true}).count(),0)
  assert.equal(await check('node-fixture',120).isChecked(),true,'old identity remains observed as missing')
  await button('显示全部进程').click();await button('清空勾选').click()
  assert.equal(await table.locator('tr').count(),8)
  await page.getByRole('checkbox',{name:'勾选当前页进程',exact:true}).check();assert.equal(await table.locator('input:checked').count(),8)
  await page.getByRole('checkbox',{name:'勾选当前页进程',exact:true}).uncheck();assert.equal(await page.locator('.tm-multiselect').count(),0)
  await check('database-fixture',122).check();await check('cache-fixture',123).check()
  await button('强制结束勾选…').click();await button('确认强制结束 2 个进程').waitFor();assert.equal(fixture.stats.applies,0)
  await button('取消').click();assert.equal(fixture.stats.applies,0)
  await button('强制结束勾选…').click();await button('确认强制结束 2 个进程').click();await button('关闭').click();assert.equal(fixture.stats.applies,2)
  await button('清空勾选').click();await check('editor-fixture',124).check();await check('shell-fixture',125).check()
  fixture.failApply();await button('强制结束勾选…').click();await button('确认强制结束 2 个进程').click();await page.getByText('已停止后续操作，未自动重试。请刷新核对各进程。',{exact:true}).waitFor();assert.equal(fixture.stats.applies,3,'unknown first result stops remaining batch')
  await button('关闭').click();await button('只看勾选进程').click()
  await button('打开外观设置').click();await button('夜航 安静的深色').click();await button('关闭面板').click()
  await page.locator('.tm-watch').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(shots,'task-manager-watch-dark.png')})
  await page.setViewportSize({width:390,height:844});await page.locator('.tm-watch').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(shots,'task-manager-watch-mobile.png')})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await page.getByLabel('监控目标',{exact:true}).selectOption({label:'Fixture alpha · SSH · 127.0.0.1'})
  await page.getByRole('heading',{name:'核对 SSH 主机指纹',exact:true}).waitFor()
  assert.equal(await page.locator('.tm-watch').count(),0);assert.equal(await page.locator('.tm-multiselect').count(),0);assert.equal(await page.locator('.tm-command-line').count(),0)
  assert.deepEqual(errors,[])
  console.log('Task-manager multi-select: checkbox independence, watch-only stable order/charts/delta, copy, missing/reused PID, page selection, command-line/permission/stale replies, batch confirm/unknown stop, target cleanup, light/dark/390px passed.')
}finally{await browser?.close();await fixture.close()}
