import { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { AppError } from '../core/errors.ts'
import { DesktopSocketReader } from './desktop-socket.ts'
import type { DesktopStream } from '../core/desktop-stream.ts'

/** An RFB attachment bridge. Stateless encodings allow a new browser decoder without a new login. */
export async function persistentVnc(socket:Socket):Promise<DesktopStream>{
  const reader=new DesktopSocketReader(socket)
  let init:Buffer
  try{
    socket.write(Buffer.from([1]))
    const header=await reader.read(24),length=header.readUInt32BE(20)
    if(length>4096||!header.readUInt16BE(0)||!header.readUInt16BE(2)||header.readUInt16BE(0)>4096||header.readUInt16BE(2)>2160)throw new AppError('VNC_SIZE','VNC 画面尺寸或名称超出限制。')
    init=Buffer.concat([header,await reader.read(length)])
  }finally{reader.release()}
  // noVNC's full-colour format; the server and each new browser use the same byte order.
  const format=Buffer.from([32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0])
  format.copy(init,4);socket.write(Buffer.concat([Buffer.from([0,0,0,0]),format]))
  const encodings=Buffer.alloc(16);encodings[0]=2;encodings.writeUInt16BE(3,2)
  ;[0,-223,-239].forEach((n,i)=>encodings.writeInt32BE(n,4+i*4));socket.write(encodings)
  let viewing=true,initialized=false,generation=1,frameGeneration=0,input=Buffer.alloc(0),buffer=Buffer.alloc(0)
  let rectangles=0,remaining=0,rectangle=false,inFrame=false,outstanding=false,pendingRequest:Buffer|undefined,requestGeneration=0
  let mouse=Buffer.from([5,0,0,0,0,0]);const keys=new Set<number>()
  const output=(bytes:Buffer)=>{if(viewing&&initialized&&frameGeneration===generation&&!channel.push(bytes))socket.pause()}
  const request=()=>{if(!outstanding&&pendingRequest&&viewing&&initialized){outstanding=true;requestGeneration=generation;socket.write(pendingRequest);pendingRequest=undefined}}
  const finish=()=>{inFrame=false;outstanding=false;request()}
  const channel:DesktopStream=new Duplex({readableHighWaterMark:256*1024,
    read(){socket.resume()},
    write(bytes:Buffer,_encoding,done){
      try{
        input=Buffer.concat([input,bytes]);if(input.length>128*1024)throw new Error('VNC input limit')
        if(!initialized){if(!input.length){done();return}input=input.subarray(1);initialized=true;channel.push(init)}
        while(input.length){
          const type=input[0];let length=0
          if(type===0)length=20
          else if(type===2){if(input.length<4)break;length=4+input.readUInt16BE(2)*4;if(length>4096)throw new Error('VNC encodings limit')}
          else if(type===3)length=10
          else if(type===4)length=8
          else if(type===5)length=6
          else if(type===6){if(input.length<8)break;length=8+input.readUInt32BE(4);if(length>65544)throw new Error('VNC clipboard limit')}
          else throw new Error('Unsupported VNC input')
          if(input.length<length)break
          const message=Buffer.from(input.subarray(0,length));input=input.subarray(length)
          if(type===0){if(!message.subarray(4).equals(format))throw new Error('Unsupported VNC pixel format')}
          else if(type===2){/* Never negotiate a compression stream tied to a browser's lifetime. */}
          else if(type===3){pendingRequest=message;if(outstanding&&requestGeneration!==generation){message[1]=0;socket.write(message)}else request()}
          else {if(type===4){const key=message.readUInt32BE(4);if(message[1])keys.add(key);else keys.delete(key);if(keys.size>256)throw new Error('VNC key limit')}if(type===5)mouse=message;socket.write(message)}
        }
        done()
      }catch{done(new AppError('VNC_PROTOCOL','网页 VNC 输入无效。'))}
    },
    destroy(error,done){socket.destroy();buffer=Buffer.alloc(0);input=Buffer.alloc(0);keys.clear();done(error)},
  })
  channel.viewerVersion=1
  channel.setViewer=attached=>{
    viewing=false;generation++;initialized=false;input=Buffer.alloc(0);pendingRequest=undefined
    for(const key of keys){const up=Buffer.alloc(8);up[0]=4;up.writeUInt32BE(key,4);socket.write(up)}keys.clear();mouse[1]=0;socket.write(mouse)
    while(channel.read()!==null){/* Old display bytes cannot enter the next RFB handshake. */}
    viewing=attached;socket.resume()
  }
  socket.on('data',(bytes:Buffer)=>{
    try{
      buffer=Buffer.concat([buffer,bytes]);if(buffer.length>512*1024)throw new Error('VNC buffer limit')
      while(buffer.length){
        if(remaining){const n=Math.min(remaining,buffer.length);output(buffer.subarray(0,n));buffer=buffer.subarray(n);remaining-=n;if(remaining)break;if(rectangle){rectangle=false;if(!--rectangles)finish()}continue}
        if(inFrame){
          if(buffer.length<12)break
          const header=buffer.subarray(0,12),width=header.readUInt16BE(4),height=header.readUInt16BE(6),encoding=header.readInt32BE(8)
          if(width>4096||height>2160)throw new Error('VNC rectangle size')
          if(encoding===0)remaining=width*height*4
          else if(encoding===-239)remaining=width*height*4+Math.ceil(width/8)*height
          else if(encoding===-223){if(!width||!height)throw new Error('VNC desktop size');init.writeUInt16BE(width,0);init.writeUInt16BE(height,2)}
          else throw new Error('Unsupported VNC encoding')
          output(header);buffer=buffer.subarray(12);rectangle=remaining>0
          if(!remaining&&!--rectangles)finish()
          continue
        }
        const type=buffer[0]
        if(type===0){if(buffer.length<4)break;rectangles=buffer.readUInt16BE(2);if(rectangles>4096)throw new Error('VNC rectangles limit');frameGeneration=requestGeneration;output(buffer.subarray(0,4));buffer=buffer.subarray(4);inFrame=true;if(!rectangles)finish()}
        else if(type===2){frameGeneration=generation;output(buffer.subarray(0,1));buffer=buffer.subarray(1)}
        else if(type===3){if(buffer.length<8)break;remaining=buffer.readUInt32BE(4);if(remaining>65536)throw new Error('VNC clipboard limit');frameGeneration=generation;output(buffer.subarray(0,8));buffer=buffer.subarray(8)}
        else throw new Error('Unsupported VNC server message')
      }
    }catch{channel.destroy(new AppError('VNC_PROTOCOL','VNC 返回了无效或不支持的画面。'))}
  })
  socket.on('close',()=>channel.destroy());socket.on('error',()=>channel.destroy(new AppError('VNC_DISCONNECTED','VNC 网络连接中断。')))
  channel.on('error',()=>{});socket.resume();return channel
}
