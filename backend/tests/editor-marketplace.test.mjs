import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { marketplaceProxy, marketplacePath } from '../src/plugins/remote-editor/marketplace.ts'
import { configureWorkbench } from '../src/plugins/remote-editor/workbench.ts'

async function fixture(t, fetcher, timeout) {
  const proxy = marketplaceProxy(fetcher, timeout)
  const server = createServer((req, res) => {
    if (!proxy.handle(req, res, new URL(req.url, 'http://local').pathname)) res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}${marketplacePath}`
  return { proxy, base, query: body => fetch(base + '/extensionquery', { method: 'POST', body: JSON.stringify(body) }) }
}

test('official gallery queries use local origin; custom galleries and unrelated bootstrap settings are preserved', () => {
  const config = { remoteAuthority: 'remote', productConfiguration: { nameShort: 'Code', extensionsGallery: { serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery', itemUrl: 'https://marketplace.visualstudio.com/items' } } }
  const html = '<meta id="vscode-workbench-web-configuration" data-settings="' + JSON.stringify(config).replaceAll('"', '&quot;') + '">'
  const result = configureWorkbench(html, 'secret', 'http://127.0.0.1:1234')
  assert.match(result, /http:\/\/127\.0\.0\.1:1234\/_webnav\/marketplace/)
  assert.match(result, /https:\/\/marketplace\.visualstudio\.com\/items/)
  assert.match(result, /nameShort/)
  assert.doesNotMatch(configureWorkbench(html.replace('marketplace.visualstudio.com/_apis/public/gallery', 'custom.invalid/gallery'), 'secret', 'http://127.0.0.1:1234'), /_webnav/)
})

test('gallery forwards only the search payload to the fixed vendor endpoint without cookies or authorization', async t => {
  let seen
  const { base } = await fixture(t, async (url, options) => { seen = { url, options }; return Response.json({ results: [{ extensions: [{ extensionName: 'python' }] }] }) })
  const payload = { filters: [{ criteria: [{ filterType: 10, value: 'python' }] }], flags: 950 }
  const response = await fetch(base + '/extensionquery', { method: 'POST', headers: { cookie: 'owner=secret', authorization: 'Bearer secret', 'x-forwarded-for': 'private' }, body: JSON.stringify(payload) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).results[0].extensions[0].extensionName, 'python')
  assert.equal(seen.url, 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery')
  assert.deepEqual(JSON.parse(seen.options.body), payload)
  assert.deepEqual(Object.keys(seen.options.headers).sort(), ['accept', 'content-type'])
  assert.equal(seen.options.redirect, 'error')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-encoding'), 'gzip')
})

test('large compatibility responses retain every version and asset through compression', async t => {
  const data = { results: [{ extensions: [{ versions: [{ version: 'old-compatible', files: [{ source: 'x'.repeat(17 * 1024 * 1024) }] }] }] }] }
  const { query } = await fixture(t, async () => Response.json(data))
  const response = await query({ flags: 439 })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.deepEqual(await response.json(), data)
})

test('gallery rejects unsupported paths, methods, invalid JSON and oversized requests without a network call', async t => {
  let calls = 0
  const { base, query } = await fixture(t, async () => { calls++; throw Error('unexpected') })
  assert.equal((await fetch(base + '/https://other.invalid')).status, 404)
  assert.equal((await fetch(base + '/extensionquery')).status, 405)
  assert.equal((await query([])).status, 400)
  assert.equal((await fetch(base + '/extensionquery', { method: 'POST', body: '{' })).status, 400)
  assert.equal((await query({ data: 'a'.repeat(256 * 1024) })).status, 413)
  assert.equal(calls, 0)
})

test('gallery returns failures instead of an empty success for upstream errors, invalid data or excessive responses', async t => {
  let response = new Response('vendor failure', { status: 503 })
  const { query } = await fixture(t, async () => response)
  assert.equal((await query({})).status, 502)
  response = Response.json({ invalid: true })
  assert.equal((await query({})).status, 502)
  let cancelled = false
  response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }))
  assert.equal((await query({})).status, 502)
  assert.equal(cancelled, true)
})

test('gallery requests have a timeout and closing the gateway cancels pending vendor requests', async t => {
  let cancelled = 0
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled++; reject(Error('aborted')) }, { once: true }))
  const { query } = await fixture(t, pending, 30)
  const response = await query({})
  assert.equal(response.status, 502); assert.match(await response.text(), /超时/)
  assert.equal(cancelled, 1)
  let started
  const ready = new Promise(resolve => { started = resolve })
  const second = await fixture(t, (url, options) => { started(); return pending(url, options) })
  const request = second.query({})
  await ready; second.proxy.close()
  assert.equal((await request).status, 502); assert.equal(cancelled, 2)
})
