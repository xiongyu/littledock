<script setup lang="ts">
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
const container = ref<HTMLElement>(), notice = ref('正在连接…'), ready = ref(false), ended = ref(false), newOutput = ref(false), verified = ref(false), error = ref('')
const hostKey = ref<{fingerprint:string;previous:string;changed:boolean;host:string;port:number}>()
const detached=ref(false)
let terminal: Terminal | undefined, socket: WebSocket | undefined, fit: FitAddon | undefined, resize: ResizeObserver | undefined, parsed = 0, queued = 0, disposed = false
const menu = ref<{x:number;y:number}>()
const selectedText = ref('')
const menuExtension = menuBinding('builtin.sessions', 'terminal', () => ({ sessionId: props.sessionId, ready: ready.value, hasSelection: !!selectedText.value }), () => !disposed && props.active && !!menu.value)
const palette = computed(() => resolveTerminalTheme(terminalThemes.value, props.themeId).colors)
const reconnectHint = computed(() => connectionState.value === 'ready' ? detached.value?'按 Enter 恢复原会话':'按 Enter 重新连接' : connectionState.value === 'locked' ? '解锁后按 Enter 恢复连接' : '本地服务恢复后按 Enter 恢复连接')
const menuItems = computed(() => [
  { id:'copy', label:'复制', shortcut:'Ctrl Shift C', disabled:!selectedText.value },
  { id:'paste', label:'粘贴', shortcut:'Ctrl Shift V', disabled:!ready.value },
  { id:'select', label:'全选' },
  { id:'interrupt', label:'中断命令', shortcut:'Ctrl C', disabled:!ready.value },
  { id:'bottom', label:'回到底部', separator:true },
  { id:'history', label:'查看历史 / 搜索' },
  { id:'larger', label:'放大文字', separator:true },
  { id:'smaller', label:'缩小文字' },
  { id:'font-reset', label:'恢复字号' },
  { id:'colors', label:'终端配色…', separator:true },
  { id:'configure', label:'连接配置…' },
  { id:'reconnect', label:'重新连接', separator:true },
  { id:'close', label:'关闭终端', danger:true },
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
  catch { notice.value='无法写入剪贴板，请允许此页面访问剪贴板后重试。' }
}
async function pasteClipboard() {
  if (!ready.value) return
  try {
    const text = await (props.ownerDocument ?? document).defaultView!.navigator.clipboard.readText()
    if (ready.value && !disposed) { terminal?.paste(text); focus() }
  } catch { notice.value='无法读取剪贴板，请按 Ctrl+Shift+V 粘贴。'; focus() }
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
  else if(notice.value==='已连接'||notice.value==='正在连接…'||notice.value==='等待确认主机指纹')notice.value='连接已结束。'
  emit('status','已结束')
}
defineExpose({ focus })
watch(ready, value => emit('running', value))
watch(() => props.active, () => { void nextTick().then(() => { fitTerminal(); focus() }) })
function bottom() { terminal?.scrollToBottom(); newOutput.value=false;terminal?.focus() }
async function decide(accept:boolean) {
  if(!hostKey.value)return
  error.value=''
  try { await rpc('sessions.hostKeyDecision',{sessionId:props.sessionId,accept,fingerprint:hostKey.value.fingerprint,verifiedChange:verified.value},true);hostKey.value=undefined } catch(cause) { error.value=cause instanceof Error?cause.message:'确认失败。' }
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
    if(bytes.byteLength>128*1024 || socket.bufferedAmount+bytes.byteLength>128*1024){notice.value='输入过长或网络繁忙，请分段粘贴。';return}
    for(let start=0;start<bytes.length;start+=16*1024)socket.send(bytes.subarray(start,start+16*1024))
  })
  terminal.onScroll(()=>{if(terminal && terminal.buffer.active.viewportY>=terminal.buffer.active.baseY)newOutput.value=false})
  let attachToken=props.attachToken
  try{if(!attachToken)attachToken=(await rpc<{attachToken:string}>('sessions.attachTicket',{sessionId:props.sessionId})).attachToken}catch(cause){endSession(cause instanceof Error?cause.message:'无法恢复终端。');return}
  if(disposed)return
  socket=new WebSocket(wsOrigin+'/ws/terminal');socket.binaryType='arraybuffer'
  socket.onopen=()=>send({type:'terminal.attach',sessionId:props.sessionId,attachToken,cols:Math.max(20,Math.min(400,terminal!.cols)),rows:Math.max(5,Math.min(200,terminal!.rows))})
  socket.onmessage=event=>{
    if(disposed)return
    if(event.data instanceof ArrayBuffer){
      const bytes=new Uint8Array(event.data);queued+=bytes.byteLength
      if(queued>256*1024 || bytes.byteLength>16*1024){notice.value='终端输出超过协议上限。';socket?.close();return}
      terminal!.write(bytes,()=>{
        if(disposed)return
        queued-=bytes.byteLength;parsed+=bytes.byteLength;send({type:'terminal.ack',parsedBytes:parsed})
        if(terminal!.buffer.active.viewportY<terminal!.buffer.active.baseY)newOutput.value=true
      });return
    }
    try {
      const message=JSON.parse(String(event.data)) as Record<string,unknown>
      if(message.type==='terminal.snapshot'){terminal!.resize(Number(message.cols),Number(message.rows))}
      else if(message.type==='terminal.ready'){ready.value=true;ended.value=false;terminal!.options.disableStdin=false;notice.value='已连接';emit('status','已连接');fitTerminal();if(props.active)terminal!.focus()}
      else if(message.type==='terminal.hostkey' && typeof message.fingerprint==='string' && typeof message.host==='string' && typeof message.port==='number') {hostKey.value={fingerprint:message.fingerprint,previous:String(message.previous??''),changed:message.changed===true,host:message.host,port:message.port};notice.value='等待确认主机指纹'}
      else if(message.type==='terminal.exit'||message.type==='terminal.error')endSession(typeof message.message==='string'?message.message:undefined)
      else if(typeof message.message==='string')notice.value=message.message
    } catch { notice.value='终端消息无效。';socket?.close() }
  }
  socket.onclose=event=>{if(!ended.value){detached.value=true;endSession(event.code===4001?'此连接已在另一个页面打开。':'显示通道已断开，会话仍由后台管理。')}}
  socket.onerror=()=>{detached.value=true;endSession('显示通道连接失败，可重新恢复。');socket?.close()}
})
onBeforeUnmount(()=>{disposed=true;cancelAnimationFrame(fitFrame);resize?.disconnect();socket?.close();terminal?.dispose()})
</script>
<template>
  <div class="terminal-pane" :style="{background:palette.background,color:palette.foreground}">
    <div class="terminal-status"><span role="status">{{ notice }}<span v-if="ended && !hostKey" class="terminal-reconnect-hint">{{ reconnectHint }}</span></span><div class="terminal-actions"><button v-if="newOutput" class="button" @click="bottom">新输出 ↓</button><button class="icon-button" title="查看历史" aria-label="查看历史" @click="emit('history')"><PhClock :size="17" /></button><button v-if="!floating" class="icon-button" title="悬浮终端" aria-label="悬浮终端" @click="emit('float')"><PhArrowSquareOut :size="17" /></button></div></div>
    <section v-if="hostKey" class="host-key-prompt" role="alert"><strong>{{ hostKey.changed ? '主机指纹发生变化' : '首次连接，确认主机指纹' }}</strong><p>{{ hostKey.host }}:{{ hostKey.port }}</p><code>{{ hostKey.fingerprint }}</code><p v-if="hostKey.changed">已保存：<code>{{ hostKey.previous }}</code></p><label v-if="hostKey.changed" class="check-label"><input v-model="verified" type="checkbox" />已核验服务器的新指纹</label><div class="form-actions"><button class="button" @click="decide(false)">拒绝</button><button class="button primary" :disabled="hostKey.changed && !verified" @click="decide(true)">信任并连接</button></div><p v-if="error" class="field-error">{{ error }}</p></section>
    <div ref="container" class="terminal-canvas" :inert="!!hostKey || undefined" @contextmenu.capture="openMenu" @mousedown.capture="($event.button === 2) && $event.stopPropagation()"></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :owner="ownerDocument" :items="menuItems" label="终端右键菜单" :extension="menuExtension" :execute="action" @close="menu=undefined" />
  </div>
</template>
