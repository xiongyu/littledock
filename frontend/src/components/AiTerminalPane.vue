<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.mcp')

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { PhLockKey, PhLockKeyOpen, PhClock, PhArrowSquareOut } from '@phosphor-icons/vue'
import { resolveTerminalTheme } from '@webnav/shared'
import { rpc, wsOrigin, terminalThemes } from '../backend'
import ContextMenu from './ContextMenu.vue'
import { menuBinding } from '../plugin-menus'
import '@xterm/xterm/css/xterm.css'
const props=defineProps<{sessionId:string;active:boolean;floating?:boolean;themeId?:string;ownerDocument?:Document}>()
const emit=defineEmits<{status:[text:string];running:[value:boolean];history:[];float:[];close:[];colors:[]}>()
const canvas=ref<HTMLElement>(),notice=ref(i18nT('m0ce8f0e12131')),writable=ref(false),connected=ref(false),ended=ref(false),controller=ref('ai')
const observing=ref(false),attaching=ref(false)
const hostKey=ref<{fingerprint:string;previous:string;changed:boolean;host:string;port:number}>(),verified=ref(false)
const menu=ref<{x:number;y:number}>(),selection=ref('')
const menuExtension = menuBinding('builtin.mcp', 'terminal', () => ({ sessionId: props.sessionId, connected: connected.value, writable: writable.value, hasSelection: !!selection.value }), () => !disposed && props.active && !!menu.value)
const palette=computed(()=>resolveTerminalTheme(terminalThemes.value,props.themeId).colors)
let terminal:Terminal,fit:FitAddon,socket:WebSocket|undefined,observer:ResizeObserver|undefined,disposed=false,epoch=0,seq=0,parsed=0,queued=0,frame=0,generation=0,remoteCols=100,remoteRows=30
const items=computed(()=>[{id:'copy',label:i18nT('m63d90d977348'),disabled:!selection.value},{id:'paste',label:i18nT('m335179267471'),disabled:!writable.value},{id:'interrupt',label:i18nT('mb44d0a6ed86f'),disabled:!writable.value},{id:'select',label:i18nT('m3a5040b68abf')},{id:'bottom',label:i18nT('m2fdb6c468166')},{id:'history',label:i18nT('ma5783b941d7d'),separator:true},{id:'colors',label:i18nT('m3e7571c83eac')},{id:'close',label:i18nT('m16707b59cf5e'),danger:true}])
function send(p:Record<string,unknown>){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(p))}
function input(text:string){
  if(!writable.value)return
  const bytes=new TextEncoder().encode(text)
  if(bytes.length>128*1024){notice.value=i18nT('m568e56ae18e9');return}
  // Split at characters, never inside UTF-8 or a surrogate pair.
  let chunk='',size=0
  for(const character of text){const length=new TextEncoder().encode(character).length;if(size+length>16384){send({type:'terminal.input',controlEpoch:epoch,seq:++seq,text:chunk});chunk='';size=0}chunk+=character;size+=length}
  if(chunk)send({type:'terminal.input',controlEpoch:epoch,seq:++seq,text:chunk})
}
function release(){writable.value=false;terminal.options.disableStdin=true;cancelAnimationFrame(frame);send({type:'terminal.release'})}
function fitView(){
  if(!props.active||!canvas.value?.clientWidth||!writable.value)return
  const dimensions=fit.proposeDimensions();if(!dimensions)return
  const cols=Math.max(20,Math.min(400,dimensions.cols)),rows=Math.max(5,Math.min(200,dimensions.rows))
  terminal.resize(cols,rows)
  if(cols!==remoteCols||rows!==remoteRows){remoteCols=cols;remoteRows=rows;send({type:'terminal.resize',cols,rows,controlEpoch:epoch})}
}
function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(fitView)}
function focus(){if(props.active&&!hostKey.value)terminal?.focus()}
defineExpose({focus})
async function action(id:string){
  menu.value=undefined
  try{
    const clipboard=(props.ownerDocument??document).defaultView!.navigator.clipboard
    if(id==='copy')await clipboard.writeText(selection.value)
    if(id==='paste'&&writable.value){const text=await clipboard.readText();if(writable.value)terminal.paste(text)}
    if(id==='interrupt')input('\x03')
    if(id==='select')terminal.selectAll()
    if(id==='bottom')terminal.scrollToBottom()
    if(id==='history')emit('history')
    if(id==='colors')emit('colors')
    if(id==='close')emit('close')
  }catch{notice.value=i18nT('mc4d3eba1b734')}
}
function decide(accept:boolean){if(hostKey.value)send({type:'terminal.hostkeyDecision',accept,fingerprint:hostKey.value.fingerprint,verifiedChange:verified.value});hostKey.value=undefined}
async function attach(reset=false){
  if(attaching.value)return
  const attempt=++generation
  attaching.value=true;observing.value=false;writable.value=false;terminal.options.disableStdin=true
  socket?.close();socket=undefined
  try{
    if(reset){await new Promise<void>(resolve=>terminal.write('',resolve));if(disposed)return;parsed=0;queued=0;terminal.reset()}
    const ticket=await rpc<{attachToken:string}>('automation.attach',{sessionId:props.sessionId})
    if(disposed||attempt!==generation)return
    socket=new WebSocket(wsOrigin+'/ws/automation-terminal');socket.binaryType='arraybuffer'
    socket.onopen=()=>{if(disposed||attempt!==generation)return;observing.value=true;send({type:'terminal.attach',sessionId:props.sessionId,...ticket})}
    socket.onmessage=e=>{
      if(disposed||attempt!==generation)return
      if(e.data instanceof ArrayBuffer){
        const bytes=new Uint8Array(e.data);queued+=bytes.length
        if(queued>256*1024||bytes.length>16384){socket?.close();notice.value=i18nT('m21430e3dcb2e');return}
        terminal.write(bytes,()=>{if(disposed||attempt!==generation)return;queued-=bytes.length;parsed+=bytes.length;send({type:'terminal.ack',parsedBytes:parsed})});return
      }
      const p=JSON.parse(String(e.data)) as Record<string,unknown>
      if(p.type==='terminal.snapshot'){remoteCols=Number(p.cols);remoteRows=Number(p.rows);terminal.resize(remoteCols,remoteRows);return}
      if(p.type==='terminal.control'){
        if(epoch!==p.controlEpoch){epoch=Number(p.controlEpoch);seq=0}
        writable.value=p.writable===true;connected.value=p.connected===true;ended.value=p.ended===true;controller.value=String(p.controller)
        terminal.options.disableStdin=!writable.value
        remoteCols=Number(p.cols);remoteRows=Number(p.rows)
        if(!writable.value)terminal.resize(remoteCols,remoteRows)
        notice.value=ended.value?(connected.value?i18nT('m64a620b0a1a0'):String(p.message??i18nT('mb3bd5fbe29a4'))):writable.value?i18nT('mad216d37054e'):connected.value?(controller.value==='none'?i18nT('ma952018f849e'):i18nT('mbc73ed97182d')+(controller.value==='user'?i18nT('m62450cd9ff41'):i18nT('mccc261cd98a5'))):i18nT('m694186911ae3')
        emit('status',notice.value);emit('running',connected.value);if(writable.value){schedule();focus()}
      }else if(p.type==='terminal.hostkey'){hostKey.value=p as typeof hostKey.value;notice.value=i18nT('mf9555e99abca')}
      else if(p.type==='terminal.exit'){notice.value=String(p.message);ended.value=true;connected.value=false;writable.value=false;terminal.options.disableStdin=true;emit('running',false)}
      else if(p.type==='terminal.notice'||p.type==='terminal.error')notice.value=String(p.message)
    }
    socket.onclose=()=>{if(disposed||attempt!==generation)return;observing.value=false;writable.value=false;terminal.options.disableStdin=true;if(!ended.value)notice.value=i18nT('mee673df8b356');emit('running',connected.value)}
    socket.onerror=()=>{if(disposed||attempt!==generation)return;notice.value=i18nT('m36e2356dc6f1')}
  }catch(e){if(!disposed&&attempt===generation)notice.value=(e as Error).message}
  finally{if(attempt===generation)attaching.value=false}
}
function reattach(){void attach(true)}
watch(palette,p=>{if(terminal)terminal.options.theme={...p}})
watch(()=>props.active,()=>{void nextTick().then(()=>{schedule();focus()})})
watch(()=>props.ownerDocument,()=>{void nextTick().then(()=>{if(terminal&&canvas.value)terminal.open(canvas.value);schedule();focus()})})
onMounted(()=>{
  terminal=new Terminal({scrollback:2000,cols:100,rows:30,fontSize:13,fontFamily:'Consolas, monospace',disableStdin:true,allowProposedApi:true,theme:{...palette.value}})
  fit=new FitAddon();terminal.loadAddon(fit);terminal.open(canvas.value!)
  // Device status/color requests are answered exactly once by the authoritative backend parser.
  for(const prefix of ['', '?', '>','='])for(const final of ['n','c'])terminal.parser.registerCsiHandler({prefix,final},()=>true)
  for(const prefix of ['', '?'])terminal.parser.registerCsiHandler({prefix,intermediates:'$',final:'p'},()=>true)
  terminal.parser.registerCsiHandler({final:'t'},()=>true)
  terminal.parser.registerDcsHandler({intermediates:'$',final:'q'},()=>true)
  terminal.parser.registerDcsHandler({intermediates:'+',final:'q'},()=>true)
  for(const id of [4,10,11,12,13,14,15,16,17,18,19])terminal.parser.registerOscHandler(id,data=>data.includes('?'))
  terminal.onData(text=>{if(writable.value)input(text)})
  terminal.attachCustomKeyEventHandler(e=>{
    if(e.ctrlKey&&e.shiftKey&&e.key.toLowerCase()==='c'){if(e.type==='keydown'){selection.value=terminal.getSelection();void action('copy')}return false}
    return true
  })
  observer=new ResizeObserver(schedule);observer.observe(canvas.value!);void attach()
})
onBeforeUnmount(()=>{disposed=true;cancelAnimationFrame(frame);observer?.disconnect();socket?.close();terminal?.dispose()})
</script>
<template>
  <div class="terminal-pane ai-terminal-pane" :style="{background:palette.background,color:palette.foreground}">
    <div class="terminal-status"><span><b class="ai-badge">AI</b> {{ notice }}</span><div class="terminal-actions">
      <button v-if="observing && connected && !writable && controller !== 'user' && !ended" class="icon-button" :aria-label="i18nT('m4ed49b1231d0')" :title="i18nT('m8a6953fe0f41')" @click="send({type:'terminal.takeover'})"><PhLockKey :size="18"/></button>
      <button v-if="observing && (writable || (connected && controller === 'none'))" class="icon-button" :aria-label="i18nT('mb40192805375')" :title="i18nT('mb1a89e75be2b')" @click="release"><PhLockKeyOpen :size="18"/></button>
      <button v-if="!observing && !attaching && !ended" class="button" @click="reattach">{{ i18nT('m7c4b06e07cb4') }}</button>
      <button class="icon-button" :title="i18nT('ma5783b941d7d')" :aria-label="i18nT('ma5783b941d7d')" @click="emit('history')"><PhClock :size="17"/></button><button v-if="!floating" class="icon-button" :title="i18nT('m710238fe310c')" :aria-label="i18nT('m710238fe310c')" @click="emit('float')"><PhArrowSquareOut :size="17"/></button>
    </div></div>
    <section v-if="hostKey" class="host-key-prompt" role="alert"><strong>{{ hostKey.changed?i18nT('m473acb4f7a8f'):i18nT('m49302e40ce7f') }}</strong><p>{{ hostKey.host }}:{{ hostKey.port }}</p><code>{{ hostKey.fingerprint }}</code><p v-if="hostKey.changed">{{ i18nT('mdacc8e7b3baf', { p0: (hostKey.previous) }) }}</p><label v-if="hostKey.changed"><input v-model="verified" type="checkbox"/>{{ i18nT('m53a8b3f5fff7') }}</label><div class="form-actions"><button class="button" @click="decide(false)">{{ i18nT('m136de7a8c46f') }}</button><button class="button primary" :disabled="hostKey.changed && !verified" @click="decide(true)">{{ i18nT('m60d8fbd14c9c') }}</button></div></section>
    <div ref="canvas" class="terminal-canvas" :inert="!!hostKey || undefined" @contextmenu.prevent="selection=terminal.getSelection();menu={x:$event.clientX,y:$event.clientY}"></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :owner="ownerDocument" :items="items" :label="i18nT('m9fa9fb83a03d')" :extension="menuExtension" :execute="action" @close="menu=undefined"/>
  </div>
</template>
