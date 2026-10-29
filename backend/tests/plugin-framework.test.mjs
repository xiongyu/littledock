// Regression coverage converted from the audit. Synthetic releases and isolated local data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { parsePluginManifest } from '@webnav/shared'
import { createApp } from '../src/app.ts'

test('plugin fault isolation, optional contracts and maintenance cleanup regressions', { timeout: 60000 }, async () => {
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const frontendRequire = createRequire(join(repository, 'frontend/package.json'))
const ts = frontendRequire('typescript'), vue = frontendRequire('vue')
const source = await readFile(join(repository, 'frontend/src/plugins.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText
const lifecycle = {}
runInNewContext(ts.transpileModule(await readFile(join(repository, 'frontend/src/plugin-lifecycle.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: lifecycle, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 40)), clearTimeout })
const findings = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function gate() { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
function frontendHarness(assets, modules, providers = {}) {
  const state = { assets, providers }, registry = { pluginConnectors: vue.shallowReactive({}) }
  const exports = {}, imports = {
    vue, './plugin-lifecycle.ts': lifecycle,
    './plugin-builtins': { builtinFrontend: () => undefined },
    './backend': { connectionState: vue.ref('ready'), rpc: async method => {
      if (method === 'plugins.themes') return []
      if (method === 'plugins.assets') return { revision: 1, ...state }
      if (method === 'plugins.state') return { runningProviders: state.providers }
      throw new Error('Unexpected RPC: ' + method)
    } },
    './theme-market': { installedThemes: vue.ref([]) }, './plugin-registry.ts': registry,
  }
  const environment = { document: { documentElement: { style: { setProperty() {} } }, createElement: () => ({ remove() {} }), head: { append() {} } } }
  const localRequire = name => {
    if (name in imports) return imports[name]
    if (name in modules) return modules[name]
    if (name.endsWith('.vue')) return { default: {} } // Rendering is covered by browser tests, not this loader harness.
    if (name === '@webnav/shared') return frontendRequire(name)
    if (name.startsWith('./')) {
      const loaded = {}; imports[name] = loaded
      const file = join(repository, 'frontend/src', name.endsWith('.ts') ? name : name + '.ts')
      runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { ...environment, exports: loaded, require: localRequire })
      return loaded
    }
    throw new Error('Unexpected module: ' + name)
  }
  runInNewContext(compiled, { exports, require: localRequire, ...environment }, { filename: 'frontend/src/plugins.ts' })
  return { api: exports, state }
}
function asset(id, capabilities = []) { return { id, entry: id, commit: 'a'.repeat(40), capabilities, styles: [], config: {} } }

// Run the real frontend loader with substituted transport/module imports and real Vue.
{
  const blocker = gate(), entered = gate(); let healthyRuns = 0, settled = false, exposed
  const h = frontendHarness([asset('slow'), asset('healthy')], {
    slow: { activate: api => { exposed = api; entered.release(); return blocker.promise } },
    healthy: { activate: () => { healthyRuns++ } },
  })
  const first = h.api.loadPlugins().then(() => { settled = true }), queued = h.api.loadPlugins()
  await entered.promise; await Promise.all([first, queued])
  assert.equal(settled, true); assert.equal(healthyRuns, 1)
  assert.throws(() => exposed.registerView('themes', {}), /关闭/)
  assert.ok(h.api.pluginLoadErrors.value.some(message => message.startsWith('slow ')))
  blocker.release()
}
{
  const blocker = gate(), entered = gate(); let laterRuns = 0, settled = false
  const h = frontendHarness([asset('old')], {
    old: { activate: api => api.onDispose(() => { entered.release(); return blocker.promise }) },
    later: { activate: () => { laterRuns++ } },
  })
  await h.api.loadPlugins(); h.state.assets = []
  const removal = h.api.loadPlugins().then(() => { settled = true })
  await entered.promise; h.state.assets = [asset('later')]; const queued = h.api.loadPlugins()
  await Promise.all([removal, queued]); assert.equal(settled, true); assert.equal(laterRuns, 1)
  assert.ok(h.api.pluginLoadErrors.value.some(message => message.includes('清理未完成')))
  blocker.release()
}
{
  const h = frontendHarness([asset('multi', [{ id: 'connector:alpha' }, { id: 'connector:beta' }])], {
    multi: { activate: api => {
      api.registerConnector('alpha', { name: 'Alpha', port: 1234 })
      api.registerConnector('beta', { name: 'Beta', port: 5678 })
    } },
  })
  await h.api.loadPlugins()
  const names = h.api.connectorOptions('plugin:alpha').map(item => item.name)
  assert.deepEqual(Array.from(names), ['Alpha'])
  findings.push({ id: 'connector-options-cross-protocol', observed: names })
}

const base = JSON.parse(await readFile(join(repository, 'examples/plugins/midnight-themes/webnav.plugin.json'), 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'webnav-framework-audit-'))
const importGate = gate(), importEntered = gate(), importKey = Symbol.for('webnav.isolated.audit.module-gate')
globalThis[importKey] = { promise: importGate.promise, entered: importEntered.release }
let ctx, socket, boot
try {
  const data = join(root, 'data'), plugins = join(data, 'plugins'), ui = join(root, 'ui'), commit = 'a'.repeat(40)
  await mkdir(ui, { recursive: true }); await writeFile(join(ui, 'index.html'), '<!doctype html><title>Isolated audit</title>')
  const taskId = 'audit.task-manager-contract', leaseId = 'audit.long-task', importId = 'audit.import-gate'
  const taskManifest = parsePluginManifest({ ...base, id: taskId, frontend: undefined, backend: 'backend.mjs',
    capabilities: [{ id: 'service:taskManager', version: 1 }] })
  const leaseManifest = parsePluginManifest({ ...base, id: leaseId, frontend: undefined, backend: 'backend.mjs',
    capabilities: [{ id: 'extension:audit', version: 1 }] })
  const importManifest = parsePluginManifest({ ...base, id: importId, frontend: undefined, backend: 'backend.mjs',
    capabilities: [{ id: 'extension:import-audit', version: 1 }] })
  const importCode = `const gate = globalThis[Symbol.for('webnav.isolated.audit.module-gate')];
    gate.entered(); await gate.promise; export function activate(api) { api.registerRpc('late', { mutate: false, handler() { return true; } }); }`
  // This is deliberately the currently documented and validated taskManager v1 contract.
  const taskCode = `export function activate(api) {
    api.registerService('taskManager', {
      size: 0, sizeRemote: 0, start: () => ({ id: 'audit-monitor', state: 'ready' }),
      status() {}, install() {}, hostKeyDecision() {}, snapshot() {}, details() {},
      prepareAction() {}, applyAction() {}, close() {}, closeOwner() {}, hasResources: () => false,
    });
  }`
  const leaseCode = `export function activate(api) {
    let release;
    api.registerRpc('hold', { mutate: true, async handler() { release ??= await api.host.acquireResource(); return { held: true }; } });
    api.registerRpc('release', { mutate: true, maintenance: 'finish', async handler() { release?.(); release = undefined; return { held: false }; } });
    api.registerRpc('status', { mutate: false, maintenance: 'read', handler() { return { held: !!release }; } });
    api.registerRpc('forged.status', { mutate: true, handler() { return true; } });
    api.registerRpc('newWork', { mutate: true, maintenance: 'finish', async handler() { return await api.host.acquireResource(); } });
    api.onDispose(() => { release?.(); release = undefined; });
  }`
  const installed = []
  for (const [manifest, code] of [[importManifest, importCode], [taskManifest, taskCode], [leaseManifest, leaseCode]]) {
    const release = join(plugins, 'releases', manifest.id, commit)
    await mkdir(release, { recursive: true }); await writeFile(join(release, 'backend.mjs'), code)
    await writeFile(join(release, 'webnav.plugin.json'), JSON.stringify(manifest))
    installed.push({ manifest, commit, repository: 'https://example.invalid/audit.git', ref: 'HEAD', enabled: true, installedAt: Date.now(), config: {} })
  }
  await writeFile(join(plugins, 'registry.json'), JSON.stringify({ revision: 1, installed, providers: { 'service:taskManager': taskId } }))
  const net = createServer(); net.listen(0, '127.0.0.1'); await once(net, 'listening')
  const port = net.address().port; await new Promise(resolve => net.close(resolve))
  let bootSettled = false
  boot = createApp({ directory: data, port, frontendRoot: ui }).then(value => { bootSettled = true; return value })
  await importEntered.promise
  ctx = await boot
  assert.equal(bootSettled, true)
  assert.match(ctx.plugins.manager.errors.get(importId), /超时/)
  importGate.release(); await delay(20)
  assert.equal(ctx.plugins.rpc.has(`plugin.${importId}.late`), false)
  assert.equal(ctx.plugins.manager.runningProviders['service:taskManager'], taskId)
  const missing = ['recordingStatus', 'configureRecording', 'queryHistory', 'historyPoint'].filter(name => typeof ctx.taskManager[name] !== 'function')
  assert.equal(missing.length, 4)

  const origin = `http://127.0.0.1:${port}`
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0]
  socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { origin, headers: { cookie } })
  const hello = await new Promise((resolve, reject) => {
    socket.once('error', reject); socket.once('message', raw => resolve(JSON.parse(raw.toString())))
  })
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Audit RPC timed out: ' + method)) }, 5000)
      function listener(raw) {
        const message = JSON.parse(raw.toString()); if (message.id !== id) return
        clearTimeout(timer); socket.off('message', listener); resolve(message)
      }
      socket.on('message', listener)
      socket.send(JSON.stringify({ v: 1, type: 'request', epoch: hello.epoch, id, operationId: randomUUID(), method, params }))
    })
  }
  assert.equal((await rpc('taskManager.start', { target: { kind: 'local' } })).ok, true)
  const historyResponse = await rpc('taskManager.recordingStatus', { monitorId: 'audit-monitor' })
  assert.equal(historyResponse.ok, false)
  assert.equal(historyResponse.error.code, 'CAPABILITY_UNAVAILABLE')
  findings.push({ id: 'incomplete-task-manager-contract-accepted', observed: { runningProvider: taskId, missing, rpcError: historyResponse.error } })

  assert.equal((await rpc(`plugin.${leaseId}.hold`)).ok, true)
  assert.equal(ctx.plugins.resourceCount, 1)
  ctx.maintenance.draining = true
  const releaseResponse = await rpc(`plugin.${leaseId}.release`)
  assert.equal(releaseResponse.ok, true)
  assert.equal(ctx.plugins.resourceCount, 0)
  assert.equal((await rpc(`plugin.${leaseId}.forged.status`)).error.code, 'UPDATE_WAITING')
  assert.equal((await rpc(`plugin.${leaseId}.newWork`)).error.code, 'UPDATE_WAITING')
  assert.equal((await rpc(`plugin.${leaseId}.status`)).ok, true)
  findings.push({ id: 'maintenance-blocks-plugin-task-release', observed: { rpcError: releaseResponse.error, remainingResources: ctx.plugins.resourceCount } })
  ctx.maintenance.draining = false
  assert.equal((await rpc(`plugin.${leaseId}.release`)).ok, true); assert.equal(ctx.plugins.resourceCount, 0)

  const builtinFailures = []
  for (const entry of ctx.plugins.manager.builtinDetails) {
    await assert.rejects(ctx.plugins.manager.change({ id: entry.id, action: 'disable', expectedRevision: 1 }), error => {
      builtinFailures.push({ id: entry.id, code: error.code }); return error.code === 'NOT_FOUND'
    })
  }
  const manifests = await Promise.all((await readdir(join(repository, 'backend/plugins'))).filter(name => name.startsWith('builtin.'))
    .map(async name => JSON.parse(await readFile(join(repository, 'backend/plugins', name, 'webnav.plugin.json'), 'utf8'))))
  findings.push({ id: 'builtin-modules-are-host-integrated', observed: {
    total: manifests.length, withFrontendEntry: manifests.filter(m => m.frontend).length,
    disableRejected: builtinFailures.length,
  } })
} finally {
  importGate.release()
  if (!ctx && boot) ctx = await boot.catch(() => undefined)
  delete globalThis[importKey]
  socket?.terminate()
  if (ctx) { ctx.maintenance.draining = false; await ctx.stop() }
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Audit cleanup outside temporary directory')
  await rm(root, { recursive: true, force: true })
}
})
