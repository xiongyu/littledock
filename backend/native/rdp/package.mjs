import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('.', import.meta.url)), deps = resolve(root, '../../../.native-deps')
const binary = await readFile(join(root, 'build/Release/webnav-rdp.exe'))
await mkdir(join(root, 'package'), { recursive: true })
await writeFile(join(root, 'package/webnav-rdp-win32-x64.exe.gz'), gzipSync(binary, { level: 9 }))
await writeFile(join(root, 'package/manifest.json'), JSON.stringify({ protocolVersion: 1, platform: 'win32-x64', freerdp: '3.32.2', openssl: '3.5.9', sha256: createHash('sha256').update(binary).digest('hex') }, null, 2) + '\n')
await copyFile(join(deps, 'FreeRDP-3.32.2/LICENSE'), join(root, 'package/FreeRDP-LICENSE'))
await copyFile(join(deps, 'openssl-3.5.9/LICENSE.txt'), join(root, 'package/OpenSSL-LICENSE'))
console.log(`RDP component packaged (${binary.length} bytes uncompressed).`)
