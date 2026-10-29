import test from 'node:test'
import assert from 'node:assert/strict'
import { websiteIdentity, websiteOrigin, extensionEndpoint, parseExtensionSite, pairingCode, parsePairingCode, randomExtensionNonce } from '@webnav/shared'
test('HTTP/HTTPS share hostname matching, default ports normalize and custom ports stay distinct', () => {
  assert.equal(websiteIdentity('http://Example.COM:80/path?token=secret#x'), websiteIdentity('https://example.com:443/'))
  assert.equal(websiteIdentity('http://example.com:8080'), websiteIdentity('https://example.com:8080'))
  assert.notEqual(websiteIdentity('https://example.com:8080'), websiteIdentity('http://example.com:9090'))
  assert.notEqual(websiteIdentity('https://example.com'), websiteIdentity('https://sub.example.com'))
  assert.notEqual(websiteIdentity('https://example.com'), websiteIdentity('https://example.com.attacker.invalid'))
  assert.equal(websiteOrigin('https://example.com/path?token=secret#x'), 'https://example.com')
  assert.throws(() => websiteOrigin('https://user:secret@example.com'))
  assert.throws(() => parseExtensionSite({ origin: 'https://example.com', topOrigin: 'http://example.com' }))
})
test('pairing endpoints are literal loopback WebSockets without credentials, queries or fragments', () => {
  const sample = { v: 1, id: crypto.randomUUID(), key: randomExtensionNonce(), serverId: crypto.randomUUID(), endpoint: 'ws://127.0.0.1:3030/ws/extension', expiresAt: Date.now() + 1000 }
  assert.deepEqual(parsePairingCode(pairingCode(sample)), sample)
  for (const endpoint of ['ws://localhost:3030/ws/extension','ws://192.168.1.1/ws/extension','ws://127.0.0.1.attacker.invalid/ws/extension','ws://127.0.0.1:3030/ws/extension?token=x','wss://127.0.0.1/ws/extension','ws://127.0.0.1:3030/ws','ws://u:p@127.0.0.1/ws/extension']) assert.throws(() => extensionEndpoint(endpoint))
})
