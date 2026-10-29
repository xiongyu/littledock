import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = dirname(fileURLToPath(import.meta.url)), require = createRequire(join(root, '../../frontend/package.json')), ts = require('typescript')
const hash = createHash('sha256').update(await readFile(join(root, 'windows/bridge.ps1'))).update('\0').update(await readFile(join(root, 'windows/rules.json'))).digest('hex')
await mkdir(join(root, 'runtime'), { recursive: true })
await mkdir(join(root, 'ui'), { recursive: true })
for (const file of await readdir(join(root, 'src'))) if (file.endsWith('.ts')) {
  const source = (await readFile(join(root, 'src', file), 'utf8')).replace('__BRIDGE_SHA256__', hash)
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true }, fileName: file })
  await writeFile(join(root, file === 'frontend.ts' ? 'ui/main.js' : 'runtime/' + file.replace('.ts', '.js')), result.outputText)
}
console.log('Built standalone plugin runtime and pinned Windows helper.')
