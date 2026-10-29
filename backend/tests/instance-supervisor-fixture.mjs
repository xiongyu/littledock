// Real controller, workers and control channel; record browser intent instead of opening user tabs.
import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from '../src/desktop/config.ts'
import { supervise } from '../src/desktop/supervisor.ts'
const config = configuration(process.argv[2] === 'start' ? 'start' : 'dev')
await supervise({ open: async url => {
  await appendFile(join(config.runtimeDirectory, 'opened-pages.jsonl'), JSON.stringify({ url }) + '\n')
  try { await access(join(config.runtimeDirectory, 'fail-browser')); } catch { return }
  throw new Error('Synthetic browser failure')
} })
