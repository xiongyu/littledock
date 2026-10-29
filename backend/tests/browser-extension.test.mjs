import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID, createHmac } from 'node:crypto'
import { WebSocket } from 'ws'
import { createApp } from '../src/app.ts'
import { parsePairingCode, extensionTranscript, extensionCipher, randomExtensionNonce } from '@webnav/shared'

const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32)
const firefoxOrigin = 'moz-extension://11111111-2222-3333-4444-555555555555'
const site = (origin = 'https://example.invalid') => ({ origin, topOrigin: origin })
function mailbox(ws) {
  const queue = [], waiters = [], wire = []
  let closed = false
  ws.on('error', () => {})
  ws.on('message', raw => { wire.push(raw.toString()); const value = JSON.parse(raw.toString()); const waiter = waiters.shift(); if (waiter) { clearTimeout(waiter.timer); waiter.resolve(value) } else queue.push(value) })
  ws.on('close', () => { closed = true; for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('closed')) } })
  return { wire, next() { if (queue.length) return Promise.resolve(queue.shift()); if (closed) return Promise.reject(new Error('closed')); return new Promise((resolve, reject) => { const waiter = { resolve, reject, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('timeout')) }, 5000) }; waiters.push(waiter) }) } }
}
async function page(origin) {
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin, headers: { cookie } }), box = mailbox(ws)
  const hello = await box.next()
  return { ws, cookie, async rpc(method, params = {}, operationId = randomUUID()) {
    const id = randomUUID(); ws.send(JSON.stringify({ v: 1, type: 'request', epoch: hello.epoch, id, method, params, operationId }))
    for (;;) { const result = await box.next(); if (result.id !== id) continue; if (result.ok) return result.result; throw Object.assign(new Error(result.error.message), result.error) }
  } }
}
async function fixture(t) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve))
  const directory = await mkdtemp(join(tmpdir(), 'webnav-extension-test-')), frontendRoot = join(directory, 'ui')
  await mkdir(frontendRoot); await writeFile(join(frontendRoot, 'index.html'), '<html>synthetic fixture</html>')
  const config = { directory, port, frontendRoot, disablePlugins: true, webCapture: async () => Buffer.from([255,216,255,217]) }
  const state = { config, ctx: await createApp(config), origin: `http://127.0.0.1:${port}`, sockets: [] }
  t.after(async () => { for (const ws of state.sockets) ws.terminate(); await state.ctx.stop(); assert.ok(directory.startsWith(join(tmpdir(), 'webnav-extension-test-'))); await rm(directory, { recursive: true, force: true }) })
  state.page = await page(state.origin); state.sockets.push(state.page.ws)
  state.save = (id, url, version = 0) => state.page.rpc('bookmarks.save', { bookmark: { id, name: id, url }, expectedVersion: version, login: { username: 'fixture-user', password: 'fixture-password-123' } })
  state.pair = async (params = {}) => parsePairingCode((await state.page.rpc('extensions.beginPairing', { name: 'Fixture browser', ...params })).code)
  return state
}
async function connect(f, pairing, origin = extensionOrigin, key = pairing.key) {
  const ws = new WebSocket(pairing.endpoint, { origin }), box = mailbox(ws); f.sockets.push(ws)
  const challenge = await box.next()
  if (challenge.type === 'unavailable') throw new Error(challenge.code)
  const nonce = randomExtensionNonce(), transcript = extensionTranscript(pairing.serverId, pairing.endpoint, origin, pairing.id, challenge.nonce, nonce)
  // Use node:crypto independently of the browser's HMAC implementation.
  const proof = createHmac('sha256', Buffer.from(key, 'base64url')).update('client\n' + transcript).digest('base64url')
  const authentication = { v: 1, type: 'authenticate', id: pairing.id, nonce, proof }
  ws.send(JSON.stringify(authentication)); const authenticated = await box.next()
  assert.equal(authenticated.proof, createHmac('sha256', Buffer.from(key, 'base64url')).update('server\n' + transcript).digest('base64url'))
  const cipher = await extensionCipher(key, transcript, 'client')
  return { ws, box, cipher, authentication, async request(method, params = {}) {
    const id = randomUUID(), envelope = await cipher.seal({ id, method, params }); ws.send(JSON.stringify(envelope))
    const result = await cipher.open(await box.next()); assert.equal(result.id, id)
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
    return result.result
  } }
}
const fillParams = (bookmarkId = 'secure', origin = 'https://example.invalid', automatic = false) => ({ bookmarkId, version: 1, site: site(origin), documentToken: randomUUID(), automatic })
async function grant(client, bookmarkId = 'secure', origin = 'https://example.invalid', automatic = true) { return client.request('grant', { ...fillParams(bookmarkId, origin), automatic, operationId: randomUUID() }) }

