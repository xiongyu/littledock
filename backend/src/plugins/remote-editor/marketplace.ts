import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

export const marketplacePath = '/_webnav/marketplace'
const queryUrl = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
const requestLimit = 256 * 1024
const responseLimit = 64 * 1024 * 1024
const compress = promisify(gzip)

// This is the official editor's public gallery query, not an arbitrary URL proxy.
// The gateway authenticates the owner and exact Origin before dispatching here.
export function marketplaceProxy(fetcher: typeof fetch = fetch, timeoutMs = 20_000) {
  const active = new Set<AbortController>()
  let closed = false
  function reply(res: ServerResponse, status: number, message: string) {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(message)
  }
  async function query(req: IncomingMessage, res: ServerResponse) {
    if (closed || active.size >= 2) { reply(res, 503, '扩展市场繁忙，请稍后重试。'); return }
    if (req.method !== 'POST') { reply(res, 405, '扩展市场只接受搜索请求。'); return }
    if (Number(req.headers['content-length']) > requestLimit) { reply(res, 413, '扩展市场查询过大。'); req.resume(); return }
    const controller = new AbortController()
    active.add(controller)
    const timer = setTimeout(() => { controller.abort(); if (!req.complete) req.destroy() }, timeoutMs)
    const abort = () => controller.abort()
    res.once('close', abort)
    try {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > requestLimit) { reply(res, 413, '扩展市场查询过大。'); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks).toString('utf8')
      let input: unknown
      try { input = JSON.parse(body) } catch { reply(res, 400, '扩展市场查询格式无效。'); return }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { reply(res, 400, '扩展市场查询格式无效。'); return }
      // No 小站 cookie, editor token, client Authorization or remote address
      // leaves the local gateway. Keep Microsoft as the configured gallery.
      const response = await fetcher(queryUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json;api-version=3.0-preview.1' },
        body,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        reply(res, 502, `扩展市场暂时不可用（HTTP ${response.status}）。`)
        return
      }
      const reader = response.body.getReader(), result: Buffer[] = []
      let bytes = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > responseLimit) throw new Error('Response limit')
          result.push(Buffer.from(part.value))
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const data = Buffer.concat(result)
      const parsed: unknown = JSON.parse(data.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || !('results' in parsed) || !Array.isArray(parsed.results)) throw new Error('Invalid gallery response')
      // Compatibility checks request the complete version history of some
      // extensions (Python can exceed 28 MiB). Compress the unchanged public
      // response for the browser instead of truncating versions or assets.
      const compressed = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
      const output = compressed ? await compress(data) : data
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding', ...(compressed ? { 'content-encoding': 'gzip' } : {}) })
        res.end(output)
      }
    } catch {
      reply(res, 502, controller.signal.aborted ? '扩展市场请求超时或已取消，请重试。' : '无法读取扩展市场，请检查本机网络后重试。')
    } finally { clearTimeout(timer); res.off('close', abort); active.delete(controller) }
  }
  return {
    handle(req: IncomingMessage, res: ServerResponse, pathname: string) {
      if (pathname !== marketplacePath && !pathname.startsWith(marketplacePath + '/')) return false
      if (pathname !== marketplacePath + '/extensionquery') reply(res, 404, '扩展市场请求不存在。')
      else void query(req, res)
      return true
    },
    close() { closed = true; for (const controller of active) controller.abort(); active.clear() },
  }
}
