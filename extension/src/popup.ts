import { extensionRecord, extensionString, parseExtensionSaveTargets, websiteOrigin, type ExtensionMatch } from '@webnav/shared'
import { browser } from './browser'
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = element('status'), error = element('error'), pairForm = element<HTMLFormElement>('pair-form'), pairCode = element<HTMLTextAreaElement>('pair-code')
const accounts = element<HTMLSelectElement>('accounts'), fillForm = element<HTMLFormElement>('fill-form'), automatic = element<HTMLInputElement>('automatic')
const saveForm = element<HTMLFormElement>('save-form'), captureButton = element<HTMLButtonElement>('capture-page'), saveTarget = element<HTMLSelectElement>('save-target')
const saveName = element<HTMLInputElement>('save-name'), saveUrl = element<HTMLInputElement>('save-url'), saveUsername = element<HTMLInputElement>('save-username'), savePassword = element<HTMLInputElement>('save-password'), saveLogin = element<HTMLInputElement>('save-login')
let tabId: number | undefined, origin = '', choices: ExtensionMatch[] = [], busy = false
let captureId = '', captureExpiry = 0, checkingCapture = false, alive = true
function clearCapture() {
  const old = captureId; captureId = ''; captureExpiry = 0
  document.body.classList.remove('saving')
  saveUsername.value = ''; savePassword.value = ''; saveName.value = ''; saveUrl.value = ''; saveTarget.replaceChildren(); saveForm.hidden = true
  if (old) void send('discardCapture', { captureId: old }).catch(() => {})
}
async function send(type: string, params: Record<string, unknown> = {}) {
  const response = extensionRecord(await browser.runtime.sendMessage({ type, ...params }))
  if (response.ok !== true) throw new Error(typeof response.error === 'string' ? response.error : '扩展操作失败。')
  return extensionRecord(response.result)
}
function report(cause: unknown) { error.textContent = cause instanceof Error ? cause.message : '扩展操作失败。' }
async function action(run: () => Promise<void>) {
  if (busy) return
  busy = true; error.textContent = ''; document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true })
  try { await run() } catch (cause) { report(cause) }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false }) }
}
function selected() {
  const choice = choices.find(c => c.id === accounts.value)
  automatic.checked = choice?.automatic ?? false
}
async function load() {
  clearCapture(); captureButton.hidden = true
  const state = await send('status')
  pairForm.hidden = state.paired === true; element('paired-tools').hidden = state.paired !== true; fillForm.hidden = true
  if (!state.paired) { status.textContent = '先连接本机 WebNav'; return }
  status.textContent = '已保存配对 · 正在检查当前网站'
  const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0]
  if (tab?.id === undefined || !tab.url) { status.textContent = '请在登录网页点击扩展图标'; return }
  try { origin = websiteOrigin(tab.url) } catch { status.textContent = '请切换到 HTTP 或 HTTPS 登录网页'; return }
  tabId = tab.id; element('site').textContent = origin
  const result = await send('matches', { tabId, origin })
  if (!Array.isArray(result.matches)) throw new Error('网站账号列表不正确。')
  choices = result.matches as ExtensionMatch[]; accounts.replaceChildren()
  for (const choice of choices) { const option = document.createElement('option'); option.value = choice.id; option.textContent = `${choice.name} · ${choice.usernameHint}`; accounts.append(option) }
  const preferred = choices.find(c => c.automatic); if (preferred) accounts.value = preferred.id
  selected()
  status.textContent = choices.length ? '已连接 · 只填写当前网站' : '尚未收藏，可直接保存当前网页和已输入的账号密码'
  fillForm.hidden = !choices.length
  captureButton.hidden = false
}
function captureOptions() {
  saveUsername.disabled = savePassword.disabled = !saveLogin.checked
  element('save-submit').textContent = saveTarget.value ? '更新这条收藏' : '保存到 WebNav'
  element('save-change-hint').textContent = saveTarget.value ? (saveLogin.checked ? '将更新所选收藏的名称、网址和账号密码。' : '将更新名称和网址，保留已有账号密码。') : '保存后会出现在 WebNav 首页。'
}
captureButton.addEventListener('click', () => { void action(async () => {
  clearCapture()
  const result = await send('capturePage', { tabId, origin })
  if (!alive) { void send('discardCapture', { captureId: result.captureId }).catch(() => {}); return }
  captureId = extensionString(result.captureId, 100); captureExpiry = Number(result.expiresAt)
  saveName.value = extensionString(result.name, 60); saveUrl.value = extensionString(result.url, 2048)
  saveUsername.value = typeof result.username === 'string' ? result.username : ''; savePassword.value = typeof result.password === 'string' ? result.password : ''
  saveLogin.checked = result.captured === true && !!(saveUsername.value || savePassword.value)
  const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = '新增网页收藏'; saveTarget.append(fresh)
  for (const target of parseExtensionSaveTargets(result.targets)) { const option = document.createElement('option'); option.value = target.id; option.textContent = `更新：${target.name}`; saveTarget.append(option) }
  element('capture-hint').textContent = result.captured === true ? '已读取当前登录框，请检查后保存。' : '未识别到明确的登录账密，可手动补充，或只收藏网页。'
  captureOptions(); saveForm.hidden = false; fillForm.hidden = true; captureButton.hidden = true; document.body.classList.add('saving')
}) })
saveLogin.addEventListener('change', captureOptions); saveTarget.addEventListener('change', captureOptions)
saveForm.addEventListener('submit', event => {
  event.preventDefault()
  void action(async () => {
    if (!captureId) throw new Error('请重新读取当前网页。')
    if (websiteOrigin(saveUrl.value) !== origin) throw new Error('收藏网址必须属于当前网站。')
    if (saveLogin.checked && !saveUsername.value && !savePassword.value) throw new Error('请填写账号或密码，或取消保存账号密码。')
    const params = { captureId, targetId: saveTarget.value, name: saveName.value, url: saveUrl.value, ...(saveLogin.checked ? { login: { username: saveUsername.value, password: savePassword.value } } : {}) }
    try { await send('savePage', params) }
    finally { clearCapture(); captureButton.hidden = false }
    await load(); status.textContent = '已保存到 WebNav，首页收藏已更新'
  })
})
element('cancel-save').addEventListener('click', () => { clearCapture(); captureButton.hidden = false; fillForm.hidden = !choices.length; error.textContent = '' })
const captureTimer = setInterval(() => {
  if (!captureId || busy || checkingCapture) return
  const expected = captureId; checkingCapture = true
  void (async () => {
    try { if (Date.now() >= captureExpiry) throw new Error('保存预览已过期，请重新读取网页。'); await send('captureStatus', { captureId: expected }) }
    catch (cause) { if (alive && captureId === expected) { clearCapture(); captureButton.hidden = false; report(cause) } }
    finally { checkingCapture = false }
  })()
}, 1000)
window.addEventListener('pagehide', () => { alive = false; clearInterval(captureTimer); clearCapture() }, { once: true })
accounts.addEventListener('change', selected)
pairForm.addEventListener('submit', event => { event.preventDefault(); void action(async () => { const code = pairCode.value.trim(); pairCode.value = ''; await send('pair', { code }); await load() }) })
fillForm.addEventListener('submit', event => {
  event.preventDefault()
  // Host permissions must be requested directly from the user gesture, before any asynchronous work.
  const url = new URL(origin), permission = automatic.checked ? browser.permissions.request({ origins: [`http://${url.hostname}/*`, `https://${url.hostname}/*`] }) : Promise.resolve(true)
  void action(async () => {
    if (!await permission) throw new Error('未获得网站权限，可关闭自动填写后再试。')
    await send('manualFill', { tabId, origin, bookmarkId: accounts.value, automatic: automatic.checked })
    status.textContent = '已填写，登录由你确认'
  })
})
element('open-webnav').addEventListener('click', () => { void action(async () => { await send('openWebNav') }) })
element('forget').addEventListener('click', () => { void action(async () => { await send('forget'); await load(); status.textContent = '已断开。可在 WebNav 设置中撤销旧授权。' }) })
element('refresh').addEventListener('click', () => { void action(load) })
void action(load)