test('extension route rejects web origins, missing origins, wrong host, unknown identities and key impersonation', async t => {
  const f = await fixture(t), pairing = await f.pair()
  for (const options of [{ origin: 'https://evil.invalid' }, {}, { origin: 'null' }, { origin: extensionOrigin, headers: { Host: 'localhost:' + f.config.port } }]) {
    const ws = new WebSocket(pairing.endpoint, options); f.sockets.push(ws); const box = mailbox(ws)
    await assert.rejects(box.next(), /closed/)
  }
  await assert.rejects(connect(f, pairing, extensionOrigin, randomExtensionNonce()), /closed/)
  const client = await connect(f, pairing)
  assert.deepEqual(await client.request('ping'), {})
  await assert.rejects(connect(f, pairing, 'chrome-extension://' + 'b'.repeat(32)), /closed/)
  await assert.rejects(client.request('bookmarks.reveal', { id: 'secure' }), { code: 'METHOD_NOT_FOUND' })
  assert.equal((await f.page.rpc('extensions.status')).devices.length, 1)
})

test('matching ignores HTTP/HTTPS, keeps custom ports and exact hostnames, and credentials require a per-site grant', async t => {
  const f = await fixture(t)
  await f.save('secure', 'https://example.invalid/login?private=omitted')
  await f.save('port', 'http://example.invalid:8080')
  await f.save('other', 'https://other.invalid')
  const pairing = await f.pair(), client = await connect(f, pairing)
  for (const origin of ['https://example.invalid', 'http://example.invalid']) {
    const result = await client.request('matches', { site: site(origin) })
    assert.deepEqual(result.matches.map(m => m.id), ['secure'])
    assert.equal(JSON.stringify(result).includes('fixture-user'), false)
    await assert.rejects(client.request('fill', fillParams('secure', origin)), { code: 'CONSENT_REQUIRED' })
  }
  for (const origin of ['https://example.invalid.evil.invalid', 'https://sub.example.invalid', 'https://example.invalid:9090']) assert.deepEqual((await client.request('matches', { site: site(origin) })).matches, [])
  assert.deepEqual((await client.request('matches', { site: site('https://example.invalid:8080') })).matches.map(m => m.id), ['port'])
  await assert.rejects(client.request('matches', { site: { origin: 'https://example.invalid', topOrigin: 'https://evil.invalid' } }), { code: 'INVALID_ARGUMENT' })
  await grant(client)
  const filled = await client.request('fill', fillParams('secure', 'http://example.invalid', true))
  assert.equal(filled.password, 'fixture-password-123'); assert.equal(filled.origin, 'http://example.invalid')
  assert.ok(filled.expiresAt <= Date.now() + 5000)
  assert.equal(client.box.wire.some(w => w.includes('fixture-password-123') || w.includes('fixture-user')), false)
  await assert.rejects(client.request('fill', fillParams('other')), { code: 'NOT_FOUND' })
  await assert.rejects(client.request('fill', { ...fillParams(), version: 2 }), { code: 'REVISION_CONFLICT' })
})

