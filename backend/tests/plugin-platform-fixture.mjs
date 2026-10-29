import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createApp } from '../src/app.ts'
import { runFile } from '../src/plugin-system/git.ts'

export async function platformFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'webnav-plugin-platform-'))
  const net = createServer(); net.listen(0, '127.0.0.1'); await once(net, 'listening'); const port = net.address().port; await new Promise(r => net.close(r))
  if (options.bundledSource) {
    const destination = join(root, 'bundled', 'test-plugin'); await cp(options.bundledSource, destination, { recursive: true }); await options.prepareBundled?.(destination)
  }
  const config = { ...(options.bundledSource ? { bundledPluginsDirectory: join(root, 'bundled') } : {}), directory: join(root, 'data'), port, frontendRoot: resolve('../frontend/dist'), rdpEnabled: false }
  const repositories = new Map(); let ctx
  async function start() {
    ctx = await createApp(config)
    const manager = ctx.plugins.manager
    manager.fetch = async (url, ref) => {
      const repo = repositories.get(url); if (!repo) throw new Error('Fixture forbids network repositories')
      const target = join(manager.root, 'repositories', createHash('sha256').update(url).digest('hex'))
      await mkdir(target, { recursive: true }); await runFile('git', ['init', '--bare', target], target)
      await runFile('git', ['fetch', '--depth=1', repo, ref], target)
      return (await runFile('git', ['rev-parse', 'FETCH_HEAD'], target)).trim()
    }
    manager.market = async () => ({ repository: 'https://example.invalid/index.git', index: { schemaVersion: 1, plugins: [] }, fetchedAt: Date.now(), cached: true })
  }
  async function complete(job) {
    for (let i = 0; i < 1500; i++) { const result = ctx.plugins.manager.jobStatus('fixture', { jobId: job.jobId }); if (result.state === 'succeeded') return result.result; if (result.state === 'failed') throw new Error(result.error); await new Promise(r => setTimeout(r, 20)) }
    throw new Error('Fixture job timeout')
  }
  async function install(kind, sourceDirectory, prepareRepository) {
    const url = `https://example.invalid/${kind}.git`, manager = ctx.plugins.manager
    if (!repositories.has(url)) {
      const repo = join(root, kind); await cp(sourceDirectory ?? resolve(`../examples/plugins/collaboration-${kind}`), repo, { recursive: true })
      if (prepareRepository) await prepareRepository(repo)
      await runFile('git', ['init'], repo); await runFile('git', ['add', '.'], repo)
      await runFile('git', ['-c', 'user.name=WebNav Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], repo); repositories.set(url, repo)
    }
    const preview = await complete(manager.prepare('fixture', { repository: url }))
    return complete(manager.install('fixture', { token: preview.token, commit: preview.commit, expectedRevision: manager.registry.revision, acceptRisk: true }))
  }
  await start()
  return { root, port, get ctx() { return ctx }, install, async restart() { await ctx.plugins.close(); await ctx.stop(); await start() }, async change(kind, action, extra = {}) { return ctx.plugins.manager.change({ id: `example.collaboration-${kind}`, action, expectedRevision: ctx.plugins.manager.registry.revision, ...extra }) }, async close() { await ctx?.plugins.close(); await ctx?.stop(); await rm(root, { recursive: true, force: true }) } }
}
