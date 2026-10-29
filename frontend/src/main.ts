import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './builtin-plugins'

if (new URLSearchParams(location.search).has('session-window')) {
  const root = document.getElementById('app')!
  const message = document.createElement('p')
  message.textContent = '会话已收回主页，请从主页重新打开独立页面。'
  const link = document.createElement('a')
  link.href = '/'; link.textContent = '打开主页'
  root.append(message, link)
  window.opener?.postMessage({type:'webnav-session-page-ready',requestId:new URLSearchParams(location.search).get('session-window')},location.origin)
} else createApp(App).mount('#app')
