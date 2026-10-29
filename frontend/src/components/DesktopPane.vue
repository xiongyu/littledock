<script setup lang="ts">
import { pluginI18n, currentLocale } from '../i18n.ts'
const { t: i18nT, ref: i18nRef, message: i18nMessage } = pluginI18n('builtin.desktops')

import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RFB from '@novnc/novnc'
import Guacamole from 'guacamole-common-js'
import { PhArrowsOut, PhArrowsIn, PhArrowSquareOut, PhClipboardText, PhKeyboard, PhCornersOut, PhX } from '@phosphor-icons/vue'
import type { RdpDisplay, RdpCertificateChallenge, MessageRef } from '@webnav/shared'
import { DesktopTunnel, type RdpFrameTiming } from '../desktop-tunnel'
import { connectionState, rpc, wsOrigin } from '../backend'
import { DEFAULT_PREVIEW_INTERVAL_MS } from '../session-preview'

const props = defineProps<{ sessionId: string; attachToken: string; protocol: 'rdp' | 'vnc'; display?: RdpDisplay; active: boolean; floating?: boolean }>()
const emit = defineEmits<{ status: [text: string]; running: [value: boolean]; frame: [blob: Blob]; float: [] }>()
const pane = ref<HTMLElement>(), viewport = ref<HTMLElement>(), screen = ref<HTMLElement>()
const notice = ref<string | MessageRef>(i18nRef('m8be0ea36a9bb')), connected = ref(false), fit = ref(true), fullscreen = ref(false)
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
  clearTimeout(connectTimer); connected.value = true; notice.value = i18nRef('m5be0323e8adc'); emit('status', i18nT('m5be0323e8adc')); emit('running', true)
  resize(); focus(); capture()
}
function ended(message?: string) {
  if (disposed) return
  clearInterval(performanceTimer); cancelAnimationFrame(browserFrame); browserFrames.length = 0; frameTimings.length = 0
  clearTimeout(connectTimer); connected.value = false; clipboard.value = ''; remoteClipboard = ''; clipboardOpen.value = false
  certificate.value = undefined; certificateDialog.value?.close()
  if (message) notice.value = message
  else if (typeof notice.value !== 'string' && ['m5be0323e8adc', 'm8be0ea36a9bb'].includes(notice.value.key)) notice.value = i18nRef('m25ac983d8c45')
  emit('status', i18nT('md79b1d0e5c61')); emit('running', false)
}
function fail(message: string) { ended(message); rfb?.disconnect(); client?.disconnect(); tunnel?.disconnect(); socket?.close() }
function answerCertificate(accept: boolean) {
  const pending = certificate.value
  if (!pending) return
  certificate.value = undefined; certificateDialog.value?.close()
  if (!tunnel?.answerCertificate(pending.requestId, accept)) { fail(i18nT('m838223816ff9')); return }
  if (!accept) { ended(i18nT('m87f25eb1c52f')); return }
  notice.value = i18nRef('m8be0ea36a9bb'); emit('status', i18nT('ma898478be181'))
  connectTimer = setTimeout(() => fail(i18nT('m9707829bc2de')), 40_000)
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
  catch { notice.value = i18nRef('m76d15df56a2f') }
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
function receivedClipboard(text: string) { remoteClipboard = text.slice(0, 64 * 1024); if (clipboardOpen.value) clipboardNotice.value = i18nT('m81132a28a19d') }
function sendClipboard() {
  if (!connected.value) return
  if (new TextEncoder().encode(clipboard.value).length > 64 * 1024) { clipboardNotice.value = i18nT('ma724de31ba85'); return }
  if (rfb) rfb.clipboardPasteFrom(clipboard.value)
  else if (client) { const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain')); writer.sendText(clipboard.value); writer.sendEnd() }
  clipboardNotice.value = i18nT('mdd8e0b7a1acd')
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
  ws.onerror = () => fail(i18nT('m607a445a589b'))
  ws.onclose = () => ended()
  ws.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.type !== 'desktop.bound') { fail(typeof message.message === 'string' ? message.message : i18nT('m510403e053ac')); return }
      rfb = new RFB(screen.value!, ws, { shared: true }); rfb.scaleViewport = fit.value; rfb.resizeSession = true
      rfb.addEventListener('connect', ready)
      rfb.addEventListener('disconnect', () => ended())
      rfb.addEventListener('securityfailure', () => fail(i18nT('mdbd6226c4c1f')))
      rfb.addEventListener('credentialsrequired', () => fail(i18nT('md34fc72dfe76')))
      rfb.addEventListener('clipboard', event => receivedClipboard(event.detail.text))
    } catch { fail(i18nT('m168c8bbd34f0')) }
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
    performanceTitle.value = i18nT('m8e3e641eee1c', { p0: (source.toFixed(1)), p1: (last?.sourceFrames ? 'FPS' : i18nT('mb55da4def78a')), p2: (fps), p3: (bridge.toFixed(1)), p4: (render.toFixed(1)), p5: (browserFrames.filter(time => time >= since).length) })
  }, 500)
  client = new Guacamole.Client(tunnel)
  // Client.onerror only handles Guacamole protocol errors, not tunnel/WS failures.
  tunnel.onerror = status => fail(status.message || i18nT('mce3746063d2d'))
  tunnel.oncertificate = challenge => {
    clearTimeout(connectTimer); certificate.value = challenge; notice.value = i18nRef('m665f87fd100e'); emit('status', i18nT('ma8b0bd9c65f7'))
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
  client.onerror = status => ended(status.message || i18nT('mce3746063d2d'))
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
watch(currentLocale, () => { if (connected.value) emit('status', i18nT('m5be0323e8adc')); else if (certificate.value) emit('status', i18nT('ma8b0bd9c65f7')) })
watch(connectionState, state => { if (state !== 'ready') { clipboard.value = ''; remoteClipboard = ''; clipboardOpen.value = false } })
function visible() { if (!document.hidden) capture() }
onMounted(async () => {
  try{if(!attachmentToken)attachmentToken=(await rpc<{attachToken:string}>('desktops.attachTicket',{sessionId:props.sessionId})).attachToken}catch(cause){ended(cause instanceof Error?cause.message:i18nT('mff06ac825586'));return}
  if(disposed)return
  connectTimer = setTimeout(() => fail(i18nT('m9707829bc2de')), 40_000)
  try { if (props.protocol === 'vnc') startVnc(); else startRdp() }
  catch { fail(i18nT('m8947525cad9a')); return }
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
    <div class="terminal-status desktop-toolbar"><span role="status">{{ i18nMessage(notice) }}</span><span v-if="connected && protocol === 'rdp'" class="desktop-performance" :title="performanceTitle">{{ performanceText }}</span><div class="terminal-actions">
      <button class="icon-button" :disabled="!connected" :title="i18nT('m6c13f204be14')" :aria-label="i18nT('m6c13f204be14')" @click="ctrlAltDel"><PhKeyboard :size="18" /></button>
      <button class="icon-button" :disabled="!connected" :title="i18nT('m8c10e2c1728d')" :aria-label="i18nT('m8c10e2c1728d')" :aria-pressed="clipboardOpen" @click="toggleClipboard"><PhClipboardText :size="18" /></button>
      <button class="icon-button" :title="fit ? i18nT('m301a69c74dfc') : i18nT('mf8d01c881e34')" :aria-label="fit ? i18nT('m301a69c74dfc') : i18nT('mf8d01c881e34')" :aria-pressed="fit" @click="fit = !fit"><PhCornersOut :size="18" /></button>
      <button class="icon-button" :title="fullscreen ? i18nT('m0f1505b6ad3f') : i18nT('mef24ffa0b5a1')" :aria-label="fullscreen ? i18nT('m0f1505b6ad3f') : i18nT('mef24ffa0b5a1')" @click="toggleFullscreen"><PhArrowsIn v-if="fullscreen" :size="18" /><PhArrowsOut v-else :size="18" /></button>
      <button v-if="!floating" class="icon-button" :title="i18nT('mc44cd4c11d51')" :aria-label="i18nT('mc44cd4c11d51')" @click="emit('float')"><PhArrowSquareOut :size="18" /></button>
    </div></div>
    <div v-if="clipboardOpen" class="desktop-clipboard"><div class="section-title"><strong>{{ i18nT('m8c10e2c1728d') }}</strong><button class="icon-button" :title="i18nT('m24cf7369c08a')" :aria-label="i18nT('m24cf7369c08a')" @click="toggleClipboard"><PhX :size="17" /></button></div><textarea v-model="clipboard" :aria-label="i18nT('mb2a4a88184c9')" rows="4" maxlength="65536" :placeholder="i18nT('m9b48bacc4f10')" /><div class="form-actions"><button class="button" @click="clipboard = remoteClipboard; clipboardNotice = ''">{{ i18nT('md76a7c925737') }}</button><button class="button primary" @click="sendClipboard">{{ i18nT('mf679d3b25ab3') }}</button></div><p v-if="clipboardNotice" class="field-hint">{{ clipboardNotice }}</p></div>
    <div ref="viewport" class="desktop-viewport"><div ref="screen" class="desktop-screen" :class="{ 'vnc-screen': protocol === 'vnc' }" tabindex="0" :aria-label="i18nT('mb92a7d914a5b')" @blur="releaseInput" @contextmenu.prevent></div></div>
    <Teleport to="body"><dialog ref="certificateDialog" class="management-dialog certificate-dialog" :aria-labelledby="`certificate-title-${sessionId}`" @cancel.prevent="answerCertificate(false)">
      <h2 :id="`certificate-title-${sessionId}`">{{ i18nT('m90cbc5dd7075') }}</h2>
      <p>{{ i18nT('mb35b410b3eea') }}</p>
      <p v-if="certificate" class="server-address">{{ certificate.host }}:{{ certificate.port }}</p>
      <details v-if="certificate" class="certificate-details"><summary>{{ i18nT('mddb1ef5d3fc9') }}</summary><span>{{ i18nT('m99e41b002e2c') }}</span><code>{{ certificate.previousFingerprint }}</code><span>{{ i18nT('m154d3c83e953') }}</span><code>{{ certificate.fingerprint }}</code></details>
      <div class="form-actions"><button type="button" class="button" autofocus @click="answerCertificate(false)">{{ i18nT('m2cd0f3be8738') }}</button><button type="button" class="button primary" @click="answerCertificate(true)">{{ i18nT('m37309fc49da4') }}</button></div>
    </dialog></Teleport>
  </div>
</template>
