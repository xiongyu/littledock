import { readdir, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const directory = fileURLToPath(new URL('../plugins/', import.meta.url))
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const build = join(directory, entry.name, 'build.mjs')
  try { await access(build) } catch { continue }
  execFileSync(process.execPath, [build], { cwd: join(directory, entry.name), windowsHide: true, stdio: 'inherit' })
}
