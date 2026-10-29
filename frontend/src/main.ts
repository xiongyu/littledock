
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './builtin-plugins'

if (new URLSearchParams(location.search).has('session-window')) {
  const root = document.getElementById('app')!
  const message = document.createElement('p')
  message.textContent = i18nT('m907729d3a7db')
  const link = document.createElement('a')
  link.href = '/'; link.textContent = i18nT('mfa3d1a1ae1e8')
  root.append(message, link)
  window.opener?.postMessage({type:'webnav-session-page-ready',requestId:new URLSearchParams(location.search).get('session-window')},location.origin)
} else createApp(App).mount('#app')
