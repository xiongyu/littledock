// Isolated mock SSH + real browser. Never opens a saved real target.
import assert from 'node:assert/strict'
import {access} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium} from 'playwright-core'
import {automationFixture,waitFor} from './automation-fixture.mjs'
const f=await automationFixture();let browser
try{
  let executablePath
  for(const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']){try{await access(path);executablePath=path;break}catch{}}
  browser=await chromium.launch({executablePath,headless:true})
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.goto(f.origin)
  await page.getByRole('button',{name:'全局设置',exact:true}).waitFor()
  await page.getByRole('button',{name:'全局设置',exact:true}).click()
  await page.getByRole('button',{name:/AI 接入 MCP/}).click()
  await page.getByRole('heading',{name:'AI 接入',exact:true}).waitFor()
  await page.getByRole('button',{name:'新增模板',exact:true}).click()
  await page.getByLabel('模板名称',{exact:true}).fill('浏览器验收模板')
  await page.getByRole('checkbox',{name:'读取文件',exact:true}).check()
  await page.getByRole('checkbox',{name:'Fixture alpha · SSH'}).check()
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.locator('.automation-row').filter({hasText:'浏览器验收模板'}).waitFor()
  await page.getByLabel('名称',{exact:true}).fill('Browser AI')
  await page.getByLabel('授权模板',{exact:true}).selectOption('work')
  await page.getByRole('button',{name:'生成 MCP 配置',exact:true}).click()
  await page.getByRole('textbox',{name:'MCP 配置'}).waitFor()
  assert.match(await page.getByRole('textbox',{name:'MCP 配置'}).inputValue(),/mcp-bridge/)
  // Do not save a screenshot containing a live pairing code.
  await page.getByRole('button',{name:'关闭面板',exact:true}).click()
  const client=f.enroll('Browser AI'),call=async(name,p)=>(await f.ctx.automation.call(client.id,name,p)).data
  const plan=await call('ssh_open',{serverId:'alpha',connectionId:'ssh',name:'AI 模拟任务'}),job=(await call('workbench_apply',{operationId:plan.operationId,ticket:plan.ticket})).result
  await page.getByRole('tab',{name:/AI 模拟任务/}).waitFor()
  assert.equal(await page.getByRole('tab',{name:/服务器目录/}).getAttribute('aria-selected'),'true','AI must not steal focus')
  await page.getByRole('tab',{name:/AI 模拟任务/}).click()
  await page.getByRole('button',{name:'解锁并人工接管',exact:true}).waitFor()
  await page.locator('.ai-terminal-pane .xterm-helper-textarea').focus();await page.keyboard.type('forbidden');await page.keyboard.press('Control+c')
  assert.ok(!f.stats.inputs.some(t=>t.includes('forbidden')))
  await page.getByRole('button',{name:'解锁并人工接管',exact:true}).click()
  await page.getByRole('button',{name:'锁定并交还 AI',exact:true}).waitFor()
  await new Promise(r=>setTimeout(r,250));const resizes=f.stats.resizes
  await new Promise(r=>setTimeout(r,300));assert.equal(f.stats.resizes,resizes,'unchanged size must not create a resize feedback loop')
  await page.keyboard.type('human-browser');await page.keyboard.press('Enter');await waitFor(()=>f.stats.inputs.join('').includes('human-browser'))
  await assert.rejects(call('ssh_input',{taskId:job.taskId,controlEpoch:1,seq:1,text:'late'}),{code:'CONTROL_CHANGED'})
  await page.getByRole('button',{name:'锁定并交还 AI',exact:true}).click()
  await page.getByRole('button',{name:'解锁并人工接管',exact:true}).waitFor()
  const state=await call('task_status',{taskId:job.taskId})
  await call('ssh_input',{taskId:job.taskId,controlEpoch:state.controlEpoch,seq:1,text:'AI-browser\r'})
  await waitFor(()=>f.stats.inputs.includes('AI-browser\r'))
  for(const v of f.ctx.automation.tasks.get(job.taskId).terminal.viewers.values())v.ws.close(1013,'test observer reconnect')
  await page.getByRole('button',{name:'重新查看',exact:true}).click()
  await page.getByRole('button',{name:'解锁并人工接管',exact:true}).waitFor();assert.equal(f.stats.connections,1)
  await page.screenshot({path:resolve('../docs/design/screenshots/mcp-ai-terminal.png')})
  await page.reload();await page.getByRole('tab',{name:/AI 模拟任务/}).click();await page.getByRole('button',{name:'解锁并人工接管',exact:true}).waitFor();assert.equal(f.stats.connections,1)
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve('../docs/design/screenshots/mcp-ai-terminal-mobile.png')})
  assert.ok(await page.locator('.workspace-tabs .ai-badge').isVisible())
  await call('task_finish',{taskId:job.taskId,outcome:'succeeded'});await waitFor(()=>f.ctx.sessions.size===0)
  await page.getByText('任务已结束，连接已释放。',{exact:false}).first().waitFor()
  assert.deepEqual(errors,[])
  console.log('AI settings, readonly input, takeover/return, same PTY reload, no focus stealing, automatic finish and 390px badge passed.')
}finally{await browser?.close();await f.close()}
