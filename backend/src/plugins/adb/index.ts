import { Service, type Context } from 'cordis'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { builtinConnectionSettings } from '@webnav/shared'
import { AppError, integer, record } from '../../core/errors.ts'
import type { DeviceProvider } from '../device-sessions.ts'
import { scrcpyProvider } from './scrcpy.ts'

export type AdbRunner=(args:string[],signal:AbortSignal,maxBytes?:number)=>Promise<Buffer>
export async function adbExecutable(){
  const name=process.platform==='win32'?'adb.exe':'adb'
  const candidates=[process.env.WEBNAV_ADB_PATH,...[process.env.ANDROID_HOME,process.env.ANDROID_SDK_ROOT].filter(Boolean).map(root=>join(root!,'platform-tools',name)),...(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(path=>join(path,name))]
  for(const file of candidates)if(file&&isAbsolute(file)){try{await access(file);return file}catch{}}
  throw new AppError('ADB_MISSING','未找到 ADB。请安装 Android Platform Tools 并加入 PATH，或设置 WEBNAV_ADB_PATH 后重启小站。')
}
export const runAdb:AdbRunner=async(args,signal,maxBytes=64*1024)=>{
  const file=await adbExecutable()
  if(signal.aborted)throw new AppError('CANCELLED','ADB 操作已取消。')
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false})
    let length=0,done=false;const chunks:Buffer[]=[]
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);if(error){child.kill();reject(error)}else resolve(Buffer.concat(chunks,length))}
    const cancel=()=>finish(new AppError('CANCELLED','ADB 操作已取消。'))
    const timer=setTimeout(()=>finish(new AppError('ADB_TIMEOUT','ADB 超时，操作结果未知；请检查设备状态后再操作。')),10_000)
    signal.addEventListener('abort',cancel,{once:true})
    child.stdout.on('data',(bytes:Buffer)=>{length+=bytes.length;if(length>maxBytes)finish(new AppError('ADB_LIMIT','ADB 输出超过上限。'));else chunks.push(bytes)})
    child.stderr.resume() // Authentication/error text may contain device details; never log it.
    child.on('error',()=>finish(new AppError('ADB_FAILED','无法启动 ADB，请检查 Platform Tools。')))
    child.on('close',code=>finish(code===0?undefined:new AppError('ADB_FAILED','ADB 操作失败，请检查 USB 授权、设备在线状态和网络地址。')))
  })
}
export function parseAdbDevices(bytes:Buffer){
  return bytes.toString('utf8').split(/\r?\n/).slice(1).flatMap(line=>{
    const match=/^([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199})\s+(device|offline|unauthorized)\b(.*)$/.exec(line)
    return match?[{serial:match[1]!,state:match[2]!,model:/\bmodel:(\S+)/.exec(match[3]!)?.[1]?.replaceAll('_',' ')??''}]:[]
  }).slice(0,128)
}
export function adbProvider(run:AdbRunner=runAdb):DeviceProvider{return async({host,connection,signal,send,fail})=>{
  const settings=builtinConnectionSettings(connection),abort=new AbortController()
  const stop=()=>abort.abort();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop()
  let closed=false,timer:ReturnType<typeof setTimeout>|undefined,visible=true,control=false,width=0,height=0,pendingFrame:Buffer|undefined
  let chain=Promise.resolve(),queued=0
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);abort.abort();signal.removeEventListener('abort',stop);pendingFrame=undefined}
  try{
    let serial=settings.serial
    if(settings.transport==='tcp'){
      serial=`${host.includes(':')&&!host.startsWith('[')?'['+host+']':host}:${connection.port}`
      const reply=await run(['connect',serial],abort.signal)
      if(!/connected to/.test(reply.toString('utf8')))throw new AppError('ADB_CONNECT','无法连接网络 ADB，请先在设备上启用并授权调试；无线配对需先用 adb pair 完成。')
    }else if(!serial){
      const devices=parseAdbDevices(await run(['devices','-l'],abort.signal)).filter(item=>item.state==='device')
      if(devices.length!==1)throw new AppError('ADB_SELECT','请在连接设置中指定设备序列号；当前可用设备不是一台。')
      serial=devices[0]!.serial
    }
    const command=(args:string[],max?:number)=>run(['-s',serial,...args],abort.signal,max)
    if((await command(['get-state'])).toString().trim()!=='device')throw new AppError('ADB_OFFLINE','ADB 设备未在线或尚未授权。')
    send({type:'device.info',codec:'png',device:serial,fps:settings.fps})
    const capture=async()=>{
      if(closed)return
      try{
        if(visible){
          if(!pendingFrame){
            const frame=await command(['exec-out','screencap','-p'],16*1024*1024)
            if(frame.length<24||!frame.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new AppError('ADB_FRAME','设备没有返回有效 PNG 画面。')
            const w=frame.readUInt32BE(16),h=frame.readUInt32BE(20)
            if(w<1||h<1||w>8192||h>8192)throw new AppError('ADB_FRAME','设备画面尺寸超过支持范围。')
            if(w!==width||h!==height){width=w;height=h;send({type:'device.info',codec:'png',width,height})}
            pendingFrame=frame
          }
          if(send(pendingFrame))pendingFrame=undefined
        }
      }catch(error){if(!closed&&!signal.aborted)fail(error instanceof AppError?error.message:'ADB 画面获取失败。');close();return}
      timer=setTimeout(()=>void capture(),Math.round(1000/settings.fps))
    }
    timer=setTimeout(()=>void capture(),0)
    return {viewerVersion:1,close,input:async raw=>{
      const message=record(raw)
      if(message.type==='device.visible'){visible=message.visible===true;if(!visible){control=false;send({type:'device.control',enabled:false})}return}
      if(message.type==='device.control'){control=message.enabled===true;send({type:'device.control',enabled:control});return}
      if(message.type==='release_all'){control=false;send({type:'device.control',enabled:false});return}
      if(message.type==='device.release')return
      if(!control)throw new AppError('VIEW_ONLY','请先开启设备控制。')
      let args:string[]
      const x=(value:unknown)=>integer(value,0,width-1).toString(),y=(value:unknown)=>integer(value,0,height-1).toString()
      if(message.type==='adb.tap')args=['shell','input','tap',x(message.x),y(message.y)]
      else if(message.type==='adb.swipe')args=['shell','input','swipe',x(message.x),y(message.y),x(message.toX),y(message.toY),integer(message.duration??300,50,2000).toString()]
      else if(message.type==='adb.key'){
        const code=integer(message.code,0,300)
        if(![3,4,19,20,21,22,23,24,25,26,61,62,66,67,82,85,86,87,88,111,112,122,123,187,224].includes(code))throw new AppError('INVALID_ARGUMENT','不支持的安卓按键。')
        args=['shell','input','keyevent',String(code)]
      }else if(message.type==='adb.text'){
        if(typeof message.text!=='string'||!message.text.length||message.text.length>512||/[^\x20-\x7e]/.test(message.text))throw new AppError('INVALID_ARGUMENT','ADB 文字输入支持最多 512 个英文、数字和符号。')
        if(message.text.includes('%s'))throw new AppError('INVALID_ARGUMENT','ADB 无法原样输入 %s，请分段输入。')
        args=['shell','input','text',"'"+message.text.replaceAll(' ','%s').replaceAll("'","'\\''")+"'"]
      }else throw new AppError('INVALID_ARGUMENT','未知 ADB 输入。')
      if(queued>=8)throw new AppError('BUSY','ADB 操作队列已满，请稍后操作。')
      queued++
      const operation=chain.then(async()=>{if(closed||!control)throw new AppError('CANCELLED','设备控制已停止。');await command(args)})
      chain=operation.catch(()=>{});try{await operation}finally{queued--}
    }}
  }catch(error){close();throw error}
}}
export class AdbPlugin extends Service {
  static inject=['deviceSessions','connectors','plugins']
  constructor(ctx:Context){
    super(ctx,'adb',true)
    ctx.on('dispose',ctx.deviceSessions.register('adb',options=>builtinConnectionSettings(options.connection).mode==='screenshot'?adbProvider()(options):scrcpyProvider(options)))
    ctx.on('dispose',ctx.connectors.register('adb',(owner,server,connection)=>ctx.deviceSessions.create(owner,server,connection)))
    const name='plugin.builtin.adb.devices'
    ctx.plugins.rpc.set(name,{mutate:false,handler:async()=>({devices:parseAdbDevices(await runAdb(['devices','-l'],AbortSignal.timeout(10_000)))})})
    ctx.on('dispose',()=>{ctx.plugins.rpc.delete(name)})
  }
}
