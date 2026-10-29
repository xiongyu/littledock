import { createServer, request, type IncomingMessage, type Server, type OutgoingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import { configureWorkbench } from './workbench.ts'
import { marketplaceProxy } from './marketplace.ts'

export interface EditorGateway { url: string; close:()=>Promise<void> }
// A separate loopback origin keeps the remote workbench out of WebNav's DOM/storage.
export async function editorGateway(client:Client,remotePort:number,token:string|undefined,authorize:(cookie:string|undefined)=>boolean):Promise<EditorGateway> {
  const sockets=new Set<Duplex>();let origin='',host='',closed=false
  const marketplace=marketplaceProxy()
  const track=(socket:Duplex)=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket}
  const allowed=(req:IncomingMessage,upgrade=false)=>!closed&&req.headers.host===host&&authorize(req.headers.cookie)&&(!req.headers.origin||req.headers.origin===origin)&&(!upgrade||req.headers.origin===origin)&&(!['POST','PUT','PATCH','DELETE'].includes(req.method??'')||req.headers.origin===origin)
  const upstream=(incoming:IncomingMessage,ready:(error:Error|null,stream?:Duplex)=>void)=>{
    if(sockets.size>=64){ready(new Error('Too many connections'));return}
    let expired=false
    const timer=setTimeout(()=>{expired=true;ready(new Error('SSH forwarding timed out'))},15_000)
    client.forwardOut('127.0.0.1',0,'127.0.0.1',remotePort,(error,stream)=>{clearTimeout(timer);if(expired){stream?.destroy();return}if(error){ready(error);return}if(closed||!authorize(incoming.headers.cookie)){stream.destroy();ready(new Error('Closed'));return}ready(null,track(stream))})
  }
  const options=(req:IncomingMessage,channel:Duplex)=>{
    const url=new URL(req.url??'/',origin)
    if(token)url.searchParams.delete('tkn')
    const headers:OutgoingHttpHeaders={...req.headers,host,'x-forwarded-host':host,'x-forwarded-proto':'http'}
    // Never disclose WebNav's owner cookie to software on the remote host.
    delete headers.cookie;delete headers.authorization;delete headers['proxy-authorization']
    // VS Code redirects root requests containing ?tkn= to remove it. Supplying
    // its dedicated upstream cookie avoids an endless redirect at the proxy.
    if(token)headers.cookie='vscode-tkn='+encodeURIComponent(token)
    if(token){headers['accept-encoding']='identity';headers['accept-language']='en'}
    // agent:false creates a new TCP Agent and ignores createConnection. Omit it
    // so every request uses this SSH channel, never the local machine's port.
    return {host:'127.0.0.1',port:remotePort,path:url.pathname+url.search,method:req.method,headers,createConnection:()=>channel}
  }
  const server:Server=createServer((req,res)=>{
    if(!allowed(req)){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'}).end('编辑器连接已关闭或尚未解锁，请从小站重新打开。');return}
    if(token&&marketplace.handle(req,res,new URL(req.url??'/',origin).pathname))return
    upstream(req,(error,channel)=>{
      if(error||!channel){res.writeHead(502,{'content-type':'text/plain; charset=utf-8'}).end('SSH 转发不可用。');return}
      const remote=request(options(req,channel),reply=>{
        const headers={...reply.headers};delete headers['set-cookie']
        headers['referrer-policy']='no-referrer'
        if(token&&reply.statusCode===200&&String(headers['content-type']).startsWith('text/html')&&new URL(req.url??'/',origin).pathname==='/'){
          let size=0;const chunks:Buffer[]=[]
          reply.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){remote.destroy();return}chunks.push(chunk)})
          reply.on('end',()=>{
            try{
              const html=configureWorkbench(Buffer.concat(chunks).toString('utf8'),token,origin)
              delete headers['content-length'];delete headers['content-encoding'];delete headers.etag
              headers['cache-control']='no-store';headers['content-type']='text/html; charset=utf-8'
              res.writeHead(200,headers);res.end(html)
            }catch{res.writeHead(502,{'content-type':'text/plain; charset=utf-8'}).end('编辑器页面配置不可用。')}
          })
          return
        }
        res.writeHead(reply.statusCode??502,headers);reply.pipe(res)
      })
      // ssh2 channels are streams, not net.Socket; ClientRequest.setTimeout
      // calls a missing socket method. Bound the request with our own timer.
      const timer=setTimeout(()=>remote.destroy(),120_000);remote.once('close',()=>clearTimeout(timer))
      remote.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain; charset=utf-8'});res.end('编辑器连接已中断。');channel.destroy()})
      res.once('close',()=>{remote.destroy();channel.destroy()});req.pipe(remote)
    })
  })
  server.maxConnections=64;server.headersTimeout=15_000;server.requestTimeout=120_000
  server.on('connection',socket=>track(socket))
  server.on('upgrade',(req,socket,head)=>{
    if(!allowed(req,true)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}
    upstream(req,(error,channel)=>{
      if(error||!channel||socket.destroyed){channel?.destroy();socket.destroy();return}
      const remote=request(options(req,channel))
      const timer=setTimeout(()=>remote.destroy(),15_000);remote.once('close',()=>clearTimeout(timer))
      remote.once('upgrade',(reply,peer,pending)=>{
        clearTimeout(timer)
        if(closed||socket.destroyed){peer.destroy();return}
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).filter(([key])=>key!=='set-cookie').map(([key,value])=>`${key}: ${value}\r\n`).join('')+'\r\n')
        if(pending.length)socket.write(pending);if(head.length)peer.write(head)
        track(peer);socket.pipe(peer).pipe(socket);socket.once('close',()=>peer.destroy());peer.once('close',()=>socket.destroy())
      })
      remote.on('response',()=>{remote.destroy();channel.destroy();socket.destroy()});remote.on('error',()=>{channel.destroy();socket.destroy()});socket.once('close',()=>remote.destroy());remote.end()
    })
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
  const port=(server.address() as {port:number}).port;host='127.0.0.1:'+port;origin='http://'+host
  return {url:origin,close:async()=>{if(closed)return;closed=true;marketplace.close();for(const socket of sockets)socket.destroy();sockets.clear();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
