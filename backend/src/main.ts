import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
const port=Number(process.env.WEBNAV_PORT??3030)
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid WEBNAV_PORT')
const directory=process.env.WEBNAV_DATA_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'.local','share'),'WebNav')
const root=resolve(fileURLToPath(new URL('../../frontend/dist/',import.meta.url)))
const ctx=await createApp({directory,port,frontendRoot:root,...(process.env.WEBNAV_DEV==='1'?{devOrigin:'http://127.0.0.1:5173'}:{})})
console.log(`WebNav: http://127.0.0.1:${port}/`)
console.log(`数据目录：${directory}；已载入 ${ctx.storage.snapshot().snapshot.servers.length} 台服务器。`)
let stopping=false
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(stopping)return;stopping=true;void ctx.stop().then(()=>process.exit(0))})
