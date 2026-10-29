<script setup lang="ts">
import { pluginI18n, currentLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.sessions')

import { computed, onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { PhClock, PhArrowSquareOut } from '@phosphor-icons/vue'
import '@xterm/xterm/css/xterm.css'
import { connectionState, rpc, wsOrigin, terminalThemes } from '../backend'
import { resolveTerminalTheme } from '@webnav/shared'
import ContextMenu from './ContextMenu.vue'
import { menuBinding } from '../plugin-menus'
const props = defineProps<{ sessionId: string; attachToken: string; active: boolean; floating?: boolean; themeId?: string; ownerDocument?: Document }>()
const emit = defineEmits<{ status: [text: string]; running: [value: boolean]; history: []; float: []; reconnect: []; configure: []; colors: []; close: [] }>()
const container = ref<HTMLElement>(), notice = ref(i18nT('m8be0ea36a9bb')), ready = ref(false), ended = ref(false), newOutput = ref(false), verified = ref(false), error = ref('')
const hostKey = ref<{fingerprint:string;previous:string;changed:boolean;host:string;port:number}>()
const detached=ref(false)
let terminal: Terminal | undefined, socket: WebSocket | undefined, fit: FitAddon | undefined, resize: ResizeObserver | undefined, parsed = 0, queued = 0, disposed = false
const menu = ref<{x:number;y:number}>()
const selectedText = ref('')
const menuExtension = menuBinding('builtin.sessions', 'terminal', () => ({ sessionId: props.sessionId, ready: ready.value, hasSelection: !!selectedText.value }), () => !disposed && props.active && !!menu.value)
const palette = computed(() => resolveTerminalTheme(terminalThemes.value, props.themeId).colors)
const reconnectHint = computed(() => connectionState.value === 'ready' ? detached.value?i18nT('m0be2a5942630'):i18nT('m676aa750106f') : connectionState.value === 'locked' ? i18nT('m041e4c7634c6') : i18nT('mc9e6fdff9041'))
const menuItems = computed(() => [
  { id:'copy', label:i18nT('m63d90d977348'), shortcut:'Ctrl Shift C', disabled:!selectedText.value },
  { id:'paste', label:i18nT('m335179267471'), shortcut:'Ctrl Shift V', disabled:!ready.value },
  { id:'select', label:i18nT('m3a5040b68abf') },
  { id:'interrupt', label:i18nT('mb44d0a6ed86f'), shortcut:'Ctrl C', disabled:!ready.value },
  { id:'bottom', label:i18nT('m2fdb6c468166'), separator:true },
  { id:'history', label:i18nT('mb5e78362adb6') },
  { id:'larger', label:i18nT('mae67a3d9c27e'), separator:true },
  { id:'smaller', label:i18nT('m878069501f1e') },
  { id:'font-reset', label:i18nT('mb5ad388fee13') },
  { id:'colors', label:i18nT('m22a72a8fc163'), separator:true },
  { id:'configure', label:i18nT('m398ddac33fc3') },
  { id:'reconnect', label:i18nT('m68891ab35cab'), separator:true },
  { id:'close', label:i18nT('m16707b59cf5e'), danger:true },
])
function openMenu(event: MouseEvent) {
  event.preventDefault(); event.stopPropagation()
  selectedText.value = terminal?.getSelection() ?? ''
  menu.value = {x:event.clientX,y:event.clientY}
}
async function copySelection() {
  const text = selectedText.value || terminal?.getSelection()
  if (!text) return
  try { await (props.ownerDocument ?? document).defaultView!.navigator.clipboard.writeText(text) }
  catch { notice.value=i18nT('mf2648ddf285d') }
}
async function pasteClipboard() {
  if (!ready.value) return
  try {
    const text = await (props.ownerDocument ?? document).defaultView!.navigator.clipboard.readText()
    if (ready.value && !disposed) { terminal?.paste(text); focus() }
  } catch { notice.value=i18nT('m777f8a0a8e94'); focus() }
}
function action(id: string) {
  if (id==='copy') void copySelection()
  else if (id==='paste') void pasteClipboard()
  else if (id==='select') terminal?.selectAll()
  else if (id==='interrupt' && ready.value) { terminal?.input('\x03',true); focus() }
  else if (id==='bottom') bottom()
  else if (id==='history') emit('history')
  else if (id==='configure') emit('configure')
  else if (id==='colors') emit('colors')
  else if (id==='reconnect') emit('reconnect')
  else if (id==='close') emit('close')
  else if (terminal) { terminal.options.fontSize=id==='font-reset'?13:Math.max(10,Math.min(28,(terminal.options.fontSize??13)+(id==='larger'?1:-1)));scheduleFit() }
}
watch(palette, colors => { if(terminal)terminal.options.theme={...colors} })
watch(() => props.ownerDocument, async () => {
  await nextTick()
  if (terminal && container.value) { terminal.open(container.value); scheduleFit(); focus() }
})
let fitFrame = 0
function send(data: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)) }
function fitTerminal() { if (!props.active || !container.value?.clientWidth || !terminal) return; fit?.fit(); if(ready.value) send({type:'terminal.resize',cols:Math.max(20,Math.min(400,terminal.cols)),rows:Math.max(5,Math.min(200,terminal.rows))}) }
function scheduleFit() {
  cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => { if (!disposed) fitTerminal() })
}
function focus() { if (props.active && !hostKey.value) terminal?.focus() }
function endSession(message?: string) {
  if (disposed) return
  ready.value=false;ended.value=true;hostKey.value=undefined
  if(terminal)terminal.options.disableStdin=true
  if(message)notice.value=message
  else if(notice.value===i18nT('m5be0323e8adc')||notice.value===i18nT('m8be0ea36a9bb')||notice.value===i18nT('mf9555e99abca'))notice.value=i18nT('m25ac983d8c45')
  emit('status',i18nT('md79b1d0e5c61'))
}
defineExpose({ focus })
watch(currentLocale, () => { if (ready.value) { notice.value = i18nT('m5be0323e8adc'); emit('status', notice.value) } else if (ended.value) emit('status', i18nT('md79b1d0e5c61')) })
watch(ready, value => emit('running', value))
watch(() => props.active, () => { void nextTick().then(() => { fitTerminal(); focus() }) })
function bottom() { terminal?.scrollToBottom(); newOutput.value=false;terminal?.focus() }
async function decide(accept:boolean) {
  if(!hostKey.value)return
  error.value=''
  try { await rpc('sessions.hostKeyDecision',{sessionId:props.sessionId,accept,fingerprint:hostKey.value.fingerprint,verifiedChange:verified.value},true);hostKey.value=undefined } catch(cause) { error.value=cause instanceof Error?cause.message:i18nT('me516c2a07b83') }
}
onMounted(async () => {
  terminal=new Terminal({scrollback:2000,fontSize:13,fontFamily:'Consolas, monospace',cursorBlink:true,allowProposedApi:true,theme:{...palette.value},disableStdin:true})
  // Only the authoritative backend parser answers terminal queries.
  for(const prefix of ['', '?', '>','='])for(const final of ['n','c'])terminal.parser.registerCsiHandler({prefix,final},()=>true)
  for(const prefix of ['', '?'])terminal.parser.registerCsiHandler({prefix,intermediates:'$',final:'p'},()=>true)
  terminal.parser.registerCsiHandler({final:'t'},()=>true)
  terminal.parser.registerDcsHandler({intermediates:'$',final:'q'},()=>true)
  terminal.parser.registerDcsHandler({intermediates:'+',final:'q'},()=>true)
  for(const id of [4,10,11,12,13,14,15,16,17,18,19])terminal.parser.registerOscHandler(id,data=>data.includes('?'))
  fit=new FitAddon();terminal.loadAddon(fit);terminal.open(container.value!);fitTerminal();focus()
  terminal.attachCustomKeyEventHandler(event=>{
    if(ended.value && props.active && !hostKey.value && !menu.value && event.key==='Enter' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && !event.isComposing){
      if(event.type==='keydown'){
        event.preventDefault()
        if(!event.repeat && connectionState.value==='ready')emit('reconnect')
      }
      return false
    }
    if(event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase()==='c'){
      if(event.type==='keydown'){event.preventDefault();if(ready.value)terminal!.input('\x03',true)}
      return false
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase()==='c') {
      if(event.type==='keydown'){event.preventDefault();selectedText.value=terminal!.getSelection();void copySelection()}
      return false
    }
    // Let the browser dispatch its paste event; xterm handles bracketed paste.
    if(event.ctrlKey && event.shiftKey && event.key.toLowerCase()==='v')return false
    if(event.type==='keydown' && (event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))){
      event.preventDefault();const rect=container.value!.getBoundingClientRect()
      selectedText.value=terminal!.getSelection();menu.value={x:rect.left+24,y:rect.top+24};return false
    }
    return true
  })
  resize=new ResizeObserver(scheduleFit);resize.observe(container.value!)
  terminal.onData(text=>{
    if(!ready.value || socket?.readyState!==WebSocket.OPEN)return
    const bytes=new TextEncoder().encode(text)
    if(bytes.byteLength>128*1024 || socket.bufferedAmount+bytes.byteLength>128*1024){notice.value=i18nT('m1492dcdcb0d0');return}
    for(let start=0;start<bytes.length;start+=16*1024)socket.send(bytes.subarray(start,start+16*1024))
  })
  terminal.onScroll(()=>{if(terminal && terminal.buffer.active.viewportY>=terminal.buffer.active.baseY)newOutput.value=false})
  let attachToken=props.attachToken
  try{if(!attachToken)attachToken=(await rpc<{attachToken:string}>('sessions.attachTicket',{sessionId:props.sessionId})).attachToken}catch(cause){endSession(cause instanceof Error?cause.message:i18nT('m3e72c076716e'));return}
  if(disposed)return
  socket=new WebSocket(wsOrigin+'/ws/terminal');socket.binaryType='arraybuffer'
  socket.onopen=()=>send({type:'terminal.attach',sessionId:props.sessionId,attachToken,cols:Math.max(20,Math.min(400,terminal!.cols)),rows:Math.max(5,Math.min(200,terminal!.rows))})
  socket.onmessage=event=>{
    if(disposed)return
    if(event.data instanceof ArrayBuffer){
      const bytes=new Uint8Array(event.data);queued+=bytes.byteLength
      if(queued>256*1024 || bytes.byteLength>16*1024){notice.value=i18nT('md6e12799ec70');socket?.close();return}
      terminal!.write(bytes,()=>{
        if(disposed)return
        queued-=bytes.byteLength;parsed+=bytes.byteLength;send({type:'terminal.ack',parsedBytes:parsed})
        if(terminal!.buffer.active.viewportY<terminal!.buffer.active.baseY)newOutput.value=true
      });return
    }
    try {
      const message=JSON.parse(String(event.data)) as Record<string,unknown>
      if(message.type==='terminal.snapshot'){terminal!.resize(Number(message.cols),Number(message.rows))}
      else if(message.type==='terminal.ready'){ready.value=true;ended.value=false;terminal!.options.disableStdin=false;notice.value=i18nT('m5be0323e8adc');emit('status',i18nT('m5be0323e8adc'));fitTerminal();if(props.active)terminal!.focus()}
      else if(message.type==='terminal.hostkey' && typeof message.fingerprint==='string' && typeof message.host==='string' && typeof message.port==='number') {hostKey.value={fingerprint:message.fingerprint,previous:String(message.previous??''),changed:message.changed===true,host:message.host,port:message.port};notice.value=i18nT('mf9555e99abca')}
      else if(message.type==='terminal.exit'||message.type==='terminal.error')endSession(typeof message.message==='string'?message.message:undefined)
      else if(typeof message.message==='string')notice.value=message.message
    } catch { notice.value=i18nT('mcdebbd6e9bfa');socket?.close() }
  }
  socket.onclose=event=>{if(!ended.value){detached.value=true;endSession(event.code===4001?i18nT('m34f766d0516e'):i18nT('m0141a649a765'))}}
  socket.onerror=()=>{detached.value=true;endSession(i18nT('mb2300d893cdd'));socket?.close()}
})
onBeforeUnmount(()=>{disposed=true;cancelAnimationFrame(fitFrame);resize?.disconnect();socket?.close();terminal?.dispose()})
</script>
<template>
  <div class="terminal-pane" :style="{background:palette.background,color:palette.foreground}">
    <div class="terminal-status"><span role="status">{{ notice }}<span v-if="ended && !hostKey" class="terminal-reconnect-hint">{{ reconnectHint }}</span></span><div class="terminal-actions"><button v-if="newOutput" class="button" @click="bottom">{{ i18nT('m122b4f8d6db6') }}</button><button class="icon-button" :title="i18nT('ma5783b941d7d')" :aria-label="i18nT('ma5783b941d7d')" @click="emit('history')"><PhClock :size="17" /></button><button v-if="!floating" class="icon-button" :title="i18nT('m710238fe310c')" :aria-label="i18nT('m710238fe310c')" @click="emit('float')"><PhArrowSquareOut :size="17" /></button></div></div>
    <section v-if="hostKey" class="host-key-prompt" role="alert"><strong>{{ hostKey.changed ? i18nT('m473acb4f7a8f') : i18nT('m76decad3d710') }}</strong><p>{{ hostKey.host }}:{{ hostKey.port }}</p><code>{{ hostKey.fingerprint }}</code><p v-if="hostKey.changed">{{ i18nT('mcfe6f505c0b2') }}<code>{{ hostKey.previous }}</code></p><label v-if="hostKey.changed" class="check-label"><input v-model="verified" type="checkbox" />{{ i18nT('ma581bcfd4993') }}</label><div class="form-actions"><button class="button" @click="decide(false)">{{ i18nT('m136de7a8c46f') }}</button><button class="button primary" :disabled="hostKey.changed && !verified" @click="decide(true)">{{ i18nT('m60d8fbd14c9c') }}</button></div><p v-if="error" class="field-error">{{ error }}</p></section>
    <div ref="container" class="terminal-canvas" :inert="!!hostKey || undefined" @contextmenu.capture="openMenu" @mousedown.capture="($event.button === 2) && $event.stopPropagation()"></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :owner="ownerDocument" :items="menuItems" :label="i18nT('mbfef4ef9f1c3')" :extension="menuExtension" :execute="action" @close="menu=undefined" />
  </div>
</template>
