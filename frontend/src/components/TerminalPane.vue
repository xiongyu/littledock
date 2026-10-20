<script setup lang="ts">
import { onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { PhClock, PhArrowSquareOut } from '@phosphor-icons/vue'
import '@xterm/xterm/css/xterm.css'
import { rpc, wsOrigin } from '../backend'
const props = defineProps<{ sessionId: string; attachToken: string; active: boolean; floating?: boolean }>()
const emit = defineEmits<{ status: [text: string]; history: []; float: [] }>()
const container = ref<HTMLElement>(), notice = ref('正在连接…'), ready = ref(false), newOutput = ref(false), verified = ref(false), error = ref('')
const hostKey = ref<{fingerprint:string;previous:string;changed:boolean;host:string;port:number}>()
let terminal: Terminal | undefined, socket: WebSocket | undefined, fit: FitAddon | undefined, resize: ResizeObserver | undefined, parsed = 0, queued = 0, disposed = false
let fitFrame = 0
function send(data: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)) }
function fitTerminal() { if (!props.active || !container.value?.clientWidth || !terminal) return; fit?.fit(); if(ready.value) send({type:'terminal.resize',cols:Math.max(20,Math.min(400,terminal.cols)),rows:Math.max(5,Math.min(200,terminal.rows))}) }
function scheduleFit() {
  cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => { if (!disposed) fitTerminal() })
}
function focus() { if (props.active && !hostKey.value) terminal?.focus() }
defineExpose({ focus })
watch(() => props.active, () => { void nextTick().then(() => { fitTerminal(); focus() }) })
function bottom() { terminal?.scrollToBottom(); newOutput.value=false;terminal?.focus() }
async function decide(accept:boolean) {
  if(!hostKey.value)return
  error.value=''
  try { await rpc('sessions.hostKeyDecision',{sessionId:props.sessionId,accept,fingerprint:hostKey.value.fingerprint,verifiedChange:verified.value},true);hostKey.value=undefined } catch(cause) { error.value=cause instanceof Error?cause.message:'确认失败。' }
}
onMounted(() => {
  terminal=new Terminal({scrollback:2000,fontSize:13,fontFamily:'Consolas, monospace',cursorBlink:true,allowProposedApi:false,theme:{background:'#17201d',foreground:'#dce7e1',cursor:'#bbd6c7'},disableStdin:true})
  fit=new FitAddon();terminal.loadAddon(fit);terminal.open(container.value!);fitTerminal()
  resize=new ResizeObserver(scheduleFit);resize.observe(container.value!)
  terminal.onData(text=>{
    if(!ready.value || socket?.readyState!==WebSocket.OPEN)return
    const bytes=new TextEncoder().encode(text)
    if(bytes.byteLength>128*1024 || socket.bufferedAmount+bytes.byteLength>128*1024){notice.value='输入过长或网络繁忙，请分段粘贴。';return}
    for(let start=0;start<bytes.length;start+=16*1024)socket.send(bytes.subarray(start,start+16*1024))
  })
  terminal.onScroll(()=>{if(terminal && terminal.buffer.active.viewportY>=terminal.buffer.active.baseY)newOutput.value=false})
  socket=new WebSocket(wsOrigin+'/ws/terminal');socket.binaryType='arraybuffer'
  socket.onopen=()=>send({type:'terminal.attach',sessionId:props.sessionId,attachToken:props.attachToken,cols:Math.max(20,Math.min(400,terminal!.cols)),rows:Math.max(5,Math.min(200,terminal!.rows))})
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
      if(message.type==='terminal.ready'){ready.value=true;terminal!.options.disableStdin=false;notice.value='已连接';emit('status','已连接');fitTerminal();if(props.active)terminal!.focus()}
      else if(message.type==='terminal.hostkey' && typeof message.fingerprint==='string' && typeof message.host==='string' && typeof message.port==='number') {hostKey.value={fingerprint:message.fingerprint,previous:String(message.previous??''),changed:message.changed===true,host:message.host,port:message.port};notice.value='等待确认主机指纹'}
      else if(typeof message.message==='string'){notice.value=message.message;if(message.type==='terminal.exit'||message.type==='terminal.error'){ready.value=false;terminal!.options.disableStdin=true;emit('status','已结束')}}
    } catch { notice.value='终端消息无效。';socket?.close() }
  }
  socket.onclose=()=>{ready.value=false;if(terminal)terminal.options.disableStdin=true;if(notice.value==='已连接'||notice.value==='正在连接…')notice.value='连接已结束。';emit('status','已结束')}
  socket.onerror=()=>{notice.value='终端连接失败，请重新打开。'}
})
onBeforeUnmount(()=>{disposed=true;cancelAnimationFrame(fitFrame);resize?.disconnect();socket?.close();terminal?.dispose();void rpc('sessions.close',{sessionId:props.sessionId},true).catch(()=>{})})
</script>
<template>
  <div class="terminal-pane">
    <div class="terminal-status"><span>{{ notice }}</span><div class="terminal-actions"><button v-if="newOutput" class="button" @click="bottom">新输出 ↓</button><button class="icon-button" title="查看历史" aria-label="查看历史" @click="emit('history')"><PhClock :size="17" /></button><button v-if="!floating" class="icon-button" title="悬浮终端" aria-label="悬浮终端" @click="emit('float')"><PhArrowSquareOut :size="17" /></button></div></div>
    <section v-if="hostKey" class="host-key-prompt" role="alert"><strong>{{ hostKey.changed ? '主机指纹发生变化' : '首次连接，确认主机指纹' }}</strong><p>{{ hostKey.host }}:{{ hostKey.port }}</p><code>{{ hostKey.fingerprint }}</code><p v-if="hostKey.changed">已保存：<code>{{ hostKey.previous }}</code></p><label v-if="hostKey.changed" class="check-label"><input v-model="verified" type="checkbox" />已核验服务器的新指纹</label><div class="form-actions"><button class="button" @click="decide(false)">拒绝</button><button class="button primary" :disabled="hostKey.changed && !verified" @click="decide(true)">信任并连接</button></div><p v-if="error" class="field-error">{{ error }}</p></section>
    <div ref="container" class="terminal-canvas" :inert="!!hostKey || undefined"></div>
  </div>
</template>
