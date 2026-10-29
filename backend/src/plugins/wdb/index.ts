import { Service, type Context } from 'cordis'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WebSocket, type RawData } from 'ws'
import { builtinConnectionSettings } from '@webnav/shared'
import { AppError, integer, record } from '../../core/errors.ts'
import type { DeviceProvider } from '../device-sessions.ts'

export function wdbRequest(base:URL,path:string,signal:AbortSignal,body?:Record<string,unknown>,cookie?:string):Promise<{status:number;body:Record<string,unknown>;cookie:string}>{
  return new Promise((resolve,reject)=>{
    const payload=body?JSON.stringify(body):undefined
    const request=(base.protocol==='https:'?httpsRequest:httpRequest)(new URL(path,base),{method:body?'POST':'GET',signal,headers:{Origin:base.origin,...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...(cookie?{Cookie:cookie}:{})}},response=>{
      let size=0;const chunks:Buffer[]=[]
      response.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size>128*1024){response.destroy();request.destroy();reject(new AppError('WDB_PROTOCOL','WDB 响应超过上限。'))}else chunks.push(bytes)})
      response.on('error',()=>reject(new AppError('WDB_NETWORK','WDB 响应中断。')))
      response.on('end',()=>{try{const value=record(JSON.parse(Buffer.concat(chunks).toString('utf8')));resolve({status:response.statusCode??0,body:value,cookie:(response.headers['set-cookie']??[]).map(value=>value.split(';')[0]).find(value=>value?.startsWith('wdb_session='))??''})}catch{reject(new AppError('WDB_PROTOCOL','目标未返回 WDB 网页协议，请检查端口（默认 27880）。'))}})
    })
    request.setTimeout(10_000,()=>request.destroy())
    request.on('error',()=>reject(new AppError('WDB_NETWORK','无法连接 WDB 网页服务，请检查端口、防火墙与 HTTPS 证书。')))
    request.end(payload)
  })
}
export function wdbInput(message:Record<string,unknown>):Record<string,unknown>{
  if(message.type==='release_all'||message.type==='device.release')return {type:'release_all'}
  if(message.type==='device.control'&&typeof message.enabled==='boolean')return {type:'set_control',enabled:message.enabled}
  if(message.type==='key'){
    const scan_code=integer(message.scan_code,1,127)
    if(scan_code===0x42)throw new AppError('RESERVED_KEY','F8 保留给 WDB 采集。')
    if(typeof message.down!=='boolean'||typeof message.extended!=='boolean')throw new AppError('INVALID_ARGUMENT','按键状态无效。')
    return {type:'key',scan_code,extended:message.extended,down:message.down}
  }
  if(message.type==='mouse_move'){
    if([message.x,message.y].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1))throw new AppError('INVALID_ARGUMENT','鼠标坐标无效。')
    return {type:'mouse_move',x:message.x,y:message.y}
  }
  if(message.type==='mouse_button'&&['left','middle','right'].includes(String(message.button))&&typeof message.down==='boolean')return {type:'mouse_button',button:message.button,down:message.down}
  if(message.type==='wheel')return {type:'wheel',delta:integer(message.delta,-1200,1200),horizontal:message.horizontal===true}
  throw new AppError('INVALID_ARGUMENT','不支持的 WDB 输入。')
}
export const connectWdb:DeviceProvider=async({host,connection,password,signal,send,fail})=>{
  if(!connection.username||!password)throw new AppError('WDB_CREDENTIALS','请先保存 WDB 网页管理员用户名和密码（与 Windows / AxisAuto 账号独立）。')
  const settings=builtinConnectionSettings(connection),base=new URL(`${settings.https?'https':'http'}://${host.includes(':')&&!host.startsWith('[')?'['+host+']':host}:${connection.port}/`)
  const login=await wdbRequest(base,'/api/login',signal,{username:connection.username,password});password=undefined
  if(login.status!==200||!login.cookie||typeof login.body.csrf_token!=='string')throw new AppError('WDB_AUTH',login.status===404?'这台 WDB 尚未初始化，请先在 WDB 网页设置管理员。':'WDB 网页登录失败，请检查独立的管理员账号密码。')
  const csrf=login.body.csrf_token
  if(!/^[a-zA-Z0-9_-]{16,256}$/.test(csrf))throw new AppError('WDB_PROTOCOL','WDB 会话返回格式不正确。')
  const status=await wdbRequest(base,'/api/status',signal,undefined,login.cookie)
  if(status.status!==200)throw new AppError('WDB_AUTH','WDB 登录已失效。')
  const runtime=status.body.runtime
  if(runtime&&typeof runtime==='object'&&'agent_mode' in runtime&&runtime.agent_mode==='management-only')throw new AppError('WDB_MODE','WDB 当前为“仅管理”模式，请在被控端切换为完整模式后重连。')
  let closed=false,controlEnabled=false,visible=true,queue:Buffer[]=[],queued=0
  const sockets:WebSocket[]=[]
  let timer:ReturnType<typeof setInterval>|undefined
  const close=()=>{
    if(closed)return;closed=true;clearInterval(timer);signal.removeEventListener('abort',close);queue=[];queued=0
    for(const socket of sockets){if(socket.readyState===WebSocket.OPEN)socket.close();else socket.terminate();const timeout=setTimeout(()=>socket.terminate(),1000);timeout.unref();socket.once('close',()=>clearTimeout(timeout))}
    login.cookie='';login.body={}
  }
  signal.addEventListener('abort',close,{once:true})
  if(signal.aborted){close();throw new AppError('CANCELLED','WDB 连接已取消。')}
  const controlSend=(message:Record<string,unknown>)=>{
    const socket=sockets[0]
    if(!socket||socket.readyState!==WebSocket.OPEN)throw new AppError('WDB_CLOSED','WDB 控制通道已断开。')
    if(socket.bufferedAmount>64*1024)throw new AppError('FLOW_CONTROL','WDB 输入超过缓冲上限。')
    socket.send(JSON.stringify(message))
  }
  const open=(channel:'control'|'video')=>new Promise<WebSocket>((resolve,reject)=>{
    const url=new URL(`/ws/${channel}`,base);url.protocol=base.protocol==='https:'?'wss:':'ws:';url.searchParams.set('csrf',csrf)
    const socket=new WebSocket(url,{headers:{Cookie:login.cookie,Origin:base.origin},handshakeTimeout:10_000,maxPayload:2*1024*1024,perMessageDeflate:false});sockets.push(socket)
    socket.on('error',()=>{reject(new AppError('WDB_CHANNEL','WDB 画面或控制通道连接失败。'));if(!closed){fail('WDB 网络连接中断。');close()}})
    socket.on('close',code=>{reject(new AppError('WDB_CLOSED','WDB 通道已关闭。'));if(!closed){fail(code===4001?'WDB 登录已被其他页面替换。':'WDB 连接已结束。');close()}})
    socket.once('open',()=>resolve(socket))
    socket.on('message',(raw:RawData,binary)=>{
      if(closed)return
      try{
        if(binary){
          if(channel!=='video')throw new Error('Unexpected binary')
          if(!visible)return
          const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer)
          if(bytes.length<12||bytes.readUInt32BE(8)!==bytes.length-12)throw new Error('Invalid frame')
          if(queued+bytes.length>4*1024*1024){fail('WDB 视频接收过慢，已停止连接，请重新打开。');close();return}
          queue.push(bytes);queued+=bytes.length
        }else{
          const message=record(JSON.parse(raw.toString()))
          if(message.type==='control_state'){
            controlEnabled=message.enabled===true;send({type:'device.control',enabled:controlEnabled})
            if(message.accepted===false)send({type:'device.notice',message:typeof message.reason==='string'?'WDB：'+message.reason.slice(0,240):'WDB 暂未允许控制，请检查被控端输入状态。'})
          }
          else if(message.type==='error')send({type:'device.notice',message:'WDB 拒绝了此操作，请检查是否允许控制或被 AxisAuto 占用。'})
          else if(message.type==='session_replaced'){fail('WDB 登录已被其他页面替换。');close()}
          else if(message.type==='stream_reset'){queue=[];queued=0;send({type:'device.reset'})}
          else if(message.type==='ready'||message.type==='video_info'){
            if(typeof message.width==='number'&&typeof message.height==='number')send({type:'device.info',codec:'h264',width:message.width,height:message.height})
          }
        }
      }catch{fail('WDB 视频或控制消息格式不正确。');close()}
    })
  })
  try{
    await open('control');await open('video')
    if(closed)throw new AppError('WDB_CLOSED','WDB 已断开。')
    send({type:'device.info',codec:'h264'})
    timer=setInterval(()=>{if(!queued||closed||!visible)return;const batch=Buffer.concat(queue,queued);if(send(batch)){queue=[];queued=0}},16)
    return {viewerVersion:1,close,input:message=>{
      if(message.type==='device.visible'){
        visible=message.visible===true
        if(!visible){queue=[];queued=0;controlEnabled=false;controlSend({type:'set_control',enabled:false})}
        else sockets[1]?.send(JSON.stringify({type:'request_keyframe'}))
        return
      }
      if(message.type==='device.keyframe'){sockets[1]?.send(JSON.stringify({type:'request_keyframe'}));return}
      const input=wdbInput(message)
      if(!['set_control','release_all'].includes(String(input.type))&&!controlEnabled)throw new AppError('VIEW_ONLY','请先开启 WDB 控制。')
      controlSend(input)
      if(message.type==='release_all'){controlEnabled=false;controlSend({type:'set_control',enabled:false})}
    }}
  }catch(error){close();throw error}
}
export class WdbPlugin extends Service {
  static inject=['deviceSessions','connectors']
  constructor(ctx:Context){super(ctx,'wdb',true);ctx.on('dispose',ctx.deviceSessions.register('wdb',connectWdb));ctx.on('dispose',ctx.connectors.register('wdb',(owner,server,connection)=>ctx.deviceSessions.create(owner,server,connection)))}
}
