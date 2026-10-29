import { build } from 'esbuild'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
const { ZipFile } = createRequire(new URL('../../backend/package.json', import.meta.url))('yazl')
const downloads = join(root, '..', 'frontend', 'public', 'extensions')
await mkdir(downloads, { recursive: true })
for (const target of ['chrome', 'edge', 'firefox']) {
  const outdir = join(root, 'dist', target)
  await mkdir(outdir, { recursive: true })
  await build({ entryPoints: [join(root, 'src/background.ts'), join(root, 'src/content.ts'), join(root, 'src/popup.ts')], outdir, bundle: true, format: 'iife', platform: 'browser', target: ['chrome121', 'firefox128'], legalComments: 'none' })
  for (const name of ['popup.html', 'popup.css']) await copyFile(join(root, 'public', name), join(outdir, name))
  const manifest = {
    manifest_version: 3, name: 'WebNav 自动填写', version: '0.2.0', description: '连接本机 WebNav，自动填写账号密码，也可将当前网页和账密保存为收藏。',
    permissions: ['activeTab', 'scripting'], host_permissions: ['http://127.0.0.1/*'], optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_popup: 'popup.html', default_title: 'WebNav 自动填写' },
    background: target === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    content_security_policy: { extension_pages: "default-src 'self'; script-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:*; style-src 'self'; base-uri 'none'" },
    ...(target === 'firefox' ? { browser_specific_settings: { gecko: { id: 'autofill@webnav.local', strict_min_version: '142.0', data_collection_permissions: { required: ['none'] } } } } : { minimum_chrome_version: '121' }),
  }
  await writeFile(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const zip = new ZipFile(), archive = join(root, 'dist', `webnav-${target}.zip`)
  for (const name of ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'manifest.json']) zip.addFile(join(outdir, name), name)
  const written = pipeline(zip.outputStream, createWriteStream(archive)); zip.end(); await written
  await copyFile(archive, join(downloads, `webnav-${target}.zip`))
}
console.log('已构建 Chrome、Edge、Firefox 扩展目录。')