test('encrypted packets reject replay, tampering, reflection and reuse across connections', async t => {
  const f = await fixture(t), pairing = await f.pair(), client = await connect(f, pairing)
  const packet = await client.cipher.seal({ id: randomUUID(), method: 'ping', params: {} })
  client.ws.send(JSON.stringify(packet)); const response = await client.box.next(); await client.cipher.open(response)
  client.ws.send(JSON.stringify(packet)); await assert.rejects(client.box.next(), /closed/)
  const second = await connect(f, pairing); second.ws.send(JSON.stringify(packet)); await assert.rejects(second.box.next(), /closed/)
  const third = await connect(f, pairing), valid = await third.cipher.seal({ id: randomUUID(), method: 'ping', params: {} })
  valid.ciphertext = (valid.ciphertext[0] === 'A' ? 'B' : 'A') + valid.ciphertext.slice(1)
  third.ws.send(JSON.stringify(valid)); await assert.rejects(third.box.next(), /closed/)
  const fourth = await connect(f, pairing); fourth.ws.send(JSON.stringify(response)); await assert.rejects(fourth.box.next(), /closed/)
  const fifth = new WebSocket(pairing.endpoint, { origin: extensionOrigin }), box = mailbox(fifth); f.sockets.push(fifth)
  await box.next(); fifth.send(JSON.stringify(client.authentication)); await assert.rejects(box.next(), /closed/)
})

test('pairing cancellation/expiry, explicit revocation and bookmark changes invalidate authorization', async t => {
  const f = await fixture(t)
  const detachedPage = await page(f.origin); f.sockets.push(detachedPage.ws)
  const detached = parsePairingCode((await detachedPage.rpc('extensions.beginPairing', { name: 'Closed page' })).code)
  detachedPage.ws.close(); await once(detachedPage.ws, 'close')
  await assert.rejects(connect(f, detached), /closed/)
  const cancelled = await f.pair(); await f.page.rpc('extensions.cancelPairing', { id: cancelled.id })
  await assert.rejects(connect(f, cancelled), /closed/)
  const expired = await f.pair(); f.ctx.browserExtension.pending.get(expired.id).pairing.expiresAt = Date.now() - 1
  await assert.rejects(connect(f, expired), /closed/)
  await f.save('secure', 'https://example.invalid')
  const pairing = await f.pair(), client = await connect(f, pairing, firefoxOrigin); await grant(client)
  await f.page.rpc('extensions.revokeGrant', { id: pairing.id, bookmarkId: 'secure' }); await assert.rejects(client.box.next(), /closed/)
  const again = await connect(f, pairing, firefoxOrigin)
  await assert.rejects(again.request('fill', fillParams()), { code: 'CONSENT_REQUIRED' }); await grant(again)
  await f.save('secure', 'https://new.invalid', 1); await assert.rejects(again.box.next(), /closed/)
  assert.equal((await f.page.rpc('extensions.status')).devices[0].grants.length, 0)
  await f.page.rpc('extensions.revoke', { id: pairing.id })
  assert.equal(f.ctx.credentials.extensionKey(pairing.id), undefined)
  await assert.rejects(connect(f, pairing, firefoxOrigin), /closed/)
})

