// Browser acceptance with isolated local data and a local Git mirror. No real server credentials.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { chromium } from 'playwright-core'
import { createApp } from '../src/app.ts'
import { runFile } from '../src/plugin-system/git.ts'

const root=await mkdtemp(join(tmpdir(),'webnav-market-browser-')),repo=join(root,'repo'),data=join(root,'data')
const screenshots=resolve(process.env.WEBNAV_PLUGIN_SCREENSHOTS??'../docs/design/screenshots')
await mkdir(screenshots,{recursive:true})
const sample=resolve('../examples/plugins/midnight-themes'),url='https://example.invalid/midnight.git'
await cp(sample,repo,{recursive:true});await runFile('git',['init'],repo);await runFile('git',['add','.'],repo);await runFile('git',['-c','user.name=WebNav Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],repo)
const manifest=JSON.parse(await readFile(join(repo,'webnav.plugin.json'),'utf8'))
const themeRepo=join(root,'theme-repo'),themeUrl='https://example.invalid/deep-sea.git'
await cp(resolve('../examples/plugins/deep-sea-theme'),themeRepo,{recursive:true});await runFile('git',['init'],themeRepo);await runFile('git',['add','.'],themeRepo);await runFile('git',['-c','user.name=WebNav Test','-c','user.email=test@example.invalid','commit','-qm','theme fixture'],themeRepo)
const themeManifest=JSON.parse(await readFile(join(themeRepo,'webnav.plugin.json'),'utf8'))
const net=createServer();net.listen(0,'127.0.0.1');await once(net,'listening');const port=net.address().port;await new Promise(r=>net.close(r))
const config={directory:data,port,frontendRoot:resolve('../frontend/dist')}
let ctx,browser,page,observer
const observerEvents=[]
async function start(){
  ctx=await createApp(config)
  const manager=ctx.plugins.manager,originalFetch=manager.fetch.bind(manager),market=manager.market.bind(manager)
  manager.fetch=async(repository,ref)=>{
    if(repository!==url&&repository!==themeUrl)return originalFetch(repository,ref)
    const target=join(manager.root,'repositories',createHash('sha256').update(repository).digest('hex'));await mkdir(target,{recursive:true});await runFile('git',['init','--bare',target],target);await runFile('git',['fetch','--depth=1',repository===url?repo:themeRepo,ref],target);return (await runFile('git',['rev-parse','FETCH_HEAD'],target)).trim()
  }
  manager.market=async refresh=>{const result=await market(refresh);assert.equal(result.error,undefined,'Published market must be readable');return {...result,index:{schemaVersion:1,plugins:[[manifest,url],[themeManifest,themeUrl]].map(([m,repository])=>({id:m.id,name:m.name,description:m.description,repository,ref:'HEAD',publisher:'community',category:m.category,secondaryCategories:m.secondaryCategories,platforms:m.platforms}))}}}
}
try {
  await start()
  let executablePath
  for(const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']){try{await access(candidate);executablePath=candidate;break}catch{}}
  if(!executablePath)throw new Error('Browser acceptance requires an installed Edge or Chrome')
  browser=await chromium.launch({executablePath,headless:true})
  const browserContext=await browser.newContext({viewport:{width:1440,height:1050}})
  browserContext.setDefaultTimeout(15000)
  page=await browserContext.newPage();const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/#plugins`)
  await page.getByRole('heading',{name:'你的工作台，自由扩展。'}).waitFor()
  await page.getByRole('heading',{name:'午夜配色示例',exact:true}).waitFor({timeout:30000})
  observer=await page.context().newPage()
  observer.on('websocket',ws=>ws.on('framereceived',frame=>{try{const message=JSON.parse(String(frame.payload));if(message.event==='plugins.changed')observerEvents.push({subscriptionId:message.subscriptionId,revision:message.revision})}catch{}}))
  await observer.goto(`http://127.0.0.1:${port}/#plugins`)
  await observer.getByRole('heading',{name:'午夜配色示例',exact:true}).waitFor({timeout:30000})
  await observer.evaluate(()=>{window.marketPageIdentity='secondary'})
  assert.ok(await page.locator('.plugin-card').count()>=11)
  await page.waitForFunction(()=>document.querySelectorAll('.plugin-card img').length===document.querySelectorAll('.plugin-card').length)
  await page.screenshot({path:join(screenshots,'plugin-market.png'),fullPage:true})
  await page.getByRole('combobox',{name:'插件分类',exact:true}).selectOption('themes')
  await page.locator('.plugin-card').filter({has:page.getByRole('heading',{name:'深海主题',exact:true})}).click()
  await page.getByRole('button',{name:'读取安装说明',exact:true}).click()
  await page.getByRole('checkbox',{name:/我已阅读并理解/}).waitFor({timeout:30000});await page.getByRole('checkbox',{name:/我已阅读并理解/}).check()
  await page.getByRole('button',{name:'确认风险并安装'}).click()
  await page.getByRole('button',{name:'应用主题',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'应用主题',exact:true}).click()
  await page.getByText('主题已应用到当前浏览器，无需重启。可在右上角外观设置恢复默认。').waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--page')),'#eaf1f4')
  assert.equal(ctx.plugins.manager.registry.installed[0].enabled,false)
  await page.getByRole('button',{name:'关闭插件详情'}).click();await page.reload()
  await page.getByRole('heading',{name:'你的工作台，自由扩展。'}).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--page')),'#eaf1f4')
  await page.getByRole('button',{name:'发现插件',exact:true}).click();await page.getByRole('combobox',{name:'插件分类',exact:true}).selectOption('')
  await page.getByRole('textbox',{name:'搜索插件'}).fill('SSH 文件')
  assert.equal(await page.locator('.plugin-card').count(),1)
  await page.getByRole('textbox',{name:'搜索插件'}).fill('午夜')
  await page.evaluate(()=>{window.marketPageIdentity='unchanged'})
  const liveEpoch=ctx.transport.epoch
  await page.locator('.plugin-card').click()
  await page.getByRole('button',{name:'读取安装说明',exact:true}).click()
  await page.getByRole('heading',{name:'安装第三方插件前，请确认风险'}).waitFor({timeout:30000})
  const install=page.getByRole('button',{name:'确认风险并安装'})
  assert.equal(await install.isDisabled(),true)
  await page.screenshot({path:join(screenshots,'plugin-risk.png'),fullPage:true})
  await page.getByRole('checkbox',{name:/我已阅读并理解/}).check();await install.click()
  await page.getByText('安装完成。设置已生效，无需重启。 替换内置功能请选择“设为默认实现”。').waitFor({timeout:30000})
  await page.getByText(/正在运行：v1\.0\.0/).waitFor()
  await page.getByRole('button',{name:'检查更新',exact:true}).click()
  await page.getByRole('heading',{name:'已安装此提交，无需重复安装。'}).waitFor({timeout:30000})
  assert.equal(await page.getByRole('checkbox',{name:/我已阅读并理解/}).count(),0)
  await page.getByRole('button',{name:'返回详情',exact:true}).click()
  await writeFile(join(repo,'webnav.plugin.json'),JSON.stringify({...manifest,version:'1.0.1',install:[{command:'node',args:['-e','process.exit(0)']}]}))
  await runFile('git',['add','.'],repo);await runFile('git',['-c','user.name=WebNav Test','-c','user.email=test@example.invalid','commit','-qm','update fixture'],repo)
  await page.getByRole('button',{name:'检查更新',exact:true}).click()
  await page.getByText('安装步骤变化，请展开核对。',{exact:true}).waitFor({timeout:30000})
  await ctx.plugins.manager.change({id:manifest.id,action:'configure',config:{},expectedRevision:ctx.plugins.manager.registry.revision})
  await page.getByRole('alert').filter({hasText:'插件设置已变化'}).waitFor()
  assert.equal(await page.getByRole('checkbox',{name:/我已阅读并理解/}).isDisabled(),true)
  await page.getByRole('button',{name:'重新读取安装说明',exact:true}).click()
  await page.getByRole('checkbox',{name:/我已阅读并理解/}).check({timeout:30000})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.locator('.plugin-detail-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false)
  await page.screenshot({path:join(screenshots,'plugin-update-mobile.png'),fullPage:true})
  await page.getByRole('button',{name:'确认风险并更新',exact:true}).click()
  await page.getByText(/正在运行：v1\.0\.1/).waitFor({timeout:30000})
  await page.setViewportSize({width:1440,height:1050})
  await page.getByRole('button',{name:'设为默认实现',exact:true}).click()
  await page.getByText('设置已生效，无需重启。',{exact:true}).waitFor()
  await observer.locator('.plugin-card').filter({has:observer.getByRole('heading',{name:'午夜配色示例',exact:true})}).getByText(/^已启用/).waitFor()
  await observer.getByRole('button',{name:'全局设置',exact:true}).click()
  await observer.getByRole('button',{name:/终端配色 默认配色/}).click()
  await observer.getByText('午夜配色 · 独立插件视图。已有方案和入口引用继续保留。').waitFor()
  assert.equal(await observer.evaluate(()=>window.marketPageIdentity),'secondary')
  assert.ok(observerEvents.length>0,'other pages receive runtime notifications')
  await observer.close()
  await page.getByRole('button',{name:'关闭插件详情'}).click()
  await page.setViewportSize({width:390,height:844})
  await page.getByRole('textbox',{name:'搜索插件'}).fill('')
  await page.screenshot({path:join(screenshots,'plugin-market-mobile.png'),fullPage:true})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.setViewportSize({width:1440,height:1050})
  await page.getByRole('button',{name:'全局设置',exact:true}).waitFor();await page.getByRole('button',{name:'全局设置',exact:true}).click()
  await page.getByRole('button',{name:/终端配色 默认配色/}).click()
  await page.getByText('午夜配色 · 独立插件视图。已有方案和入口引用继续保留。').waitFor()
  assert.equal(await page.evaluate(()=>window.marketPageIdentity),'unchanged')
  assert.equal(ctx.transport.epoch,liveEpoch)
  await page.getByRole('button',{name:'关闭面板'}).click()
  await page.getByRole('textbox',{name:'搜索插件'}).fill('终端配色')
  await page.locator('.plugin-card').filter({has:page.getByRole('heading',{name:'终端配色',exact:true})}).click()
  await page.getByRole('button',{name:'使用内置实现'}).click()
  await page.getByText('设置已生效，无需重启。',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭插件详情'}).click()
  await page.getByRole('textbox',{name:'搜索插件'}).fill('WebNav 默认主题')
  await page.locator('.plugin-card').click();await page.getByRole('button',{name:'使用内置实现'}).click()
  await page.getByText('主题已应用到当前浏览器，无需重启。可在右上角外观设置恢复默认。').waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--page')),'#f3f5f2')
  assert.deepEqual(errors,[])
  console.log('Browser acceptance passed: update comparison, stale preview rejection and renewal, installed/running versions, source badges, cached icons, filtering, consent gate, Git installation, hot replacement without reload, restore, immediate themes, persisted appearance and 390px layout.')
} catch(error) {
  if(page)console.error('Browser state on failure:',page.url(),(await page.locator('body').innerText()).slice(0,4000))
  if(observer&&!observer.isClosed())console.error('Observer:',(await observer.locator('body').innerText()).slice(-4500),'Plugin notifications:',JSON.stringify(observerEvents).slice(0,6000))
  throw error
} finally {await browser?.close();await ctx?.stop();await rm(root,{recursive:true,force:true})}
