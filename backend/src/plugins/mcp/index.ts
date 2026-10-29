import { Service, type Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AppError, publicError, record, string } from '../../core/errors.ts'

declare module 'cordis' { interface Context { mcp:McpGateway } }
/** Internal authenticated WS, not an MCP transport. The local stdio bridge speaks MCP. */
export class McpGateway extends Service {
  static inject=['automation']
  private wss=new WebSocketServer({noServer:true,maxPayload:512*1024,perMessageDeflate:false})
  private gatewayConfig:{port:number}
  constructor(ctx:Context,config:{port:number}){
    super(ctx,'mcp',true)
    this.gatewayConfig=config
    const timer=setInterval(()=>{for(const ws of this.wss.clients)ws.ping()},15000);timer.unref()
    ctx.on('dispose',()=>{clearInterval(timer);for(const ws of this.wss.clients)ws.terminate();this.wss.close()})
  }
  upgrade(request:IncomingMessage,socket:Duplex,head:Buffer){
    if(request.headers.host!==`127.0.0.1:${this.gatewayConfig.port}`||request.headers.origin||request.headers.cookie||this.wss.clients.size>=32){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return}
    this.wss.handleUpgrade(request,socket,head,ws=>this.connect(ws))
  }
  private connect(ws:WebSocket){
    const authority=this.ctx.automation.authority
    let client='',phase='hello',publicKey='',transcript='',clientNonce='',pending=0,lastPong=Date.now()
    const send=(data:unknown)=>{if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>1024*1024){ws.close(1013);return}ws.send(JSON.stringify(data))}}
    const timeout=setTimeout(()=>ws.close(1008),15_000)
    const timer=setInterval(()=>{if(Date.now()-lastPong>45_000)ws.terminate();if(client){try{this.ctx.automation.require(client)}catch{ws.close(1008)}}},5000);timer.unref()
    ws.on('pong',()=>{lastPong=Date.now()});ws.on('close',()=>{clearTimeout(timeout);clearInterval(timer)});ws.on('error',()=>ws.close())
    ws.on('message',(raw,binary)=>{void (async()=>{
      let id=''
      try {
        if(binary)throw new AppError('INVALID_ARGUMENT','自动化请求必须为 JSON。')
        const p=record(JSON.parse(raw.toString()))
        if(phase==='hello'){
          if(p.type!=='hello')throw new AppError('UNAUTHORIZED','缺少身份握手。')
          publicKey=string(p.publicKey,200);clientNonce=string(p.nonce,100)
          const nonce=randomBytes(32).toString('base64url')
          transcript=JSON.stringify(['webnav-automation-v1',this.gatewayConfig.port,clientNonce,nonce,publicKey,authority.publicKey])
          phase='proof';send({type:'challenge',nonce,serverKey:authority.publicKey,signature:authority.sign(transcript)});return
        }
        if(phase==='proof'){
          phase='authenticating'
          if(p.type!=='proof'||!authority.verify(publicKey,transcript,string(p.signature,200)))throw new AppError('UNAUTHORIZED','身份签名校验失败。')
          if(p.clientId){client=string(p.clientId,100);if(authority.client(client).publicKey!==publicKey)throw new AppError('UNAUTHORIZED','客户端身份不匹配。')}
          else client=authority.enroll(string(p.code,100),publicKey)
          this.ctx.automation.require(client);phase='ready';clearTimeout(timeout);send({type:'ready',clientId:client});return
        }
        if(phase!=='ready')throw new AppError('UNAUTHORIZED','身份尚未验证。')
        this.ctx.automation.require(client);id=string(p.id,100)
        if(pending>=4)throw new AppError('BUSY','最多 4 个在途请求。')
        pending++
        try {const result=p.method==='tools.list'?{tools:this.ctx.automation.list(client)}:p.method==='tools.call'?await this.ctx.automation.call(client,string(p.name,200),p.arguments??{}):(()=>{throw new AppError('NOT_FOUND','未知自动化方法。')})();send({id,ok:true,result})}finally{pending--}
      }catch(error){send({id,ok:false,error:publicError(error)});if(phase!=='ready')ws.close(1008)}
    })()})
  }
}
