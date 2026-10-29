// Disposable media sources for the README. These are illustrative screens, not OS captures.
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Duplex } from 'node:stream'
import { guacamoleInstruction as instruction } from '../shared/src/guacamole.ts'

export async function demoScreens(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const base = `<meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:17px 'Segoe UI','Microsoft YaHei',sans-serif;color:#263747}small{color:#6e8490}header{padding:16px 22px;border-bottom:1px solid #d9e3e8;font-weight:600}section{padding:24px}h1{font-size:24px;margin:0 0 12px}p{line-height:1.8}table{width:100%;border-collapse:collapse;font-size:16px}td,th{padding:15px;text-align:left;border-bottom:1px solid #e4eaef}th{color:#687d8a;font-weight:400}.badge{display:inline-block;background:#e6f2e9;color:#30664c;padding:6px 12px;border-radius:20px;font-size:13px}.window{background:#fafcfd;border:1px solid #ffffff90;border-radius:12px;box-shadow:0 20px 55px #13283e40;overflow:hidden;position:absolute}.mark{position:absolute;bottom:70px;right:28px;color:#ffffffc9;font-size:14px;letter-spacing:1px}.bar{position:absolute;bottom:0;width:100%;height:54px;background:#e8f0f5e8;display:flex;align-items:center;justify-content:center;gap:30px;font-size:22px}.clock{position:absolute;right:22px;font-size:13px;text-align:right}</style>`
  await page.setContent(base + `<body style="background:radial-gradient(ellipse at 75% 15%,#98c9e3,transparent 60%),linear-gradient(125deg,#244e7b,#356b97 45%,#81b7cd)"><div class="window" style="left:58px;top:62px;width:800px"><header>▣ &nbsp; 文件资源管理器 <span style="float:right">—　□　×</span></header><section><small>此电脑　›　文档　›　LittleDock Demo</small><h1 style="margin-top:26px">项目文件</h1><table><tr><th>名称</th><th>修改日期</th><th>类型</th></tr><tr><td>📁 deployment</td><td>2026/10/29 09:41</td><td>文件夹</td></tr><tr><td>📁 reports</td><td>2026/10/29 09:41</td><td>文件夹</td></tr><tr><td>📁 workspace</td><td>2026/10/29 09:41</td><td>文件夹</td></tr><tr><td>📄 README.md</td><td>2026/10/29 09:41</td><td>Markdown 文档</td></tr></table><p><small>4 个项目 · 本地生成的示例文件列表</small></p></section></div><div class="window" style="right:50px;top:374px;width:400px"><header>小站 / RDP 演示</header><section><h1>桌面就在工作区</h1><p>查看远程应用与文件<br>保留左侧导航与顶部标签</p><span class="badge">示例桌面画面</span></section></div><div class="mark">LITTLEDOCK · DEMO CONTENT</div><div class="bar">▦　⌕　📁　▣<span class="clock">09:41<br>2026/10/29</span></div></body>`)
  await page.evaluate(() => document.fonts.ready)
  const rdp = await page.screenshot()
  await page.setContent(base + `<body style="background:radial-gradient(ellipse at 80% 5%,#b57871,transparent 65%),linear-gradient(130deg,#302e49,#59516f 60%,#976b77)"><div style="height:32px;background:#24232be8;color:white;font-size:13px;padding:7px 20px">活动 <span style="position:absolute;left:46%">10 月 29 日　09:41</span><span style="float:right">网络　音量　电源</span></div><div class="window" style="left:58px;top:76px;width:700px"><header>文件　/　home / demo / workspace <span style="float:right">—　□　×</span></header><section><h1>workspace</h1><div style="display:flex;gap:50px;padding:40px 5px">${['projects','backups','documents','downloads'].map(name=>`<div style="text-align:center"><span style="font-size:52px">📁</span><p>${name}</p></div>`).join('')}</div><small>演示目录 · 不包含真实服务器文件</small></section></div><div class="window" style="right:44px;top:390px;width:760px;background:#222735;color:#c8d3db"><header style="border-color:#414859">demo@linux-desktop: ~/workspace</header><section style="font:18px/1.8 Consolas,monospace"><span style="color:#95c9aa">demo@linux-desktop</span>:~$ ls<br>projects/　 backups/　 documents/　 downloads/<br><br><span style="color:#95c9aa">demo@linux-desktop</span>:~$ echo 'Hello, LittleDock'<br>Hello, LittleDock<br><br><span style="color:#95c9aa">demo@linux-desktop</span>:~$ ▋</section></div><div class="mark">VNC · 示例桌面画面</div></body>`)
  await page.evaluate(() => document.fonts.ready)
  const vnc = await page.screenshot()
  const rgba = Buffer.from(await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data
    let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
    return btoa(binary)
  }, vnc.toString('base64')), 'base64')
  await page.setViewportSize({ width: 432, height: 864 })
  await page.setContent(base + `<body style="background:#edf2e7;color:#314439"><div style="padding:15px 25px;font-weight:600">09:41 <span style="float:right">● ▰  100%</span></div><section style="padding:30px 26px"><small style="letter-spacing:3px">LITTLEDOCK DEMO</small><h1 style="font-size:34px;margin:18px 0 6px">你好，小站</h1><p style="margin:0;color:#6e8070">安卓设备 · 示例应用</p><div style="border-radius:28px;background:#d8e6d2;padding:25px;margin-top:28px"><div style="font-size:17px">设备工作台</div><div style="font-size:56px;font-weight:500;margin:15px 0 2px">09:41</div><p style="margin:0">10 月 29 日　星期四</p></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0"><div style="background:white;border-radius:23px;padding:22px"><span style="font-size:28px">▣</span><p>文件管理<br><small>浏览示例文件</small></p></div><div style="background:#e3e8d9;border-radius:23px;padding:22px"><span style="font-size:28px">☷</span><p>工作清单<br><small>3 项待办</small></p></div></div><div style="background:white;border-radius:24px;padding:22px;font-size:15px"><strong>今天的计划</strong><p style="margin-bottom:0">✓ 检查开发环境<br>○ 整理项目文档<br>○ 完成设备测试</p></div><p style="font-size:12px;text-align:center;color:#859384;margin-top:25px">本地生成的演示画面 · 无真实设备数据</p></section><div style="position:absolute;bottom:16px;left:40%;width:20%;height:5px;border-radius:5px;background:#35483e"></div></body>`)
  await page.evaluate(() => document.fonts.ready)
  const android = await page.screenshot()
  await page.close()
  return { rdp, vnc: { rgba, width: 1280, height: 800 }, android }
}

