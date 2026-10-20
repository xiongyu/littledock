import type { Plugin } from 'vite'

/** The Vite HTML response establishes the same HttpOnly session as the backend page. */
export function devSession(backendOrigin: string, uiOrigin: string): Plugin {
  return {
    name: 'webnav-dev-session',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.headers.host !== new URL(uiOrigin).host) {
          response.statusCode = 403; response.end('Forbidden host'); return
        }
        const path = request.url?.split('?')[0]
        if (request.method !== 'GET' || (path !== '/' && path !== '/index.html')) { next(); return }
        response.setHeader('Cache-Control', 'no-store')
        try {
          const page = await fetch(backendOrigin + '/', {
            redirect: 'manual', signal: AbortSignal.timeout(2000),
            headers: request.headers.cookie ? { cookie: request.headers.cookie } : {},
          })
          const cookie = page.headers.get('set-cookie')
          if (page.headers.get('X-WebNav-Service') === '1' && cookie) response.setHeader('Set-Cookie', cookie)
          await page.body?.cancel()
        } catch { /* Render the UI so it can explain an unavailable backend. */ }
        next()
      })
    },
  }
}
