import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Current SDK only: plugin data and callbacks stay in its assigned Worker. */
export async function activate(api) {
  const file = join(api.dataDirectory, 'terminal-themes.json'), listeners = new Set()
  let settings = { revision: 0, defaultId: 'midnight', themes: [] }, pending = Promise.resolve()
  try { settings = api.shared.parseTerminalThemes(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  api.onDispose(async () => { await pending; listeners.clear() })
  api.registerService('terminalThemes', {
    snapshot() { return structuredClone(settings) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    save(input) {
      const task = pending.then(async () => {
        const next = api.shared.parseTerminalThemes(input)
        if (next.revision !== settings.revision) throw new Error('配色已变化，请重新读取。')
        next.revision++
        const temporary = file + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, JSON.stringify(next)); await rename(temporary, file)
        settings = next; for (const listener of listeners) listener()
        return structuredClone(next)
      })
      pending = task.catch(() => {}); return task
    },
  })
  api.registerRpc('about', { mutate: false, handler: () => ({ name: api.manifest.name, version: api.manifest.version }) })
}
