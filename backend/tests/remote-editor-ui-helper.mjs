// Simulates only the remote installer/workbench; actual SSH, SFTP, HTTP and WS
// still travel through the application. It never runs vendor binaries.
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { editorPackages } from '../src/plugins/remote-editor/packages.ts'

export async function remoteEditorUiHelper(directory, fileRoot) {
  const pkg = editorPackages['linux-x64'], archive = join(directory, 'mock-package')
  await writeFile(archive, 'isolated fixture package')
  const file = join(fileRoot, 'home/fixture/projects/editor-proof.txt')
  await writeFile(file, 'Remote editor fixture\n')
  const remote = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/save') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      await writeFile(file, Buffer.concat(chunks)); res.end('已保存到模拟远端'); return
    }
    if (req.url === '/content') { res.end(await readFile(file)); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html lang="zh"><title>模拟远程编辑器</title><body style="font:16px system-ui;max-width:800px;margin:40px auto"><h1>模拟远程编辑器</h1><p>仅验证 SSH 转发及保存，不是 VS Code 真实运行画面。</p><textarea aria-label="文件内容" style="width:100%;height:300px"></textarea><button>保存</button><p role="status"></p><script>fetch('/content').then(r=>r.text()).then(t=>document.querySelector('textarea').value=t);document.querySelector('button').onclick=async()=>{const r=await fetch('/save',{method:'POST',body:document.querySelector('textarea').value});document.querySelector('[role=status]').textContent=await r.text()}</script></body></html>`)
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening')
  const port = remote.address().port
  return {
    cache: { async ensure() { return archive } },
    forward(peer) { peer.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== port) { reject(); return }
      const ch = accept(), socket = connect(port, '127.0.0.1'); ch.pipe(socket).pipe(ch)
      ch.on('error', () => {}); socket.on('error', () => {})
      ch.on('close', () => socket.destroy()); socket.on('close', () => ch.destroy())
    }) },
    async exec(channel, command) {
      if (command.includes('uname -s')) channel.write('Linux\nx86_64\n')
      else if (command.includes('sha256sum')) { const dest=join(fileRoot, 'home/fixture/.webnav-editor/linux-x64', pkg.version); await mkdir(dest, { recursive: true }); await writeFile(join(dest,'webnav-install.json'),JSON.stringify({sha256:pkg.sha256,licenseAccepted:false})) }
      else if (command.includes('setsid')) { channel.write(`[info] HTTP server listening on http://127.0.0.1:${port}/\n`); return true }
      else return false
      channel.exit(0); channel.end(); return true
    },
    close() { remote.closeAllConnections(); remote.close() },
  }
}
