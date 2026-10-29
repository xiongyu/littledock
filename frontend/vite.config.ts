import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { devSession } from './dev-session.ts'

export default defineConfig(({ command }) => {
  const port = Number(process.env.WEBNAV_UI_PORT ?? 5173)
  const backendOrigin = `http://127.0.0.1:${Number(process.env.WEBNAV_PORT ?? 3030)}`
  return {
    plugins: [vue(), devSession(backendOrigin, `http://127.0.0.1:${port}`)],
    base: './',
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/plugins/': { target: backendOrigin, changeOrigin: true } } },
    define: command === 'serve' ? { 'import.meta.env.VITE_WEBNAV_BACKEND_ORIGIN': JSON.stringify(backendOrigin) } : {},
  }
})
