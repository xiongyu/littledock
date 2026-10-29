// Bundled independently into an isolated-world script. It never receives the pairing key.
(() => {
  const root = globalThis as typeof globalThis & { __webnavAutofill?: boolean; browser?: import('./browser').BrowserApi; chrome?: import('./browser').BrowserApi }
  if (root.__webnavAutofill || window !== window.top || !['http:', 'https:'].includes(location.protocol)) return
  root.__webnavAutofill = true
  // randomUUID requires a secure context; getRandomValues also works on ordinary HTTP pages.
  const api = (root.browser ?? root.chrome)!, documentToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  let automaticAttempted = false, closed = false
  function sameSite(value: string) {
    const target = new URL(value, location.href), current = new URL(location.href)
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && target.hostname === current.hostname && target.port === current.port
  }
  function visible(input: HTMLInputElement) {
    const rect = input.getBoundingClientRect(), style = getComputedStyle(input)
    return !input.disabled && !input.readOnly && !input.closest('[hidden], [inert]') && rect.width >= 20 && rect.height >= 10 && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) !== 0
  }
  function target(capture = false) {
    const passwords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(visible)
    if (passwords.length !== 1) return undefined
    const password = passwords[0]!
    if ((!capture && password.value) || password.autocomplete === 'new-password') return undefined
    const form = password.form
    if (form) {
      if (!sameSite(form.action || location.href)) return undefined
      // A submit button can override a form's action.
      for (const button of form.querySelectorAll('[formaction]')) if (!sameSite(button.getAttribute('formaction')!)) return undefined
    }
    const inputs = [...(form ?? document).querySelectorAll<HTMLInputElement>('input')].filter(input => visible(input) && ['text', 'email', 'tel'].includes(input.type))
    const named = inputs.filter(input => input.autocomplete === 'username' || input.autocomplete === 'email' || /user|login|email|account/i.test(input.name + ' ' + input.id))
    const username = named.length === 1 ? named[0] : inputs.length === 1 ? inputs[0] : undefined
    if ((!capture && username?.value) || (!username && inputs.length)) return undefined
    return { username, password }
  }
  function setValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  api.runtime.onMessage.addListener((input, sender, respond) => {
    if (sender.id !== api.runtime.id || !input || typeof input !== 'object') return
    const message = input as Record<string, unknown>
    if (message.type === 'webnav.probe') { respond({ documentToken, origin: location.origin, fillable: !closed && !!target() }); return }
    if (message.type === 'webnav.capture') {
      if (closed || message.documentToken !== documentToken) { respond({ captured: false }); return }
      const found = target(true), username = found?.username?.value ?? '', password = found?.password.value ?? ''
      // Read only on the extension's explicit request. Never listen to typing or submit events.
      const captured = !!found && !!(username || password) && username.length <= 256 && password.length <= 4096
      respond({ captured, documentToken, origin: location.origin, url: location.href, ...(captured ? { username, password } : {}) }); return
    }
    if (message.type !== 'webnav.fill') return
    const found = target()
    if (closed || !found || message.documentToken !== documentToken || message.origin !== location.origin || typeof message.expiresAt !== 'number' || message.expiresAt < Date.now() || message.expiresAt > Date.now() + 6000 || typeof message.username !== 'string' || message.username.length > 256 || typeof message.password !== 'string' || message.password.length > 4096) { respond({ filled: false }); return }
    if (found.username) setValue(found.username, message.username)
    // Recheck after website input handlers, which can replace fields or change a form's action.
    const form = found.password.form
    if (!found.password.isConnected || !visible(found.password) || found.password.value || (form && (!sameSite(form.action || location.href) || [...form.querySelectorAll('[formaction]')].some(button => !sameSite(button.getAttribute('formaction')!))))) { respond({ filled: false }); return }
    setValue(found.password, message.password)
    automaticAttempted = true; observer.disconnect(); respond({ filled: true })
  })
  function attempt() {
    if (closed || automaticAttempted || document.visibilityState !== 'visible' || !target()) return
    automaticAttempted = true
    // Never return or retain credentials through this request. Only the background can send a bound fill message.
    void api.runtime.sendMessage({ type: 'webnav.autoFill', documentToken }).catch(() => {})
  }
  let scheduled: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => { clearTimeout(scheduled); scheduled = setTimeout(attempt, 200) })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  const stop = setTimeout(() => observer.disconnect(), 30_000)
  document.addEventListener('visibilitychange', attempt)
  window.addEventListener('pagehide', () => { closed = true; observer.disconnect(); clearTimeout(scheduled); clearTimeout(stop) }, { once: true })
  window.addEventListener('pageshow', event => { if (event.persisted) { closed = false; automaticAttempted = true } })
  attempt()
})()
