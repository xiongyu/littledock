import type { Context } from 'cordis'

export interface SessionCounts {ssh:number;rdp:number;vnc:number;local:number;adb:number;wdb:number}
export function parseSessionCounts(value:unknown):SessionCounts|undefined {
  if(!value||typeof value!=='object')return
  const p=value as Record<string,unknown>,result:SessionCounts={ssh:0,rdp:0,vnc:0,local:0,adb:0,wdb:0}
  for(const key of Object.keys(result) as (keyof SessionCounts)[]){const n=p[key];if(!Number.isSafeInteger(n)||Number(n)<0||Number(n)>8)return;result[key]=Number(n)}
  if(Object.values(result).reduce((a,b)=>a+b,0)>8)return
  return result
}
export function sessionSummary(counts?:SessionCounts) {
  if(!counts)return '正在读取连接状态'
  if(!Object.values(counts).some(Boolean))return '暂无运行'
  const labels=[`SSH ${counts.ssh}`,`RDP ${counts.rdp}`]
  for(const [key,label] of [['vnc','VNC'],['local','本地终端'],['adb','ADB'],['wdb','WDB']] as const)if(counts[key])labels.push(`${label} ${counts[key]}`)
  return labels.join(' · ')
}
/** Only counts cross the verified worker IPC; no names, hosts, output or credentials. */
export function reportSessions(ctx:Context) {
  let previous=''
  const report=()=>{
    if(!process.connected)return
    let counts:SessionCounts|null=null
    try{if(typeof ctx.sessions?.counts==='function'&&typeof ctx.desktops?.counts==='function'&&typeof ctx.deviceSessions?.counts==='function')counts=parseSessionCounts({...ctx.sessions.counts(),...ctx.desktops.counts(),...ctx.deviceSessions.counts()})??null}catch{/* An optional provider metric must not take down the host. */}
    const next=JSON.stringify(counts);if(next===previous)return;previous=next
    process.send?.({type:'sessions.counts',nonce:process.env.WEBNAV_WORKER_NONCE,counts},()=>{})
  }
  const timer=setInterval(report,1000);timer.unref();report();ctx.on('dispose',()=>clearInterval(timer))
}
