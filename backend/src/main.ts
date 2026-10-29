import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { startApplication } from './app-host.ts'
import { configuration } from './desktop/config.ts'
import { managedWorker } from './desktop/control.ts'
import { launch } from './desktop/launcher.ts'
import { workerUpdateControl } from './desktop/update-bridge.ts'
import { releaseInfo } from './desktop/update-files.ts'
if (!await managedWorker(configuration('start'))) {
  await launch('start', { console: true, sourceBackend: import.meta.url.endsWith('.ts') })
} else {
  const installedRelease=process.env.WEBNAV_INSTALL_ROOT?releaseInfo(JSON.parse(await readFile(new URL('../../release.json',import.meta.url),'utf8'))):undefined
  if(installedRelease&&installedRelease.version!==process.env.WEBNAV_RELEASE_VERSION)throw new Error('启动版本校验失败。')
  const port=Number(process.env.WEBNAV_PORT??3030)
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid WEBNAV_PORT')
  const directory=process.env.WEBNAV_DATA_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'WebNav')
  const root=resolve(fileURLToPath(new URL('../../frontend/dist/',import.meta.url)))
  const ctx=await startApplication({directory,port,frontendRoot:root,bundledPluginsDirectory:fileURLToPath(new URL('../../plugins/',import.meta.url)),...(process.env.WEBNAV_INSTALL_ROOT?{updateControl:workerUpdateControl()}:{}),...(process.env.WEBNAV_DEV==='1'?{devOrigin:'http://127.0.0.1:5173'}:{})})
  console.log(`WebNav: http://127.0.0.1:${port}/`)
  console.log(`数据目录：${directory}；已载入 ${ctx.status().serverCount ?? '未知'} 台服务器。`)
  let stopping=false
  function stop(){if(stopping)return;stopping=true;void ctx.stop().then(()=>{process.send?.({type:'stopped',nonce:process.env.WEBNAV_WORKER_NONCE},()=>process.exit(0));if(!process.send)process.exit(0)},()=>process.exit(1))}
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,stop)
  process.on('message',message=>{
    if(message==='shutdown')stop()
    if(!message||typeof message!=='object'||!('type' in message)||!('id' in message))return
    if(message.type==='update.prepare'){
      void ctx.prepareUpdate('interrupt' in message&&message.interrupt===true).then(activity=>process.send?.({type:'update.activity',id:message.id,activity}),()=>process.send?.({type:'update.activity',id:message.id,activity:{requests:1,blocking:['插件线程无响应，无法确认收尾'],connections:[]}}))
    }else if(message.type==='update.resume'){void ctx.resumeUpdate().then(activity=>process.send?.({type:'update.activity',id:message.id,activity}),()=>{})}
  })
  if(process.send)process.on('disconnect',stop)
  process.send?.({type:'ready',nonce:process.env.WEBNAV_WORKER_NONCE,version:installedRelease?.version})

}