export function demoRdp(png) {
  const sockets = new Set()
  return {
    async launch() {
      const socket = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback() } })
      sockets.add(socket); socket.on('close', () => sockets.delete(socket))
      const parts = [instruction('size', 0, 1280, 800), instruction('img', 1, 12, 0, 'image/png', 0, 0)]
      for (let offset = 0; offset < png.length; offset += 24 * 1024) parts.push(instruction('blob', 1, png.subarray(offset, offset + 24 * 1024).toString('base64')))
      parts.push(instruction('end', 1), instruction('sync', 1))
      socket.push(Buffer.from(parts.join('')))
      return socket
    },
    close() { for (const socket of sockets) socket.destroy() },
  }
}

export async function demoVnc({ rgba, width, height }) {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let buffer = Buffer.alloc(0), phase = 'version', format = Buffer.from([32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0])
    socket.write('RFB 003.008\n')
    function frame() {
      const bytes = format[0] / 8, pixels = Buffer.alloc(width * height * bytes)
      for (let i = 0; i < width * height; i++) {
        const value = (((rgba[i*4] * format.readUInt16BE(4) / 255) << format[10]) | ((rgba[i*4+1] * format.readUInt16BE(6) / 255) << format[11]) | ((rgba[i*4+2] * format.readUInt16BE(8) / 255) << format[12])) >>> 0
        if (format[2]) pixels.writeUIntBE(value, i*bytes, bytes); else pixels.writeUIntLE(value, i*bytes, bytes)
      }
      const header = Buffer.alloc(16); header.writeUInt16BE(1,2); header.writeUInt16BE(width,8); header.writeUInt16BE(height,10)
      socket.write(Buffer.concat([header,pixels]))
    }
    socket.on('data', data => {
      buffer = Buffer.concat([buffer,data])
      while (buffer.length) {
        if (phase === 'version') { if (buffer.length < 12) return; buffer=buffer.subarray(12); socket.write(Buffer.from([1,1])); phase='security' }
        else if (phase === 'security') { buffer=buffer.subarray(1); socket.write(Buffer.alloc(4)); phase='init' }
        else if (phase === 'init') {
          buffer=buffer.subarray(1); const title=Buffer.from('LittleDock demo desktop'), header=Buffer.alloc(24)
          header.writeUInt16BE(width,0); header.writeUInt16BE(height,2); format.copy(header,4); header.writeUInt32BE(title.length,20)
          socket.write(Buffer.concat([header,title])); phase='stream'
        } else {
          const type=buffer[0]; let length
          if(type===0) length=20
          else if(type===2) { if(buffer.length<4)return; length=4+buffer.readUInt16BE(2)*4 }
          else if(type===3) length=10
          else if(type===4) length=8
          else if(type===5) length=6
          else if(type===6) { if(buffer.length<8)return; length=8+buffer.readUInt32BE(4) }
          else if(type===251) { if(buffer.length<8)return; length=8+buffer[6]*16 }
          else { socket.destroy(); return }
          if(buffer.length<length)return
          if(type===0) format=Buffer.from(buffer.subarray(4,20))
          if(type===3 && buffer[1]===0) frame()
          buffer=buffer.subarray(length)
        }
      }
    })
  })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  return { port:server.address().port, async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))} }
}
