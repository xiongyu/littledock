import { extensionRecord, extensionString, parsePairingCode, parseExtensionSaveTargets, validateBookmark, websiteOrigin, websiteIdentity, type ExtensionMatch, type ExtensionSaveTarget } from '@webnav/shared'
import { browser, type MessageSender } from './browser'
import { LocalConnection } from './connection'
import { readConfig, writeConfig } from './storage'

let connection: LocalConnection | undefined, connectionId = '', configChanges = Promise.resolve()
const inFlight = new Set<number>()
type CaptureDraft = { tabId: number; url: string; documentToken: string; local: LocalConnection; generation: number; expiresAt: number; targets: ExtensionSaveTarget[] }
// Only non-secret binding metadata is retained here; form values live in the open popup.
const captures = new Map<string, CaptureDraft>()
const ownOrigin = new URL(browser.runtime.getURL('')).origin
// Firefox's extension URL origin is not consistently serialized by URL.origin.
const extensionOrigin = ownOrigin === 'null' ? browser.runtime.getURL('').replace(/\/$/, '') : ownOrigin
function permissionPatterns(origin: string) { const url = new URL(origin); return [`http://${url.hostname}/*`, `https://${url.hostname}/*`] }
async function client() {
  const config = await readConfig()
  if (!config) throw new Error('请先在小站全局设置中生成配对码。')
  if (!connection || connectionId !== config.pairing.id) { connection?.close(); connection = new LocalConnection(config.pairing, extensionOrigin); connectionId = config.pairing.id }
  return connection
}
async function refreshScripts() {
  const config = await readConfig(), patterns: string[] = []
  for (const origin of config?.automaticOrigins ?? []) {
    const sitePatterns = permissionPatterns(origin)
    if (await browser.permissions.contains({ origins: sitePatterns })) for (const pattern of sitePatterns) if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  const existing = await browser.scripting.getRegisteredContentScripts()
  const old = existing.find(s => s.id === 'webnav-autofill')
  if (old && JSON.stringify([...old.matches].sort()) === JSON.stringify([...patterns].sort())) return
  if (old) await browser.scripting.unregisterContentScripts({ ids: [old.id] })
  if (patterns.length) await browser.scripting.registerContentScripts([{ id: 'webnav-autofill', matches: patterns, js: ['content.js'], allFrames: false, runAt: 'document_idle', persistAcrossSessions: true }])
}
async function tabOrigin(tabId: number) {
  const tab = await browser.tabs.get(tabId)
  if (!tab.url) throw new Error('无法读取当前网页，请从需要填写的网页打开扩展。')
  return websiteOrigin(tab.url)
}
function tabNumber(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('标签页无效。'); return Number(value) }
async function probe(tabId: number, inject: boolean) {
  if (inject) await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] })
  return extensionRecord(await browser.tabs.sendMessage(tabId, { type: 'webnav.probe' }, { frameId: 0 }))
}
async function fill(tabId: number, match: ExtensionMatch, origin: string, documentToken: string, automatic: boolean) {
  const local = await client()
  await local.connect()
  const authorization = local.generation
  const result = extensionRecord(await local.request('fill', { site: { origin, topOrigin: origin }, bookmarkId: match.id, version: match.version, documentToken, automatic }))
  if (await tabOrigin(tabId) !== origin || !local.authorized(authorization) || result.origin !== origin || result.documentToken !== documentToken || typeof result.expiresAt !== 'number' || result.expiresAt <= Date.now()) throw new Error('页面或授权已变化，请重新选择账号。')
  // Plaintext only travels to the specific top-frame document; never back to a requesting content script or popup.
  const outcome = extensionRecord(await browser.tabs.sendMessage(tabId, { type: 'webnav.fill', ...result, automatic }, { frameId: 0 }))
  if (outcome.filled !== true) throw new Error('没有找到可安全填写的空登录表单，或页面已变化。')
  return { filled: true }
}
function matches(value: unknown): ExtensionMatch[] {
  const result = extensionRecord(value)
  if (!Array.isArray(result.matches) || result.matches.length > 200) throw new Error('账号列表无效。')
  return result.matches.map(value => {
    const row = extensionRecord(value)
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.allowed !== 'boolean' || typeof row.automatic !== 'boolean') throw new Error('账号信息无效。')
    return { id: extensionString(row.id, 100), name: extensionString(row.name, 60), usernameHint: extensionString(row.usernameHint, 256), version: Number(row.version), allowed: row.allowed, automatic: row.automatic }
  })
}
async function autoFill(sender: MessageSender, message: Record<string, unknown>) {
  if (sender.id !== browser.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url) throw new Error('不允许的页面消息。')
  const tabId = sender.tab.id, origin = websiteOrigin(sender.url), config = await readConfig()
  if (!config?.automaticOrigins.some(saved => websiteIdentity(saved) === websiteIdentity(origin)) || inFlight.has(tabId) || await tabOrigin(tabId) !== origin) return { filled: false }
  inFlight.add(tabId)
  try {
    const documentToken = extensionString(message.documentToken, 100), current = await probe(tabId, false)
    if (current.documentToken !== documentToken || current.origin !== origin || current.fillable !== true) return { filled: false }
    const choices = matches(await (await client()).request('matches', { site: { origin, topOrigin: origin } })).filter(m => m.allowed && m.automatic)
    if (choices.length !== 1) return { filled: false }
    return await fill(tabId, choices[0]!, origin, documentToken, true)
  } finally { inFlight.delete(tabId) }
}
async function captureDraft(id: string) {
  const draft = captures.get(id)
  if (!draft || draft.expiresAt <= Date.now() || !draft.local.authorized(draft.generation) || (await browser.tabs.get(draft.tabId)).url !== draft.url) {
    captures.delete(id); throw new Error('网页或连接已变化，请重新读取当前网页。')
  }
  const current = await probe(draft.tabId, false)
  if (current.documentToken !== draft.documentToken) { captures.delete(id); throw new Error('网页已刷新，请重新读取当前网页。') }
  return draft
}
async function capturePage(message: Record<string, unknown>) {
  const tabId = tabNumber(message.tabId), tab = await browser.tabs.get(tabId), origin = websiteOrigin(tab.url)
  if (origin !== message.origin) throw new Error('当前网页已改变，请重新打开扩展。')
  for (const [id, draft] of captures) if (draft.expiresAt <= Date.now() || !draft.local.authorized(draft.generation)) captures.delete(id)
  if (captures.size >= 8 || inFlight.has(tabId)) throw new Error('请先完成当前操作。')
  inFlight.add(tabId)
  try {
    const local = await client()
    const result = extensionRecord(await local.request('saveTargets', { site: { origin, topOrigin: origin } })), generation = local.generation
    const current = await probe(tabId, true), documentToken = extensionString(current.documentToken, 100)
    const captured = extensionRecord(await browser.tabs.sendMessage(tabId, { type: 'webnav.capture', documentToken }, { frameId: 0 }))
    if (!local.authorized(generation) || captured.documentToken !== documentToken || captured.origin !== origin || captured.url !== tab.url || (await browser.tabs.get(tabId)).url !== tab.url) throw new Error('页面或连接已变化，请重新读取。')
    const id = crypto.randomUUID(), bookmark = validateBookmark({ id, name: (tab.title?.trim() || new URL(tab.url!).hostname).slice(0, 60), url: tab.url })
    const targets = parseExtensionSaveTargets(result.targets), expiresAt = Date.now() + 120_000
    captures.set(id, { tabId, url: bookmark.url, documentToken, local, generation, expiresAt, targets })
    return { captureId: id, name: bookmark.name, url: bookmark.url, targets, expiresAt, captured: captured.captured === true,
      username: typeof captured.username === 'string' && captured.username.length <= 256 ? captured.username : '',
      password: typeof captured.password === 'string' && captured.password.length <= 4096 ? captured.password : '' }
  } finally { inFlight.delete(tabId) }
}
async function savePage(message: Record<string, unknown>) {
  const id = extensionString(message.captureId, 100), draft = await captureDraft(id), origin = websiteOrigin(draft.url)
  if (inFlight.has(draft.tabId)) throw new Error('正在处理当前网页，请稍后再试。')
  const target = message.targetId === '' ? undefined : draft.targets.find(t => t.id === message.targetId)
  if (message.targetId !== '' && !target) throw new Error('请选择当前网站的已有收藏，或新增收藏。')
  const bookmark = validateBookmark({ id: target?.id ?? id, name: message.name, url: message.url })
  if (websiteOrigin(bookmark.url) !== origin) throw new Error('收藏地址必须属于当前网页的网站。')
  let login: { username: string; password: string } | undefined
  if (message.login !== undefined) {
    const value = extensionRecord(message.login)
    if (typeof value.username !== 'string' || typeof value.password !== 'string' || value.username.length > 256 || value.password.length > 4096 || (!value.username && !value.password) || value.username.includes('\0') || value.password.includes('\0')) throw new Error('请填写账号或密码，或取消保存账号密码。')
    login = { username: value.username, password: value.password }
  }
  // A draft is single-use once submitted. Unknown outcomes are checked in 小站, never replayed.
  captures.delete(id); inFlight.add(draft.tabId)
  try {
    return await draft.local.request('saveBookmark', { site: { origin, topOrigin: origin }, bookmark, expectedVersion: target?.version ?? 0, operationId: id, ...(login ? { login } : {}) })
  } finally { draft.local.close(); inFlight.delete(draft.tabId) }
}
async function popup(message: Record<string, unknown>) {
  if (message.type === 'capturePage') return capturePage(message)
  if (message.type === 'savePage') return savePage(message)
  if (message.type === 'captureStatus') { await captureDraft(extensionString(message.captureId, 100)); return { valid: true } }
  if (message.type === 'discardCapture') { captures.delete(extensionString(message.captureId, 100)); return {} }
  if (message.type === 'status') {
    const config = await readConfig()
    return { paired: !!config, endpoint: config?.pairing.endpoint, automaticOrigins: config?.automaticOrigins ?? [] }
  }
  if (message.type === 'pair') {
    const pairing = parsePairingCode(extensionString(message.code, 1500).trim())
    if (pairing.expiresAt <= Date.now()) throw new Error('配对码已过期，请重新生成。')
    // Save before sending: if the success response is lost, reconnect using this identity instead of re-enrolling.
    connection?.close(); connection = undefined; captures.clear()
    await writeConfig({ pairing, automaticOrigins: [] }); await refreshScripts()
    await (await client()).connect()
    return { paired: true }
  }
  if (message.type === 'forget') {
    connection?.close(); connection = undefined; connectionId = ''; captures.clear()
    await writeConfig(); await refreshScripts(); return {}
  }
  if (message.type === 'openWebNav') {
    const config = await readConfig(), url = config ? new URL(config.pairing.endpoint) : new URL('ws://127.0.0.1:3030')
    await browser.tabs.create({ url: `http://${url.host}/` }); return {}
  }
  if (message.type === 'matches' || message.type === 'manualFill') {
    const tabId = tabNumber(message.tabId), origin = await tabOrigin(tabId)
    if (origin !== message.origin) throw new Error('当前网页已改变，请重新打开扩展。')
    const choices = matches(await (await client()).request('matches', { site: { origin, topOrigin: origin } }))
    if (message.type === 'matches') return { matches: choices }
    if (inFlight.has(tabId)) throw new Error('正在填写，请稍后再试。')
    const choice = choices.find(m => m.id === message.bookmarkId)
    if (!choice || typeof message.automatic !== 'boolean') throw new Error('请选择当前网站的账号。')
    const patterns = permissionPatterns(origin)
    if (message.automatic && !await browser.permissions.contains({ origins: patterns })) throw new Error('自动填写需要此网站的访问权限。')
    inFlight.add(tabId)
    try {
      const current = await probe(tabId, true)
      if (current.origin !== origin || current.fillable !== true) throw new Error('当前页没有可安全填写的空登录表单；请先清空账号密码框。')
      const local = await client()
      await local.request('grant', { site: { origin, topOrigin: origin }, bookmarkId: choice.id, version: choice.version, automatic: message.automatic, operationId: crypto.randomUUID() })
      const config = await readConfig()
      if (!config) throw new Error('配对已取消。')
      config.automaticOrigins = config.automaticOrigins.filter(v => websiteIdentity(v) !== websiteIdentity(origin))
      if (message.automatic) config.automaticOrigins.push(origin)
      await writeConfig(config); await refreshScripts()
      return await fill(tabId, choice, origin, extensionString(current.documentToken, 100), false)
    } finally { inFlight.delete(tabId) }
  }
  throw new Error('不支持的扩展操作。')
}

browser.runtime.onMessage.addListener((input, sender, respond) => {
  let message: Record<string, unknown>
  try { message = extensionRecord(input) } catch { return }
  const trustedPopup = sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('popup.html')
  if (!trustedPopup && message.type !== 'webnav.autoFill') return
  const run = async () => {
    try { const result = trustedPopup ? await popup(message) : await autoFill(sender, message); respond({ ok: true, result }) }
    catch (cause) { respond({ ok: false, error: cause instanceof Error ? cause.message : '扩展操作失败。' }) }
  }
  // Serialize settings changes so two popups cannot race enrollment, forget, or site permissions.
  if (trustedPopup) configChanges = configChanges.then(run, run)
  else void run()
  return true
})
browser.runtime.onInstalled.addListener(() => { void refreshScripts().catch(() => {}) })
browser.runtime.onStartup.addListener(() => { void refreshScripts().catch(() => {}) })
browser.permissions.onRemoved.addListener(() => { void refreshScripts().catch(() => {}) })
void refreshScripts().catch(() => {})
