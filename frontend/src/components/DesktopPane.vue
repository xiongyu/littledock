<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RFB from '@novnc/novnc'
import Guacamole from 'guacamole-common-js'
import { PhArrowsOut, PhArrowsIn, PhArrowSquareOut, PhClipboardText, PhKeyboard, PhCornersOut, PhX } from '@phosphor-icons/vue'
import type { RdpDisplay, RdpCertificateChallenge } from '@webnav/shared'
import { DesktopTunnel, type RdpFrameTiming } from '../desktop-tunnel'
import { connectionState, rpc, wsOrigin } from '../backend'
import { DEFAULT_PREVIEW_INTERVAL_MS } from '../session-preview'

const props = defineProps<{ sessionId: string; attachToken: string; protocol: 'rdp' | 'vnc'; display?: RdpDisplay; active: boolean; floating?: boolean }>()
const emit = defineEmits<{ status: [text: string]; running: [value: boolean]; frame: [blob: Blob]; float: [] }>()
const pane = ref<HTMLElement>(), viewport = ref<HTMLElement>(), screen = ref<HTMLElement>()
const notice = ref('正在连接…'), connected = ref(false), fit = ref(true), fullscreen = ref(false)
const clipboardOpen = ref(false), clipboard = ref(''), clipboardNotice = ref('')
const certificateDialog = ref<HTMLDialogElement>(), certificate = ref<RdpCertificateChallenge>()
const performanceText = ref(''), performanceTitle = ref('')
const frameTimings: RdpFrameTiming[] = []
const browserFrames: number[] = []
let browserFrame = 0
let performanceTimer: ReturnType<typeof setInterval> | undefined
let rfb: RFB | undefined, client: Guacamole.Client | undefined, tunnel: DesktopTunnel | undefined, socket: WebSocket | undefined
let keyboard: Guacamole.Keyboard | undefined, mouse: Guacamole.Mouse | undefined, observer: ResizeObserver | undefined
let disposed = false, captureBusy = false, resizeTimer: ReturnType<typeof setTimeout> | undefined
let previewTimer: ReturnType<typeof setInterval> | undefined, connectTimer: ReturnType<typeof setTimeout> | undefined
let lastSize = '', remoteClipboard = ''
let attachmentToken=props.attachToken
function dimensions() { return { width: Math.max(200, Math.min(4096, viewport.value?.clientWidth || 1280)), height: Math.max(200, Math.min(2160, viewport.value?.clientHeight || 720)) } }
function ready() {
  if (disposed) return
  clearTimeout(connectTimer); connected.value = true; notice.value = '已连接'; emit('status', '已连接'); emit('running', true)
  resize(); focus(); capture()
}
function ended(message?: string) {
  if (disposed) return
  clearInterval(performanceTimer); cancelAnimationFrame(browserFrame); browserFrames.length = 0; frameTimings.length = 0
  clearTimeout(connectTimer); connected.value = false; clipboard.value = ''; remoteClipboard = ''; clipboardOpen.value = false
  certificate.value = undefined; certificateDialog.value?.close()
  if (message) notice.value = message
  else if (notice.value === '已连接' || notice.value === '正在连接…') notice.value = '连接已结束。'
  emit('status', '已结束'); emit('running', false)
}
function fail(message: string) { ended(message); rfb?.disconnect(); client?.disconnect(); tunnel?.disconnect(); socket?.close() }
function answerCertificate(accept: boolean) {
  const pending = certificate.value
  if (!pending) return
  certificate.value = undefined; certificateDialog.value?.close()
  if (!tunnel?.answerCertificate(pending.requestId, accept)) { fail('连接已结束，请重新打开桌面。'); return }
  if (!accept) { ended('已取消更新证书，RDP 连接已停止。'); return }
  notice.value = '正在连接…'; emit('status', '连接中')
  connectTimer = setTimeout(() => fail('网页桌面连接超时，请检查服务和认证设置。'), 40_000)
}
function focus() { if (!props.active || !connected.value) return; if (rfb) rfb.focus(); else screen.value?.focus({ preventScroll: true }) }
defineExpose({ focus })
function releaseInput() { keyboard?.reset(); mouse?.reset(); rfb?.blur() }
function resize() {
  if (disposed || !props.active || !viewport.value?.clientWidth) return
  if (rfb) { rfb.scaleViewport = fit.value; return }
  if (!client) return
  const display = client.getDisplay(), size = dimensions()
  if (display.getWidth() && display.getHeight()) display.scale(fit.value ? Math.min(size.width / display.getWidth(), size.height / display.getHeight()) : 1)
  if (connected.value && props.display?.mode === 'fullscreen' && lastSize !== `${size.width}:${size.height}`) {
    lastSize = `${size.width}:${size.height}`; client.sendSize(size.width, size.height)
  }
}
function scheduleResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150) }
async function toggleFullscreen() {
  try { if (document.fullscreenElement === pane.value) await document.exitFullscreen(); else await pane.value?.requestFullscreen(); focus() }
  catch { notice.value = '浏览器未允许全屏，可以再次点击全屏按钮。' }
}
function fullscreenChanged() { fullscreen.value = document.fullscreenElement === pane.value; scheduleResize() }
function ctrlAltDel() {
  if (rfb) rfb.sendCtrlAltDel()
  else if (client) { for (const key of [0xffe3, 0xffe9, 0xffff]) client.sendKeyEvent(1, key); for (const key of [0xffff, 0xffe9, 0xffe3]) client.sendKeyEvent(0, key) }
  focus()
}
function toggleClipboard() {
  releaseInput(); clipboardOpen.value = !clipboardOpen.value
  if (clipboardOpen.value) { clipboard.value = remoteClipboard; clipboardNotice.value = '' }
  else clipboard.value = ''
}
function receivedClipboard(text: string) { remoteClipboard = text.slice(0, 64 * 1024); if (clipboardOpen.value) clipboardNotice.value = '远端剪贴板已更新，点击“读取远端”查看。' }
function sendClipboard() {
  if (!connected.value) return
  if (new TextEncoder().encode(clipboard.value).length > 64 * 1024) { clipboardNotice.value = '剪贴板最多 64 KiB，请分段发送。'; return }
  if (rfb) rfb.clipboardPasteFrom(clipboard.value)
  else if (client) { const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain')); writer.sendText(clipboard.value); writer.sendEnd() }
  clipboardNotice.value = '已发送到远端剪贴板。'
}
function capture() {
  if (disposed || document.hidden || !connected.value || captureBusy) return
  const source = client?.getDisplay().flatten() ?? screen.value?.querySelector('canvas')
  if (!source?.width || !source.height) return
  captureBusy = true
  const thumb = document.createElement('canvas'); thumb.width = 240; thumb.height = Math.max(1, Math.round(240 * source.height / source.width))
  // Bound portrait previews too, and never retain full desktop frame buffers.
  if (thumb.height > 240) { thumb.width = Math.max(1, Math.round(240 * source.width / source.height)); thumb.height = 240 }
  try { thumb.getContext('2d')?.drawImage(source, 0, 0, thumb.width, thumb.height); thumb.toBlob(blob => { captureBusy = false; if (blob && !disposed && connected.value) emit('frame', blob); thumb.width = thumb.height = 0 }, 'image/jpeg', 0.72) }
  catch { captureBusy = false }
  finally { if (client) source.width = source.height = 0 }
}
function startVnc() {
  const ws = socket = new WebSocket(wsOrigin + '/ws/desktop'); ws.binaryType = 'arraybuffer'
  ws.onopen = () => ws.send(JSON.stringify({ type: 'desktop.attach', sessionId: props.sessionId, attachToken: attachmentToken, ...dimensions() }))
  ws.onerror = () => fail('网页 VNC 网络连接失败。')
  ws.onclose = () => ended()
  ws.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type !== 'desktop.bound') { fail(typeof message.message === 'string' ? message.message : '网页 VNC 连接失败。'); return }
      rfb = new RFB(screen.value!, ws, { shared: true }); rfb.scaleViewport = fit.value; rfb.resizeSession = true
      rfb.addEventListener('connect', ready)
      rfb.addEventListener('disconnect', () => ended())
      rfb.addEventListener('securityfailure', () => fail('VNC 认证失败，请检查入口密码。'))
      rfb.addEventListener('credentialsrequired', () => fail('此 VNC 认证方式暂不支持，请使用标准 VNC 密码认证。'))
      rfb.addEventListener('clipboard', event => receivedClipboard(event.detail.text))
    } catch { fail('无法初始化网页 VNC。') }
  }
}
function startRdp() {
  const pulse = (now: number) => {
    browserFrames.push(now)
    while (browserFrames.length && browserFrames[0]! < now - 1000) browserFrames.shift()
    browserFrame = requestAnimationFrame(pulse)
  }
  browserFrame = requestAnimationFrame(pulse)
  tunnel = new DesktopTunnel(wsOrigin + '/ws/desktop', { sessionId: props.sessionId, attachToken: attachmentToken, ...dimensions() })
  tunnel.onframe = timing => { frameTimings.push(timing); if (frameTimings.length > 1024) frameTimings.shift() }
  performanceTimer = setInterval(() => {
    const since = performance.now() - 1000
    while (frameTimings.length && frameTimings[0]!.renderedAt < since) frameTimings.shift()
    const fps = frameTimings.length, render = fps ? frameTimings.reduce((sum, frame) => sum + frame.renderMs, 0) / fps : 0
    const bridge = fps ? frameTimings.reduce((sum, frame) => sum + frame.bridgeMs, 0) / fps : 0
    const first = frameTimings[0], last = frameTimings.at(-1), elapsed = first && last ? last.renderedAt - first.renderedAt : 0
    const source = first && last && elapsed > 0 ? Math.max(0, (last.sourceFrames ? last.sourceFrames - first.sourceFrames : last.sourceUpdates - first.sourceUpdates) * 1000 / elapsed) : 0
    const display = client?.getDisplay()
    performanceText.value = `${display?.getWidth() ?? 0} × ${display?.getHeight() ?? 0} · ${fps} FPS`
    performanceTitle.value = `RDP ${source.toFixed(1)} ${last?.sourceFrames ? 'FPS' : '次更新/秒'}；网页最近一秒实际绘制 ${fps} 帧，静止时为 0。桥接处理 ${bridge.toFixed(1)} ms；网页呈现 ${render.toFixed(1)} ms。浏览器调度 ${browserFrames.filter(time => time >= since).length} 次/秒。耗时不含远端与网络。`
  }, 500)
  client = new Guacamole.Client(tunnel)
  // Client.onerror only handles Guacamole protocol errors, not tunnel/WS failures.
  tunnel.onerror = status => fail(status.message || '网页 RDP 连接失败。')
  tunnel.oncertificate = challenge => {
    clearTimeout(connectTimer); certificate.value = challenge; notice.value = '等待确认更新证书…'; emit('status', '待确认')
    void nextTick(() => { if (!disposed && certificate.value?.requestId === challenge.requestId) certificateDialog.value?.showModal() })
  }
  tunnel.onstatechange = state => { if (state === Guacamole.Tunnel.State.CLOSED) { ended(); client?.disconnect() } }
  const display = client.getDisplay(), element = display.getElement()
  screen.value!.appendChild(element); display.onresize = scheduleResize
  keyboard = new Guacamole.Keyboard(screen.value!)
  keyboard.onkeydown = key => { if (connected.value) client?.sendKeyEvent(1, key); return false }
  keyboard.onkeyup = key => client?.sendKeyEvent(0, key)
  mouse = new Guacamole.Mouse(element)
  mouse.onEach(['mousedown', 'mouseup', 'mousemove'], event => { if (connected.value) { focus(); client?.sendMouseState((event as Guacamole.Mouse.Event).state, true) } })
  client.onstatechange = state => { if (state === Guacamole.Client.State.CONNECTED) ready(); else if (state === Guacamole.Client.State.DISCONNECTED) ended() }
  client.onerror = status => ended(status.message || '网页 RDP 连接失败。')
  client.onclipboard = (stream, mimetype) => {
    if (mimetype !== 'text/plain') { stream.sendAck('Only text clipboard is supported', 0x0100); return }
    let text = '', bytes = 0, rejected = false
    const reader = new Guacamole.StringReader(stream)
    reader.ontext = chunk => { bytes += new TextEncoder().encode(chunk).length; if (bytes <= 64 * 1024) { text += chunk; stream.sendAck('OK', 0) } else { rejected = true; text = ''; stream.sendAck('Clipboard too large', 0x0100) } }
    reader.onend = () => { if (!disposed && !rejected) receivedClipboard(text); text = '' }
    stream.sendAck('OK', 0)
  }
  client.connect()
}
watch(() => props.active, active => { if (!active) releaseInput(); else void nextTick(() => { resize(); focus() }) })
watch(fit, resize)
watch(connectionState, state => { if (state !== 'ready') { clipboard.value = ''; remoteClipboard = ''; clipboardOpen.value = false } })
function visible() { if (!document.hidden) capture() }
onMounted(async () => {
  try{if(!attachmentToken)attachmentToken=(await rpc<{attachToken:string}>('desktops.attachTicket',{sessionId:props.sessionId})).attachToken}catch(cause){ended(cause instanceof Error?cause.message:'无法恢复桌面。');return}
  if(disposed)return
  connectTimer = setTimeout(() => fail('网页桌面连接超时，请检查服务和认证设置。'), 40_000)
  try { if (props.protocol === 'vnc') startVnc(); else startRdp() }
  catch { fail('无法初始化网页桌面，请关闭此标签后重试。'); return }
  observer = new ResizeObserver(scheduleResize); observer.observe(viewport.value!)
  previewTimer = setInterval(capture, DEFAULT_PREVIEW_INTERVAL_MS)
  document.addEventListener('fullscreenchange', fullscreenChanged); window.addEventListener('blur', releaseInput)
  document.addEventListener('visibilitychange', visible)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(browserFrame); browserFrames.length = 0
  clearInterval(performanceTimer); frameTimings.length = 0
  certificate.value = undefined; certificateDialog.value?.close()
  disposed = true; releaseInput(); clearTimeout(connectTimer); clearTimeout(resizeTimer); clearInterval(previewTimer); observer?.disconnect()
  if (keyboard) keyboard.onkeydown = keyboard.onkeyup = null
  if (client) client.onstatechange = client.onerror = client.onclipboard = null
  rfb?.disconnect(); client?.disconnect(); tunnel?.disconnect(); socket?.close(); clipboard.value = ''; remoteClipboard = ''
  document.removeEventListener('fullscreenchange', fullscreenChanged); window.removeEventListener('blur', releaseInput)
  document.removeEventListener('visibilitychange', visible)
})
</script>

