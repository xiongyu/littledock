
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
export interface SessionPage { window: Window; mount: HTMLElement; dispose(): void }
/** Move the existing view into another same-origin document, without replacing its socket. */
export async function openSessionPage(name: string, onReturn: () => void): Promise<SessionPage | undefined> {
  const requestId = crypto.randomUUID()
  let child: Window | null = null
  let cancel = () => {}
  const loaded = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cancel(); reject(new Error(i18nT('mdf82b6697057'))) }, 10000)
    const listener = (event: MessageEvent) => {
      if (event.source === child && event.origin === location.origin && event.data?.type === 'webnav-session-page-ready' && event.data.requestId === requestId) { cancel(); resolve() }
    }
    cancel = () => { clearTimeout(timeout); window.removeEventListener('message', listener) }
    window.addEventListener('message', listener)
  })
  child = window.open(`${location.pathname}?session-window=${requestId}`, '_blank')
  if (!child) { cancel(); return }
  try { await loaded } catch (cause) { child.close(); throw cause }
  const doc = child.document
  doc.title = `${name} · LittleDock`
  doc.documentElement.lang = 'zh-CN'
  doc.documentElement.style.cssText = document.documentElement.style.cssText
  doc.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'light'
  doc.body.className = 'session-page'
  const mount = doc.createElement('main')
  mount.className = 'session-page-root'
  doc.body.replaceChildren(mount)
  function styles() {
    doc.head.querySelectorAll('[data-webnav-style]').forEach(node => node.remove())
    document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
      const copy = node.cloneNode(true) as HTMLElement
      copy.dataset.webnavStyle = 'true'; doc.head.append(copy)
    })
  }
  styles()
  const observer = new MutationObserver(styles)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  let disposed = false
  const returnView = () => { if (!disposed) onReturn() }
  child.addEventListener('pagehide', returnView)
  // Closing the child returns the same view to its owner, including bounded scrollback.
  const timer = window.setInterval(() => { if (child.closed) returnView() }, 500)
  return { window: child, mount, dispose() { disposed = true; observer.disconnect(); clearInterval(timer); child.removeEventListener('pagehide', returnView); if (!child.closed) child.close() } }
}
