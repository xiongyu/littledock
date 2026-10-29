import { chromium, type Browser } from 'playwright-core'

export type WebCapture = (url: string, signal: AbortSignal) => Promise<Buffer>

/** Fresh, non-persistent context: no saved website credentials, profile or login cookies. */
export const captureWebsite: WebCapture = async (url, signal) => {
  let browser: Browser | undefined
  const close = () => { void browser?.close().catch(() => {}) }
  signal.addEventListener('abort', close, { once: true })
  const deadline = setTimeout(close, 20_000)
  try {
    for (const channel of ['msedge', 'chrome']) {
      signal.throwIfAborted()
      try { browser = await chromium.launch({ channel, headless: true, chromiumSandbox: true, timeout: 5000 }); break }
      catch { /* Try the other installed browser; never install a browser automatically. */ }
    }
    if (!browser) throw new Error('No installed screenshot browser')
    signal.throwIfAborted()
    const context = await browser.newContext({
      viewport: { width: 960, height: 600 }, deviceScaleFactor: 1, colorScheme: 'light',
      acceptDownloads: false, serviceWorkers: 'block',
    })
    const page = await context.newPage()
    // Capture only the requested page; close popups and never approve browser dialogs.
    context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}) })
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
    await context.route('**/*', route => {
      const protocol = new URL(route.request().url()).protocol
      return ['http:', 'https:'].includes(protocol) ? route.continue() : route.abort()
    })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    await page.waitForLoadState('load', { timeout: 2000 }).catch(() => {})
    // A bounded settling period lets client-rendered pages paint without waiting for endless polling.
    await page.waitForTimeout(700)
    signal.throwIfAborted()
    const image = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false, animations: 'disabled', timeout: 3000 })
    if (image.length > 256 * 1024) throw new Error('Screenshot exceeds limit')
    return image
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', close)
    await browser?.close().catch(() => {})
  }
}
