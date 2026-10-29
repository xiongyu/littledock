import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function launch(directory, backendPort, uiPort, cwd) {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../../scripts/dev.mjs', import.meta.url))], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LOCALAPPDATA: directory, XDG_STATE_HOME: directory, WEBNAV_NO_TRAY: '1', WEBNAV_DATA_DIR: directory, WEBNAV_PORT: String(backendPort), WEBNAV_UI_PORT: String(uiPort) },
  })
  let output = ''
  const append = bytes => { output = (output + bytes).slice(-6000) }
  child.stdout.on('data', append); child.stderr.on('data', append)
  const stop = async () => {
    if (child.exitCode !== null) return
    const finished = once(child, 'exit')
    if (child.connected) child.send('shutdown')
    const timer = setTimeout(() => child.kill(), 8000)
    await finished; clearTimeout(timer)
  }
  try {
    const deadline = Date.now() + 25_000
    while (!output.includes('WebNav 前后端已就绪')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Dev launcher failed: ' + output)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(output.includes('配对码'), false)
    return { stop }
  } catch (error) { await stop(); throw error }
}
async function pageConnection(backendPort, uiPort) {
  // First visit goes directly to Vite, with no previous cookie and no pairing RPC.
  const origin = `http://127.0.0.1:${uiPort}`
  const page = await fetch(origin)
  assert.equal(page.status, 200)
  const cookie = page.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie); await page.body?.cancel()
  const ws = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`, { origin, headers: { cookie } })
  const [raw] = await once(ws, 'message'), hello = JSON.parse(raw.toString())
  assert.equal(hello.authorized, true)
  return {
    ws,
    async rpc(method, params = {}) {
      const reply = once(ws, 'message')
      ws.send(JSON.stringify({ v: 1, type: 'request', epoch: hello.epoch, id: randomUUID(), operationId: randomUUID(), method, params }))
      const [bytes] = await reply, result = JSON.parse(bytes.toString())
      assert.equal(result.ok, true, JSON.stringify(result.error))
      return result.result
    },
  }
}
test('one dev command starts both services; direct Vite visit loads persisted data without pairing across restarts', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'webnav-dev-test-'))
  const backendPort = await freePort()
  let uiPort = await freePort()
  while (uiPort === backendPort) uiPort = await freePort()
  let runner, page
  t.after(async () => { page?.ws.terminate(); await runner?.stop(); await rm(directory, { recursive: true, force: true }) })
  runner = await launch(directory, backendPort, uiPort, fileURLToPath(new URL('../../frontend/', import.meta.url)))
  page = await pageConnection(backendPort, uiPort)
  const catalog = { schemaVersion: 1, groups: [], servers: [{ id: 'saved', name: 'Persisted test', host: 'example.invalid', groupId: '', tags: [], note: '', favorite: false, connections: [{ id: 'ssh', name: 'SSH', type: 'ssh', port: 22, username: 'test', saveHistory: true }] }] }
  await page.rpc('catalog.replace', { catalog, expectedRevision: 0 })
  page.ws.terminate(); await runner.stop()
  runner = await launch(directory, backendPort, uiPort, fileURLToPath(new URL('../../', import.meta.url)))
  page = await pageConnection(backendPort, uiPort)
  const snapshot = await page.rpc('catalog.watch')
  assert.deepEqual(snapshot.snapshot, catalog)
  assert.equal(snapshot.revision, 1)
})