test('vault migration, expiry/lock and restart keep local identities out of sync and require unlock', async t => {
  const f = await fixture(t); await f.save('secure', 'https://example.invalid')
  const pairing = await f.pair(), client = await connect(f, pairing); await grant(client)
  const encoded = () => f.ctx.storage.db.prepare('SELECT secret FROM credentials WHERE id=?').get(`extension:${pairing.id}`).secret
  assert.equal(Buffer.from(encoded(), 'base64').toString(), pairing.key)
  await f.page.rpc('vault.update', { mode: 'master', password: 'fixture-master-password', unlockMinutes: 5 })
  assert.equal(encoded().split('.').length, 3); assert.equal(f.ctx.credentials.extensionKey(pairing.id), pairing.key)
  assert.equal(f.ctx.credentials.exportSyncSecrets().some(s => s.id.startsWith('extension:')), false)
  await assert.rejects(f.page.rpc('bookmarks.reveal', { id: 'secure', version: 1 }), { code: 'MASTER_PASSWORD_REQUIRED' })
  await assert.rejects(f.page.rpc('extensions.beginPairing', { name: 'No verification' }), { code: 'MASTER_PASSWORD_REQUIRED' })
  await f.page.rpc('vault.lock'); await assert.rejects(client.box.next(), /closed/)
  await assert.rejects(connect(f, pairing), /VAULT_LOCKED/)
  await f.page.rpc('vault.unlock', { password: 'fixture-master-password' })
  f.page.ws.terminate(); await f.ctx.stop(); f.ctx = await createApp(f.config)
  await assert.rejects(connect(f, pairing), /VAULT_LOCKED/)
  f.page = await page(f.origin); f.sockets.push(f.page.ws)
  await f.page.rpc('vault.unlock', { password: 'fixture-master-password' })
  const restarted = await connect(f, pairing); assert.equal((await restarted.request('fill', fillParams())).password, 'fixture-password-123')
  await f.page.rpc('vault.update', { mode: 'local', unlockMinutes: 0 })
  assert.equal(Buffer.from(encoded(), 'base64').toString(), pairing.key)
})

test('one auto account per site, operation IDs deduplicate grants, and pairing secrets are not operation results', async t => {
  const f = await fixture(t); await f.save('secure', 'https://example.invalid'); await f.save('second', 'http://example.invalid')
  const operationId = randomUUID(), result = await f.page.rpc('extensions.beginPairing', { name: 'Test' }, operationId)
  await assert.rejects(f.page.rpc('extensions.beginPairing', { name: 'Test' }, operationId), { code: 'ALREADY_REQUESTED' })
  const operation = await f.page.rpc('operations.get', { operationId })
  assert.equal(JSON.stringify(operation).includes(result.code), false)
  const client = await connect(f, parsePairingCode(result.code)); await grant(client)
  const params = { ...fillParams('second', 'http://example.invalid'), automatic: true, operationId: randomUUID() }
  await client.request('grant', params); await assert.rejects(client.request('grant', params), { code: 'ALREADY_REQUESTED' })
  const choices = (await client.request('matches', { site: site() })).matches
  assert.deepEqual(choices.filter(c => c.automatic).map(c => c.id), ['second'])
  await assert.rejects(client.request('fill', fillParams('secure', 'https://example.invalid', true)), { code: 'CONSENT_REQUIRED' })
})

test('extension saves a page and credentials atomically through the encrypted channel without exposing secrets or granting fill', async t => {
  const f = await fixture(t), pairing = await f.pair()
  await f.page.rpc('vault.update', { mode: 'master', password: 'fixture-save-master', unlockMinutes: 5 })
  const client = await connect(f, pairing), observer = await connect(f, pairing)
  const params = { site: site(), bookmark: { id: randomUUID(), name: 'Saved from extension', url: 'https://example.invalid/login?next=home' }, expectedVersion: 0, operationId: randomUUID(), login: { username: 'captured-fixture-user', password: 'captured-fixture-password' } }
  const result = await client.request('saveBookmark', params)
  assert.deepEqual(result, { saved: true, bookmarkId: params.bookmark.id, version: 1 })
  await assert.rejects(observer.box.next(), /closed/)
  assert.deepEqual(f.ctx.credentials.bookmarkLogin(params.bookmark.id), params.login)
  const stored = f.ctx.storage.db.prepare('SELECT secret FROM credentials WHERE id=?').get(`bookmark:${params.bookmark.id}`).secret
  assert.equal(stored.split('.').length, 3)
  assert.equal(JSON.stringify(f.ctx.webBookmarks.snapshot()).includes(params.login.password), false)
  assert.equal(client.box.wire.some(raw => raw.includes(params.login.password) || raw.includes(params.login.username)), false)
  assert.equal(f.ctx.browserExtension.status().devices[0].grants.length, 0)
  await assert.rejects(client.request('fill', fillParams(params.bookmark.id)), { code: 'CONSENT_REQUIRED' })
  await assert.rejects(client.request('saveBookmark', params), { code: 'ALREADY_REQUESTED' })
  client.ws.close(); await once(client.ws, 'close')
  const again = await connect(f, pairing)
  await assert.rejects(again.request('saveBookmark', params), { code: 'ALREADY_REQUESTED' })
  await assert.rejects(again.request('saveBookmark', { ...params, operationId: randomUUID() }), { code: 'REVISION_CONFLICT' })
  assert.equal(f.ctx.webBookmarks.snapshot().bookmarks.length, 1)
  await f.page.rpc('vault.lock'); await assert.rejects(again.box.next(), /closed/)
  await assert.rejects(connect(f, pairing), /VAULT_LOCKED/)
})

