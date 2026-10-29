// Isolated browser acceptance. Storage is a local bare Git repository, never a user's cloud repository.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { createApp } from '../src/app.ts'
import { GitSyncRemote } from '../src/plugins/config-sync/git.ts'

const root=await mkdtemp(join(tmpdir(),'webnav-sync-browser-')),repo=join(root,'remote.git')
await mkdir(repo);execFileSync('git',['init','--bare',repo],{stdio:'ignore',windowsHide:true})
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r))
let ctx,browser
try {
  ctx=await createApp({directory:join(root,'data'),port,frontendRoot:resolve('../frontend/dist'),syncRemoteFactory:async(settings,token,signal)=>new GitSyncRemote(join(root,'git'),settings,token,signal,repo).initialize()})
  ctx.plugins.manager.market=async()=>({repository:'https://example.invalid/market.git',index:{schemaVersion:1,plugins:[]},fetchedAt:Date.now(),cached:false})
  ctx.storage.replace({schemaVersion:1,groups:[],servers:[{id:'demo',name:'同步验收服务器',host:'127.0.0.1',groupId:'',tags:[],note:'独立测试数据',favorite:false,connections:[{id:'ssh',name:'SSH',type:'ssh',port:22,username:'demo'}]}]},0)
  let executablePath
  for(const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']){try{await access(candidate);executablePath=candidate;break}catch{}}
  browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`);await page.getByRole('button',{name:'全局设置',exact:true}).click();await page.getByRole('button',{name:/配置同步 GitHub/}).click()
  await page.locator('#panel-title').filter({hasText:'配置同步'}).waitFor()
  await page.getByLabel('仓库地址',{exact:true}).fill('https://github.com/example/sync.git')
  await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('位置已保存。输入同步账号密码后即可预览。').waitFor()
  await page.getByLabel('使用方式').selectOption({label:'新建同步空间'})
  await page.getByLabel('自定义同步账号',{exact:true}).fill('验收账号')
  await page.getByLabel('同步密码',{exact:true}).fill('synthetic-browser-password')
  await page.getByLabel('再次输入同步密码',{exact:true}).fill('synthetic-browser-password')
  await page.getByRole('button',{name:'解锁并读取',exact:true}).click();await page.getByText('同步空间已解锁',{exact:true}).waitFor({timeout:30000})
  await page.getByRole('button',{name:'立即同步 / 预览差异',exact:true}).click();await page.getByRole('heading',{name:'首次同步预览'}).waitFor({timeout:30000})
  await page.getByRole('button',{name:'确认并同步',exact:true}).click();await page.getByText('配置同步完成。',{exact:true}).first().waitFor({timeout:60000})
  await page.getByRole('button',{name:'历史版本',exact:true}).click();await page.getByRole('button',{name:'选择恢复',exact:true}).first().waitFor({timeout:30000})
  await page.screenshot({path:resolve('../docs/design/screenshots/config-sync.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.equal(await page.locator('.sync-panel').evaluate(e=>e.scrollWidth>e.clientWidth),false)
  await page.screenshot({path:resolve('../docs/design/screenshots/config-sync-mobile.png'),fullPage:true})
  await page.getByRole('button',{name:'锁定',exact:true}).click();await page.getByText('同步空间未解锁',{exact:true}).waitFor()
  await page.getByLabel('自定义同步账号',{exact:true}).fill('验收账号');await page.getByLabel('同步密码',{exact:true}).fill('wrong-browser-password');await page.getByRole('button',{name:'解锁并读取',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'同步账号、密码不匹配'}).waitFor({timeout:30000});assert.equal(await page.getByLabel('同步密码',{exact:true}).inputValue(),'')
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();await page.goto(`http://127.0.0.1:${port}/#plugins`);await page.reload()
  await page.locator('.plugin-card').filter({has:page.getByRole('heading',{name:'配置同步',exact:true})}).click();await page.getByRole('button',{name:'打开配置同步',exact:true}).click()
  await page.locator('#panel-title').filter({hasText:'配置同步'}).waitFor();assert.deepEqual(errors,[])
  console.log('Browser acceptance passed: settings, encrypted sync, history, wrong password, plugin entry, 390px layout.')
} finally {await browser?.close();await ctx?.stop();await rm(root,{recursive:true,force:true})}
