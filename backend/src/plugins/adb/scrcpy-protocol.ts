import { AppError, integer } from '../../core/errors.ts'

export function scrcpyKey(code:number,down:boolean,meta=0){const bytes=Buffer.alloc(14);bytes[0]=0;bytes[1]=down?0:1;bytes.writeUInt32BE(integer(code,0,288),2);bytes.writeUInt32BE(integer(meta,0,0x7fffffff),10);return bytes}
export function scrcpyTouch(action:number,x:number,y:number,width:number,height:number){
  const bytes=Buffer.alloc(32);bytes[0]=2;bytes[1]=integer(action,0,2);bytes.writeBigInt64BE(-2n,2)
  bytes.writeUInt32BE(integer(x,0,width-1),10);bytes.writeUInt32BE(integer(y,0,height-1),14);bytes.writeUInt16BE(integer(width,1,8192),18);bytes.writeUInt16BE(integer(height,1,8192),20)
  bytes.writeUInt16BE(action===1?0:65535,22);bytes.writeUInt32BE(1,24);bytes.writeUInt32BE(action===1?0:1,28);return bytes
}
export function scrcpyClipboard(text:unknown){
  if(typeof text!=='string'||!text.length||Buffer.byteLength(text)>4096||text.includes('\0'))throw new AppError('INVALID_ARGUMENT','输入文字不能为空且不能超过 4 KiB。')
  const payload=Buffer.from(text,'utf8'),bytes=Buffer.alloc(14+payload.length);bytes[0]=9;bytes.writeBigUInt64BE(1n,1);bytes[9]=1;bytes.writeUInt32BE(payload.length,10);payload.copy(bytes,14);return bytes
}
export function scrcpyScroll(x:number,y:number,width:number,height:number,delta:number){
  const bytes=Buffer.alloc(21);bytes[0]=3;bytes.writeUInt32BE(integer(x,0,width-1),1);bytes.writeUInt32BE(integer(y,0,height-1),5);bytes.writeUInt16BE(width,9);bytes.writeUInt16BE(height,11);bytes.writeInt16BE(delta>0?-32767:32767,15);return bytes
}
/** Incremental bounded parser for scrcpy 3.3.4, including arbitrary TCP fragmentation. */
export class ScrcpyFrames {
  private header=Buffer.alloc(12);private head=0;private frame?:Buffer;private offset=0
  push(bytes:Buffer,emit:(frame:Buffer)=>void){
    let offset=0
    while(offset<bytes.length){
      if(!this.frame){const n=Math.min(12-this.head,bytes.length-offset);bytes.copy(this.header,this.head,offset,offset+n);this.head+=n;offset+=n;if(this.head<12)continue
        const size=this.header.readUInt32BE(8);if(!size||size>4*1024*1024)throw new AppError('SCRCPY_FRAME','scrcpy 帧长度超过上限。')
        this.frame=Buffer.allocUnsafe(size+12);this.header.copy(this.frame);this.offset=12;this.head=0
      }
      const n=Math.min(this.frame.length-this.offset,bytes.length-offset);bytes.copy(this.frame,this.offset,offset,offset+n);this.offset+=n;offset+=n
      if(this.offset===this.frame.length){const frame=this.frame;this.frame=undefined;this.offset=0;emit(frame)}
    }
  }
}
