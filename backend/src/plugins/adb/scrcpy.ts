import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { builtinConnectionSettings } from '@webnav/shared'
import { AppError, integer } from '../../core/errors.ts'
import type { DeviceProvider } from '../device-sessions.ts'
import { adbExecutable, parseAdbDevices, runAdb } from './index.ts'
import { ScrcpyFrames, scrcpyClipboard, scrcpyKey, scrcpyScroll, scrcpyTouch } from './scrcpy-protocol.ts'
import { h264Size } from './h264-size.ts'

const VERSION='3.3.4',SHA256='8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e'
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
function connect(port:number,signal:AbortSignal):Promise<Socket>{return new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port,signal});socket.setNoDelay(true)
  const timer=setTimeout(()=>socket.destroy(new Error('timeout')),1000)
  socket.once('connect',()=>{clearTimeout(timer);socket.pause();resolve(socket)});socket.once('error',error=>{clearTimeout(timer);reject(error)})
})}
async function readExactly(socket:Socket,length:number,signal:AbortSignal){
  const result=Buffer.alloc(length);let offset=0
  return new Promise<Buffer>((resolve,reject)=>{
    const finish=(error?:Error)=>{clearTimeout(timer);socket.off('readable',read);socket.off('close',close);signal.removeEventListener('abort',close);error?reject(error):resolve(result)}
    const close=()=>finish(new AppError('SCRCPY_CLOSED','scrcpy 启动连接已中断。'))
    const timer=setTimeout(()=>finish(new AppError('SCRCPY_TIMEOUT','scrcpy 启动握手超时。')),10000)
    const read=()=>{while(offset<length){const chunk=socket.read(Math.min(length-offset,socket.readableLength));if(!chunk)break;(chunk as Buffer).copy(result,offset);offset+=chunk.length}if(offset===length)finish()}
    socket.on('readable',read);socket.once('close',close);signal.addEventListener('abort',close,{once:true});read()
  })
}
export const scrcpyProvider:DeviceProvider=async({host,connection,signal,send,fail})=>{
  const settings=builtinConnectionSettings(connection),abort=new AbortController(),scid=(randomBytes(4).readUInt32BE()&0x7fffffff).toString(16).padStart(8,'0')
  const remote=`/data/local/tmp/webnav-scrcpy-${scid}.jar`,server=fileURLToPath(new URL(`../../../plugins/builtin.adb/scrcpy/scrcpy-server-v${VERSION}.jar`,import.meta.url))
  let closed=false,serial=settings.serial,port=0,process:ChildProcess|undefined,video:Socket|undefined,control:Socket|undefined,timer:ReturnType<typeof setInterval>|undefined,enabled=false,visible=true,touch:{x:number;y:number}|undefined,width=0,height=0
  let queue:Buffer[]=[],queued=0,pressed=new Set<number>(),lastReset=0
  const write=(bytes:Buffer)=>{if(!control||control.destroyed)throw new AppError('SCRCPY_CLOSED','scrcpy 控制通道已断开。');if(control.writableLength>64*1024)throw new AppError('FLOW_CONTROL','scrcpy 输入过快。');control.write(bytes)}
  const release=(disable=true)=>{try{if(touch)write(scrcpyTouch(1,touch.x,touch.y,width,height));for(const code of pressed)write(scrcpyKey(code,false))}catch{}touch=undefined;pressed.clear();if(disable){enabled=false;send({type:'device.control',enabled:false})}}
  const removeForward=()=>{if(port)void runAdb(['-s',serial,'forward','--remove',`tcp:${port}`],AbortSignal.timeout(3000)).catch(()=>{})}
  const close=()=>{
    if(closed)return;release();closed=true;clearInterval(timer);signal.removeEventListener('abort',close);abort.abort();video?.destroy();control?.end();const held=control;const deadline=setTimeout(()=>held?.destroy(),200);deadline.unref();process?.kill();queue=[];queued=0
    removeForward()
    // Only this generated session path is removed; never affect other scrcpy clients.
    if(serial)void runAdb(['-s',serial,'shell','rm','-f',remote],AbortSignal.timeout(3000)).catch(()=>{})
  }
  signal.addEventListener('abort',close,{once:true});if(signal.aborted)close()
  try{
    const bytes=await readFile(server);if(createHash('sha256').update(bytes).digest('hex')!==SHA256)throw new AppError('SCRCPY_RUNTIME','附带的 scrcpy server 校验失败，请恢复官方插件文件。')
    if(settings.transport==='tcp'){
      serial=`${host.includes(':')&&!host.startsWith('[')?'['+host+']':host}:${connection.port}`
      if(!/connected to/.test((await runAdb(['connect',serial],abort.signal)).toString()))throw new AppError('ADB_CONNECT','网络 ADB 连接失败，请先完成调试配对。')
    }else if(!serial){const devices=parseAdbDevices(await runAdb(['devices','-l'],abort.signal)).filter(d=>d.state==='device');if(devices.length!==1)throw new AppError('ADB_SELECT','请指定唯一的已授权安卓设备。');serial=devices[0]!.serial}
    if((await runAdb(['-s',serial,'get-state'],abort.signal)).toString().trim()!=='device')throw new AppError('ADB_OFFLINE','设备未在线或未授权。')
    await runAdb(['-s',serial,'push',server,remote],abort.signal)
    port=Number((await runAdb(['-s',serial,'forward','tcp:0',`localabstract:scrcpy_${scid}`],abort.signal)).toString().trim())
    if(!Number.isInteger(port)||port<1024||port>65535)throw new AppError('SCRCPY_TUNNEL','无法建立本机会话转发。')
    if(closed){removeForward();abort.signal.throwIfAborted()}
    const args=['-s',serial,'shell',`CLASSPATH=${remote}`,'app_process','/','com.genymobile.scrcpy.Server',VERSION,`scid=${scid}`,'log_level=warn','video_codec=h264',`max_size=${settings.maxSize}`,`max_fps=${settings.maxFps}`,`video_bit_rate=${settings.bitRate*1000000}`,'tunnel_forward=true','audio=false','control=true','clipboard_autosync=false','send_device_meta=true','send_codec_meta=true','send_frame_meta=true','send_dummy_byte=true','stay_awake=false','power_off_on_close=false','cleanup=true']
    const executable=await adbExecutable();abort.signal.throwIfAborted()
    process=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false})
    let diagnostic='';const readDiagnostic=(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(-4096)};process.stdout?.on('data',readDiagnostic);process.stderr?.on('data',readDiagnostic)
    process.on('error',()=>{if(!closed){fail('无法启动 scrcpy server。');close()}})
    process.on('close',()=>{if(!closed){fail(/INJECT_EVENTS|SecurityException/.test(diagnostic)?'设备拒绝控制权限，请在开发者选项启用 USB 调试（安全设置）。':'scrcpy server 已停止。');close()}})
    for(let attempt=0;attempt<60&&!closed;attempt++){
      let candidate:Socket|undefined
      try{candidate=await connect(port,abort.signal);const dummy=await readExactly(candidate,1,abort.signal);if(dummy[0]!==0)throw new Error('dummy');video=candidate;break}catch{candidate?.destroy();if(!closed)await wait(100)}
    }
    if(!video||closed)throw new AppError('SCRCPY_START','scrcpy 启动失败，请检查设备授权与系统版本。')
    control=await connect(port,abort.signal);control.on('error',()=>{if(!closed){fail('scrcpy 控制通道断开。');close()}});control.on('data',()=>{});control.resume()
    const meta=await readExactly(video,76,abort.signal)
    if(meta.readUInt32BE(64)!==0x68323634)throw new AppError('SCRCPY_CODEC','设备未提供 H.264 视频。')
    width=meta.readUInt32BE(68);height=meta.readUInt32BE(72)
    if(width<1||height<1||width>8192||height>8192)throw new AppError('SCRCPY_SIZE','设备画面尺寸不正确。')
    send({type:'device.info',codec:'h264',mode:'scrcpy',width,height,maxFps:settings.maxFps,device:meta.subarray(0,64).toString('utf8').replace(/\0.*$/s,'')})
    const parser=new ScrcpyFrames()
    video.on('data',(data:Buffer)=>{try{parser.push(data,frame=>{
      if(frame.readBigUInt64BE(0)&(1n<<63n)){const size=h264Size(frame.subarray(12));if(size&&(size.width!==width||size.height!==height)){release();width=size.width;height=size.height;send({type:'device.info',codec:'h264',mode:'scrcpy',width,height})}}
      if(!visible||closed)return
      if(queued+frame.length>4*1024*1024)throw new Error('backpressure')
      queue.push(frame);queued+=frame.length
    });if(queued>1024*1024)video?.pause()}catch{if(!closed){fail('scrcpy 视频超过接收上限。');close()}}})
    video.on('error',()=>{if(!closed){fail('scrcpy 视频通道异常。');close()}});video.on('close',()=>{if(!closed){fail('scrcpy 视频通道已结束。');close()}});video.resume()
    timer=setInterval(()=>{if(!closed&&visible&&queued){if(send(Buffer.concat(queue,queued))){queue=[];queued=0;video?.resume()}}},16)
    return {viewerVersion:1,close,input:message=>{
      if(message.type==='device.control'){if(message.enabled===true){enabled=true;send({type:'device.control',enabled:true})}else release();return}
      if(message.type==='release_all'){release();return}
      if(message.type==='device.release'){release(false);return}
      if(message.type==='device.visible'){visible=message.visible===true;if(!visible){release();queue=[];queued=0;video?.resume()}return}
      if(message.type==='device.keyframe'){if(Date.now()-lastReset>1000){lastReset=Date.now();queue=[];queued=0;write(Buffer.from([17]));video?.resume()}return}
      if(!enabled)throw new AppError('VIEW_ONLY','请先开启安卓控制。')
      if(message.type==='adb.touch'){
        // The decoded video size is supplied only for orientation validation; reject unknown sizes.
        const x=integer(message.x,0,width-1),y=integer(message.y,0,height-1),action=integer(message.action,0,2)
        if(action!==0&&!touch)return
        write(scrcpyTouch(action,x,y,width,height));touch=action===1?undefined:{x,y}
      }else if(message.type==='adb.key'){
        const code=integer(message.code,0,288)
        if(typeof message.down==='boolean'){write(scrcpyKey(code,message.down,integer(message.meta??0,0,0x7fffffff)));if(message.down)pressed.add(code);else pressed.delete(code)}
        else{write(scrcpyKey(code,true));write(scrcpyKey(code,false))}
      }else if(message.type==='adb.text')write(scrcpyClipboard(message.text))
      else if(message.type==='adb.scroll')write(scrcpyScroll(integer(message.x,0,width-1),integer(message.y,0,height-1),width,height,integer(message.delta,-1200,1200)))
      else throw new AppError('INVALID_ARGUMENT','不支持的 scrcpy 输入。')
    }}
  }catch(error){close();throw error}
}
