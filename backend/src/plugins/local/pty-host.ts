// Per-session helper isolates native ConPTY workers; only its owning local plugin starts it.
import * as pty from 'node-pty'
import { StringDecoder } from 'node:string_decoder'

let terminal:pty.IPty|undefined,closing=false
const decoder=new StringDecoder('utf8')
function close(){
  if(closing)return;closing=true
  try{terminal?.kill()}catch{}
  // node-pty's Windows drain worker can outlive a closed ConPTY. The helper is
  // scoped to one session, so bounded process exit releases those native handles.
  setTimeout(()=>process.exit(0),300)
}
process.on('message',(raw:unknown)=>{
  if(!raw||typeof raw!=='object')return
  const message=raw as {type?:string;file?:string;args?:string[];cwd?:string;cols?:number;rows?:number}
  if(message.type==='close'){close();return}
  if(message.type==='resize'&&terminal){terminal.resize(Number(message.cols),Number(message.rows));return}
  if(message.type!=='start'||terminal||closing)return
  try{
    terminal=pty.spawn(message.file!,message.args!,{cwd:message.cwd!,cols:message.cols!,rows:message.rows!,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color'},useConpty:true,useConptyDll:process.platform==='win32'})
    terminal.onData(data=>{if(!process.stdout.write(Buffer.from(data,'utf8')))terminal?.pause()})
    terminal.onExit(()=>{terminal=undefined;process.send?.({type:'exit'});close()})
    process.stdout.on('drain',()=>terminal?.resume())
    process.stdin.on('data',(bytes:Buffer)=>terminal?.write(decoder.write(bytes)))
    process.send?.({type:'ready'})
  }catch{process.send?.({type:'error'});close()}
})
process.on('disconnect',close);process.on('SIGTERM',close);process.stdin.on('end',close)
