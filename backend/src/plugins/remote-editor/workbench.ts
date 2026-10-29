// The official Web workbench accepts connectionToken in its bootstrap options.
// Keep it in this page's memory: shared localhost cookies would collide between
// editors on different ports, and setting only an upstream cookie cannot
// authenticate VS Code's subsequent application-level WebSocket handshake.
import { marketplacePath } from './marketplace.ts'

export function configureWorkbench(html:string,token:string,origin?:string):string {
  const attribute=/(<meta\s+id="vscode-workbench-web-configuration"\s+data-settings=")([^"]*)(")/
  const match=attribute.exec(html)
  if(!match)throw new Error('编辑器页面配置缺失。')
  const entities:Record<string,string>={'&quot;':'"','&amp;':'&','&lt;':'<','&gt;':'>','&apos;':"'",'&#39;':"'",'&#x27;':"'"}
  const parsed:unknown=JSON.parse(match[2]!.replace(/&(quot|amp|lt|gt|apos|#39|#x27);/g,value=>entities[value]!))
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('编辑器页面配置无效。')
  const config:Record<string,unknown>={...parsed,connectionToken:token}
  const product=config.productConfiguration
  if(origin&&product&&typeof product==='object'&&!Array.isArray(product)&&'extensionsGallery' in product){
    const gallery=product.extensionsGallery
    if(gallery&&typeof gallery==='object'&&!Array.isArray(gallery)&&'serviceUrl' in gallery&&gallery.serviceUrl==='https://marketplace.visualstudio.com/_apis/public/gallery'){
      config.productConfiguration={...product,extensionsGallery:{...gallery,serviceUrl:origin+marketplacePath}}
    }
  }
  const json=JSON.stringify(config).replace(/[&<>"']/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[value]!))
  return html.replace(attribute,()=>match[1]+json+match[3])
}