test('extension save targets and updates stay within the exact site and port with version checks and optional credentials', async t => {
  const f = await fixture(t)
  await f.save('old', 'http://example.invalid/'); await f.save('other', 'https://other.invalid/'); await f.save('port', 'https://example.invalid:8080/')
  await f.page.rpc('bookmarks.save', { bookmark: { id: 'plain', name: 'No login', url: 'https://example.invalid/docs' }, expectedVersion: 0 })
  const client = await connect(f, await f.pair())
  assert.deepEqual((await client.request('saveTargets', { site: site() })).targets.map(b => b.id), ['old', 'plain'])
  const params = { site: site(), bookmark: { id: 'old', name: 'Updated page', url: 'https://example.invalid/new' }, expectedVersion: 1, operationId: randomUUID() }
  await client.request('saveBookmark', params)
  assert.equal(f.ctx.credentials.bookmarkLogin('old').password, 'fixture-password-123')
  await assert.rejects(client.request('saveBookmark', { ...params, operationId: randomUUID() }), { code: 'REVISION_CONFLICT' })
  for (const id of ['other', 'port']) await assert.rejects(client.request('saveBookmark', { ...params, bookmark: { ...params.bookmark, id }, operationId: randomUUID() }), { code: 'NOT_FOUND' })
  for (const url of ['https://other.invalid/', 'https://example.invalid:8080/', 'https://user:pass@example.invalid/', 'javascript:alert(1)']) await assert.rejects(client.request('saveBookmark', { ...params, bookmark: { ...params.bookmark, url }, operationId: randomUUID() }), { code: 'INVALID_ARGUMENT' })
  for (const login of [{ username: 'x', password: 'bad\0secret' }, { username: 'x', password: 'x'.repeat(4097) }, { username: '', password: '' }, null]) await assert.rejects(client.request('saveBookmark', { ...params, expectedVersion: 2, login, operationId: randomUUID() }), { code: 'INVALID_ARGUMENT' })
  assert.equal(f.ctx.webBookmarks.snapshot().bookmarks.find(b => b.id === 'old').version, 2)
  assert.equal(f.ctx.credentials.bookmarkLogin('old').password, 'fixture-password-123')
  const login = { username: 'updated-fixture', password: 'updated-fixture-secret' }
  await client.request('saveBookmark', { ...params, expectedVersion: 2, login, operationId: randomUUID() })
  assert.deepEqual(f.ctx.credentials.bookmarkLogin('old'), login)
  const fresh = { site: site(), bookmark: { id: randomUUID(), name: 'Page only', url: 'https://example.invalid/page' }, expectedVersion: 0, operationId: randomUUID() }
  await client.request('saveBookmark', fresh)
  assert.equal(f.ctx.webBookmarks.snapshot().bookmarks.find(b => b.id === fresh.bookmark.id).hasLogin, false)
  assert.equal(JSON.stringify(await client.request('saveTargets', { site: site() })).includes(login.password), false)
})
