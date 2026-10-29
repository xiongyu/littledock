import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AppError, integer, publicError, record, string } from '../errors.ts'

type Viewer = { id:string; owner:string; ws:WebSocket; sent:number; ack:number; queue:Buffer[]; queued:number; lastAck:number; seq:number }
type Hooks={input:(bytes:Buffer)=>void;resize:(cols:number,rows:number)=>void;changed:()=>void;returned:()=>void;confirm:(p:Record<string,unknown>)=>void;authorized:(owner:string)=>boolean}
/** One authoritative parser and size, bounded output and independently acknowledged viewers. */
export class AiTerminal {
  readonly terminal = new headless.Terminal({ cols:100, rows:30, scrollback:2000, allowProposedApi:true })
  readonly serializer = new serialize.SerializeAddon()
  controller:'ai'|'user'|'none'='ai'
  controlEpoch=1
  connected=false
  ended=false
  message='任务已结束，连接已释放。'
  pendingKey?:Record<string,unknown>
  private human?:string
  private inputSeq=0
  private inputHashes=new Map<number,string>()
  private viewers=new Map<string,Viewer>()
  private output:{seq:number;text:string;bytes:number}[]=[]
  private outputBytes=0
  private cursor=0
  private decoder=new StringDecoder('utf8')
  private parsing=Promise.resolve()
  private timer:ReturnType<typeof setInterval>
  private hooks:Hooks
  constructor(hooks:Hooks){
    this.hooks=hooks
    this.terminal.loadAddon(this.serializer)
    // Only this parser answers device queries. Browser parser responses never reach the PTY.
    this.terminal.onData(text=>{if(this.connected){try{this.hooks.input(Buffer.from(text))}catch{/* The session owns connection failure and cleanup. */}}})
    this.timer=setInterval(()=>{for(const v of this.viewers.values())if(!hooks.authorized(v.owner)||(v.sent>v.ack&&Date.now()-v.lastAck>30_000))v.ws.close(1013,'重新附着终端以同步当前画面');},5000)
    this.timer.unref()
  }
  private send(v:Viewer,value:unknown){if(v.ws.readyState===WebSocket.OPEN)v.ws.send(JSON.stringify(value))}
  private state(v:Viewer){this.send(v,{type:'terminal.control',controller:this.controller,controlEpoch:this.controlEpoch,writable:this.connected&&this.human===v.id,connected:this.connected,ended:this.ended,cols:this.terminal.cols,rows:this.terminal.rows,message:this.message})}
  private notify(){for(const v of this.viewers.values())this.state(v);this.hooks.changed()}
  private change(controller:'ai'|'user'|'none',human?:string){this.controller=controller;this.human=human;this.controlEpoch++;this.inputSeq=0;this.inputHashes.clear();for(const v of this.viewers.values())v.seq=0;this.notify()}
  write(bytes:Buffer){
    this.parsing=this.parsing.then(()=>new Promise<void>(resolve=>this.terminal.write(bytes,()=>{
      const text=this.decoder.write(bytes);this.output.push({seq:++this.cursor,text,bytes:bytes.length});this.outputBytes+=bytes.length
      while(this.outputBytes>8*1024*1024||this.output.length>8192){const old=this.output.shift()!;this.outputBytes-=old.bytes}
      for(const v of this.viewers.values())this.enqueue(v,bytes)
      resolve()
    })))
    return this.parsing
  }
  event(value:unknown){const p=record(value)
    if(p.type==='terminal.ready'){this.connected=true;this.pendingKey=undefined;this.notify()}
    if(p.type==='terminal.hostkey')this.pendingKey=p
    for(const v of this.viewers.values())if(p.type!=='terminal.exit')this.send(v,p)
    this.hooks.changed()
  }
  async attach(owner:string,ws:WebSocket){
    if(this.viewers.size>=4)throw new AppError('BUSY','一个 AI 终端最多 4 个观察页面。')
    await this.parsing
    if(!this.hooks.authorized(owner)||ws.readyState!==WebSocket.OPEN)return ws.close(1008)
    if(this.viewers.size>=4)throw new AppError('BUSY','一个 AI 终端最多 4 个观察页面。')
    const v:Viewer={id:randomUUID(),owner,ws,sent:0,ack:0,queue:[],queued:0,lastAck:Date.now(),seq:0}
    this.viewers.set(v.id,v)
    this.send(v,{type:'terminal.snapshot',cols:this.terminal.cols,rows:this.terminal.rows})
    const screen=Buffer.from(this.serializer.serialize({scrollback:2000}))
    this.enqueue(v,screen);if(this.pendingKey)this.send(v,this.pendingKey);this.state(v)
    ws.on('message',(raw,binary)=>{try{
      if(binary||!this.hooks.authorized(owner))throw new AppError('FORBIDDEN','终端观察通道不接受未授权输入。')
      const p=record(JSON.parse(raw.toString()))
      if(p.type==='terminal.ack') {const ack=integer(p.parsedBytes,0,v.sent);if(ack<v.ack)throw new AppError('FLOW_CONTROL','输出 ACK 倒退。');v.ack=ack;v.lastAck=Date.now();this.pump(v);return}
      if(p.type==='terminal.takeover'){
        if(!this.connected||this.ended)throw new AppError('CONFLICT','连接已经结束。')
        if(this.controller==='user'&&this.human!==v.id)throw new AppError('BUSY','另一个页面正在人工接管。')
        this.change('user',v.id);return
      }
      if(p.type==='terminal.release'){
        if(this.controller==='user'&&this.human!==v.id)throw new AppError('FORBIDDEN','当前页面没有控制权。')
        this.change(this.ended?'none':'ai');this.hooks.returned();return
      }
      if(p.type==='terminal.hostkeyDecision'){this.hooks.confirm(p);this.pendingKey=undefined;return}
      if(this.human!==v.id||this.controller!=='user'||integer(p.controlEpoch,1,Number.MAX_SAFE_INTEGER)!==this.controlEpoch)throw new AppError('READ_ONLY','终端默认只读，请先手动解锁。')
      if(p.type==='terminal.input'){
        const seq=integer(p.seq,1,Number.MAX_SAFE_INTEGER);if(seq<=v.seq)return;if(seq!==v.seq+1)throw new AppError('INPUT_GAP','输入序号缺失，重新接管后核对。')
        const bytes=Buffer.from(string(p.text,16384));if(bytes.length>16384)throw new AppError('LIMIT','请分段粘贴。')
        this.hooks.input(bytes);v.seq=seq
      }else if(p.type==='terminal.resize'){
        const cols=integer(p.cols,20,400),rows=integer(p.rows,5,200);this.terminal.resize(cols,rows);this.hooks.resize(cols,rows);this.notify()
      }else throw new AppError('INVALID_ARGUMENT','未知终端操作。')
    }catch(e){this.send(v,{type:'terminal.notice',...publicError(e)})}})
    ws.on('close',()=>{this.viewers.delete(v.id);if(this.human===v.id)this.change('none')})
    ws.on('error',()=>ws.close())
  }
  private enqueue(v:Viewer,bytes:Buffer){
    if(v.queued+v.sent-v.ack+bytes.length>2*1024*1024||v.ws.bufferedAmount>256*1024){v.ws.close(1013,'观察速度不足，请重新附着');this.viewers.delete(v.id);return}
    for(let i=0;i<bytes.length;i+=16384){const chunk=Buffer.from(bytes.subarray(i,i+16384));v.queue.push(chunk);v.queued+=chunk.length}
    this.pump(v)
  }
  private pump(v:Viewer){
    if(v.ws.readyState!==WebSocket.OPEN)return
    while(v.queue.length&&v.sent-v.ack+v.queue[0]!.length<=256*1024&&v.ws.bufferedAmount<256*1024){const bytes=v.queue.shift()!;v.queued-=bytes.length;v.sent+=bytes.length;v.ws.send(bytes,{binary:true},e=>{if(e)v.ws.close();else this.pump(v)})}
    if(!this.connected&&this.ended&&!v.queue.length&&v.sent===v.ack){this.send(v,{type:'terminal.exit',message:this.message});v.ws.close(1000)}
  }
  input(epoch:number,seq:number,text:string,digest:string){
    if(this.controller!=='ai'||epoch!==this.controlEpoch||this.ended)throw new AppError('CONTROL_CHANGED','控制权已改变，请重新观察；禁止重放旧输入。')
    if(!this.connected)throw new AppError('NOT_READY','SSH 尚未就绪，请查看任务状态。')
    if(seq<=this.inputSeq){if(this.inputHashes.get(seq)!==digest)throw new AppError('UNKNOWN','旧输入无法核对，不能重放。');return {accepted:true,duplicate:true}}
    if(seq!==this.inputSeq+1)throw new AppError('INPUT_GAP','输入序号不连续。')
    const bytes=Buffer.from(text);if(bytes.length>16384)throw new AppError('LIMIT','每次输入最多 16 KiB。')
    this.hooks.input(bytes);this.inputSeq=seq;this.inputHashes.set(seq,digest)
    if(this.inputHashes.size>128)this.inputHashes.delete(this.inputHashes.keys().next().value!)
    return {accepted:true,duplicate:false}
  }
  read(after=0){
    const first=this.output[0]?.seq??this.cursor+1,parts:string[]=[];let bytes=0,cursor=after
    for(const chunk of this.output)if(chunk.seq>after){if(bytes+chunk.bytes>64*1024)break;parts.push(chunk.text);bytes+=chunk.bytes;cursor=chunk.seq}
    return {text:parts.join(''),after:cursor,latest:this.cursor,gap:after<first-1,controlEpoch:this.controlEpoch,controller:this.controller,connected:this.connected,cols:this.terminal.cols,rows:this.terminal.rows}
  }
  async finish(){await this.parsing;this.ended=true;this.notify()}
  disconnect(message='任务已结束，连接已释放。'){this.message=message;this.connected=false;this.ended=true;this.change('none');for(const v of this.viewers.values())this.pump(v)}
  dispose(){clearInterval(this.timer);for(const v of this.viewers.values())v.ws.close();this.viewers.clear();this.output=[];this.terminal.dispose()}
}
