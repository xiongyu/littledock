/** Public contracts for the separately authenticated browser extension. No vault material belongs here. */
export interface ExtensionPairing {
  v: 1
  id: string
  key: string
  serverId: string
  endpoint: string
  expiresAt: number
}
export interface ExtensionGrant { bookmarkId: string; name: string; origin: string; automatic: boolean }
export interface ExtensionDevice { id: string; name: string; origin: string; createdAt: number; lastUsedAt: number; grants: ExtensionGrant[] }
export interface ExtensionStatus { devices: ExtensionDevice[] }
export interface ExtensionMatch { id: string; name: string; version: number; usernameHint: string; allowed: boolean; automatic: boolean }
export interface ExtensionSite { origin: string; topOrigin: string }
export interface ExtensionSaveTarget { id: string; name: string; version: number; hasLogin: boolean }

export function parseExtensionSaveTargets(value: unknown): ExtensionSaveTarget[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('网页收藏列表不正确。')
  return value.map(item => {
    const row = extensionRecord(item)
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.hasLogin !== 'boolean') throw new Error('网页收藏版本不正确。')
    return { id: extensionString(row.id, 100), name: extensionString(row.name, 60), version: Number(row.version), hasLogin: row.hasLogin }
  })
}

export function extensionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('扩展消息格式不正确。')
  return value as Record<string, unknown>
}
export function extensionString(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('扩展字段格式不正确。')
  return value
}
export function websiteOrigin(value: unknown): string {
  const text = extensionString(value, 2048), url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') throw new Error('仅支持 HTTP 或 HTTPS 网页。')
  return url.origin
}
/** HTTP and HTTPS share a hostname; standard ports are equivalent, custom ports stay separate. */
export function websiteIdentity(value: unknown): string {
  const url = new URL(websiteOrigin(value))
  return url.hostname + (url.port ? ':' + url.port : '')
}
export function parseExtensionSite(value: unknown): ExtensionSite {
  const row = extensionRecord(value), origin = websiteOrigin(row.origin), topOrigin = websiteOrigin(row.topOrigin)
  if (origin !== row.origin || topOrigin !== row.topOrigin || origin !== topOrigin) throw new Error('仅允许当前顶层网页的精确来源。')
  return { origin, topOrigin }
}
export function extensionEndpoint(value: unknown): string {
  const text = extensionString(value, 200), url = new URL(text)
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/ws/extension' || url.search || url.hash || text !== url.href) throw new Error('扩展只能连接 127.0.0.1 上的 WebNav。')
  return text
}
export function isExtensionOrigin(value: string): boolean {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(value) || /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}
export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
export function decodeBytes(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 48000) throw new Error('编码不正确。')
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))
  if ((length !== undefined && bytes.length !== length) || encodeBytes(bytes) !== value) throw new Error('编码长度不正确。')
  return bytes
}
export function randomExtensionNonce(): string { return encodeBytes(crypto.getRandomValues(new Uint8Array(32))) }
export function parseExtensionPairing(value: unknown): ExtensionPairing {
  const row = extensionRecord(value)
  if (row.v !== 1 || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) < 1) throw new Error('配对信息不正确。')
  const id = extensionString(row.id, 36), serverId = extensionString(row.serverId, 36), key = extensionString(row.key, 43)
  if (![id, serverId].every(v => /^[0-9a-f-]{36}$/.test(v))) throw new Error('配对编号不正确。')
  decodeBytes(key, 32)
  return { v: 1, id, serverId, key, endpoint: extensionEndpoint(row.endpoint), expiresAt: Number(row.expiresAt) }
}
export function pairingCode(pairing: ExtensionPairing): string { return 'wn1.' + encodeBytes(new TextEncoder().encode(JSON.stringify(pairing))) }
export function parsePairingCode(value: string): ExtensionPairing {
  if (!value.startsWith('wn1.') || value.length > 1500) throw new Error('请粘贴 WebNav 全局设置生成的完整配对码。')
  return parseExtensionPairing(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(value.slice(4)))))
}

const utf8 = new TextEncoder()
/** Domain separated mutual PSK authentication; both random nonces bind fresh directional session keys. */
export function extensionTranscript(serverId: string, endpoint: string, origin: string, id: string, serverNonce: string, clientNonce: string): string {
  if (!isExtensionOrigin(origin)) throw new Error('扩展来源不正确。')
  decodeBytes(serverNonce, 32); decodeBytes(clientNonce, 32)
  return JSON.stringify(['WebNav extension v1', serverId, extensionEndpoint(endpoint), origin, id, serverNonce, clientNonce])
}
async function hmacKey(key: string) { return crypto.subtle.importKey('raw', decodeBytes(key, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) }
export async function extensionProof(key: string, transcript: string, side: 'client' | 'server'): Promise<string> {
  return encodeBytes(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), utf8.encode(side + '\n' + transcript))))
}
export async function verifyExtensionProof(key: string, transcript: string, side: 'client' | 'server', proof: string): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(key), decodeBytes(proof, 32), utf8.encode(side + '\n' + transcript))
}
export interface ExtensionEnvelope { v: 1; seq: number; ciphertext: string }
/** One channel per connection; callers serialize send/receive. Never reuse a channel after a failed receive. */
export async function extensionCipher(key: string, transcript: string, side: 'client' | 'server') {
  const material = await crypto.subtle.importKey('raw', decodeBytes(key, 32), 'HKDF', false, ['deriveKey'])
  const salt = await crypto.subtle.digest('SHA-256', utf8.encode(transcript))
  const derive = (direction: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode('WebNav extension v1 ' + direction) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const outgoing = side === 'client' ? 'client-to-server' : 'server-to-client', incoming = side === 'client' ? 'server-to-client' : 'client-to-server'
  const sendKey = await derive(outgoing), receiveKey = await derive(incoming)
  let sent = 0, received = 0
  const nonce = (seq: number) => { const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, BigInt(seq)); return iv }
  const aad = (direction: string, seq: number) => utf8.encode(JSON.stringify([1, direction, seq]))
  return {
    async seal(value: unknown): Promise<ExtensionEnvelope> {
      const plaintext = utf8.encode(JSON.stringify(value))
      if (plaintext.length > 24000 || sent >= 1_000_000) throw new Error('扩展消息超出限制。')
      const seq = ++sent
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(seq), additionalData: aad(outgoing, seq) }, sendKey, plaintext)
      return { v: 1, seq, ciphertext: encodeBytes(new Uint8Array(ciphertext)) }
    },
    async open(value: unknown): Promise<Record<string, unknown>> {
      const row = extensionRecord(value)
      if (row.v !== 1 || row.seq !== received + 1 || received >= 1_000_000) throw new Error('扩展消息重复或顺序错误。')
      const seq = Number(row.seq), ciphertext = decodeBytes(extensionString(row.ciphertext, 33000))
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(seq), additionalData: aad(incoming, seq) }, receiveKey, ciphertext)
      const result = extensionRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)))
      received = seq
      return result
    },
  }
}