<template>
  <div ref="pane" class="desktop-pane">
    <div class="terminal-status desktop-toolbar"><span role="status">{{ notice }}</span><span v-if="connected && protocol === 'rdp'" class="desktop-performance" :title="performanceTitle">{{ performanceText }}</span><div class="terminal-actions">
      <button class="icon-button" :disabled="!connected" title="发送 Ctrl+Alt+Delete" aria-label="发送 Ctrl+Alt+Delete" @click="ctrlAltDel"><PhKeyboard :size="18" /></button>
      <button class="icon-button" :disabled="!connected" title="剪贴板" aria-label="剪贴板" :aria-pressed="clipboardOpen" @click="toggleClipboard"><PhClipboardText :size="18" /></button>
      <button class="icon-button" :title="fit ? '原始大小' : '适应窗口'" :aria-label="fit ? '原始大小' : '适应窗口'" :aria-pressed="fit" @click="fit = !fit"><PhCornersOut :size="18" /></button>
      <button class="icon-button" :title="fullscreen ? '退出全屏' : '全屏桌面'" :aria-label="fullscreen ? '退出全屏' : '全屏桌面'" @click="toggleFullscreen"><PhArrowsIn v-if="fullscreen" :size="18" /><PhArrowsOut v-else :size="18" /></button>
      <button v-if="!floating" class="icon-button" title="悬浮桌面" aria-label="悬浮桌面" @click="emit('float')"><PhArrowSquareOut :size="18" /></button>
    </div></div>
    <div v-if="clipboardOpen" class="desktop-clipboard"><div class="section-title"><strong>剪贴板</strong><button class="icon-button" title="关闭剪贴板" aria-label="关闭剪贴板" @click="toggleClipboard"><PhX :size="17" /></button></div><textarea v-model="clipboard" aria-label="桌面剪贴板内容" rows="4" maxlength="65536" placeholder="粘贴文本，发送后在远端按 Ctrl+V" /><div class="form-actions"><button class="button" @click="clipboard = remoteClipboard; clipboardNotice = ''">读取远端</button><button class="button primary" @click="sendClipboard">发送到远端</button></div><p v-if="clipboardNotice" class="field-hint">{{ clipboardNotice }}</p></div>
    <div ref="viewport" class="desktop-viewport"><div ref="screen" class="desktop-screen" :class="{ 'vnc-screen': protocol === 'vnc' }" tabindex="0" aria-label="远程桌面画面" @blur="releaseInput" @contextmenu.prevent></div></div>
    <Teleport to="body"><dialog ref="certificateDialog" class="management-dialog certificate-dialog" :aria-labelledby="`certificate-title-${sessionId}`" @cancel.prevent="answerCertificate(false)">
      <h2 :id="`certificate-title-${sessionId}`">更新服务器证书？</h2>
      <p>此服务器的证书已变化，是否更新并继续连接？</p>
      <p v-if="certificate" class="server-address">{{ certificate.host }}:{{ certificate.port }}</p>
      <details v-if="certificate" class="certificate-details"><summary>查看证书指纹</summary><span>原证书</span><code>{{ certificate.previousFingerprint }}</code><span>新证书</span><code>{{ certificate.fingerprint }}</code></details>
      <div class="form-actions"><button type="button" class="button" autofocus @click="answerCertificate(false)">取消</button><button type="button" class="button primary" @click="answerCertificate(true)">更新并连接</button></div>
    </dialog></Teleport>
  </div>
</template>
