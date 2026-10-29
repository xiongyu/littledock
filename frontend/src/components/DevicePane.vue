<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.adb')

import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import JMuxer from 'jmuxer'
import { PhArrowSquareOut, PhArrowsOut, PhCursor, PhEye, PhHouse, PhArrowBendUpLeft, PhSquaresFour, PhPower, PhKeyboard, PhX } from '@phosphor-icons/vue'
import { rpc, wsOrigin } from '../backend'
import { devicePoint, wdbKey } from '../device-input'
const props=defineProps<{sessionId:string;attachToken:string;protocol:'adb'|'wdb';active:boolean;floating?:boolean}>()
const emit=defineEmits<{status:[value:string];running:[value:boolean];frame:[blob:Blob];float:[];reconnect:[]}>()
const pane=ref<HTMLElement>(),stage=ref<HTMLElement>(),canvas=ref<HTMLCanvasElement>(),video=ref<HTMLVideoElement>()
const connected=ref(false),control=ref(false),bound=ref(false),notice=ref(i18nT('m8be0ea36a9bb')),width=ref(0),height=ref(0),text=ref(''),textOpen=ref(false),failed=ref(false)
const codecType=ref<'png'|'h264'>(props.protocol==='wdb'?'h264':'png'),enhanced=ref(false),displayFps=ref(0)
let frames=0,lastMeasure=performance.now(),frameCallback=0
let socket:WebSocket|undefined,muxer:JMuxer|undefined,disposed=false,muxerReady=false,codec:Uint8Array|undefined,lastPts:number|undefined,needKeyframe=true,queued=0
let previewTimer:ReturnType<typeof setInterval>|undefined,connectTimer:ReturnType<typeof setTimeout>|undefined,playbackTimer:ReturnType<typeof setInterval>|undefined
let chain=Promise.resolve(),pointer:{id:number;x:number;y:number;at:number}|undefined,lastMove=0,previewBusy=false
const visible=()=>props.active&&!document.hidden
function send(message:Record<string,unknown>){if(socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<64*1024)socket.send(JSON.stringify(message))}
function focus(){stage.value?.focus()}
defineExpose({focus})
function ready(){if(disposed||failed.value)return;clearTimeout(connectTimer);connected.value=true;notice.value=i18nT('m5be0323e8adc');emit('status',i18nT('m5be0323e8adc'));emit('running',true)}
function end(message:string){if(disposed||failed.value)return;failed.value=true;bound.value=false;connected.value=false;control.value=false;text.value='';notice.value=message;emit('status',i18nT('m1f0ac6953e04'));emit('running',false);clearTimeout(connectTimer);socket?.close();muxer?.destroy();muxer=undefined;clearInterval(playbackTimer)}
function release(){if(control.value)send({type:'release_all'});control.value=false;pointer=undefined}
function stageBlur(event:FocusEvent){
  if(event.relatedTarget instanceof Node&&pane.value?.contains(event.relatedTarget)){
    if(control.value)send({type:'device.release'});pointer=undefined
  }else release()
}
function paneBlur(event:FocusEvent){if(!(event.relatedTarget instanceof Node)||!pane.value?.contains(event.relatedTarget))release()}
function mode(){if(!bound.value)return;send({type:'device.control',enabled:!control.value});focus()}
function key(event:KeyboardEvent,down:boolean){
  if(!control.value)return
  if(props.protocol==='wdb'){
    const key=wdbKey(event.code);if(!key)return
    event.preventDefault();event.stopPropagation();if(!event.repeat)send({type:'key',...key,down})
  }else if(enhanced.value){
    const keys:Record<string,number>={Enter:66,Backspace:67,Delete:112,Escape:111,Tab:61,ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Home:122,End:123,PageUp:92,PageDown:93,Space:62,ShiftLeft:59,ShiftRight:60,ControlLeft:113,ControlRight:114,AltLeft:57,AltRight:58,Minus:69,Equal:70,BracketLeft:71,BracketRight:72,Backslash:73,Semicolon:74,Quote:75,Slash:76,Comma:55,Period:56,Backquote:68}
    const code=/^Key[A-Z]$/.test(event.code)?29+event.code.charCodeAt(3)-65:/^Digit[0-9]$/.test(event.code)?7+Number(event.code.slice(5)):keys[event.code]
    if(code!==undefined){event.preventDefault();event.stopPropagation();if(!event.repeat)send({type:'adb.key',code,down,meta:(event.shiftKey?1:0)|(event.altKey?2:0)|(event.ctrlKey?0x1000:0)|(event.metaKey?0x10000:0)})}
  }else if(down){
    const keys:Record<string,number>={Enter:66,Backspace:67,Delete:112,Escape:4,Tab:61,ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Home:3}
    const code=keys[event.code];if(code){event.preventDefault();event.stopPropagation();send({type:'adb.key',code})}
  }
}
function point(event:PointerEvent|WheelEvent){return stage.value?devicePoint(event.clientX,event.clientY,stage.value.getBoundingClientRect(),width.value,height.value):undefined}
function down(event:PointerEvent){
  if(!control.value)return
  const p=point(event);if(!p)return
  event.preventDefault();focus();stage.value?.setPointerCapture(event.pointerId)
  if(props.protocol==='adb'){pointer={id:event.pointerId,x:p.x,y:p.y,at:performance.now()};if(enhanced.value)send({type:'adb.touch',action:0,x:p.x,y:p.y})}
  else{send({type:'mouse_move',x:p.normalizedX,y:p.normalizedY});send({type:'mouse_button',button:['left','middle','right'][event.button]??'left',down:true})}
}
function move(event:PointerEvent){
  if(!control.value||performance.now()-lastMove<16)return
  const p=point(event);if(!p)return;lastMove=performance.now()
  if(props.protocol==='wdb')send({type:'mouse_move',x:p.normalizedX,y:p.normalizedY})
  else if(enhanced.value&&pointer?.id===event.pointerId){pointer.x=p.x;pointer.y=p.y;send({type:'adb.touch',action:2,x:p.x,y:p.y})}
}
function up(event:PointerEvent){
  if(!control.value)return
  const p=point(event)
  if(props.protocol==='wdb'){if(p)send({type:'mouse_move',x:p.normalizedX,y:p.normalizedY});send({type:'mouse_button',button:['left','middle','right'][event.button]??'left',down:false})}
  else if(enhanced.value&&pointer?.id===event.pointerId)send({type:'adb.touch',action:1,x:p?.x??pointer.x,y:p?.y??pointer.y})
  else if(pointer?.id===event.pointerId&&p){
    const duration=Math.min(2000,Math.max(50,Math.round(performance.now()-pointer.at)))
    if(Math.hypot(p.x-pointer.x,p.y-pointer.y)<12&&duration<500)send({type:'adb.tap',x:p.x,y:p.y})
    else send({type:'adb.swipe',x:pointer.x,y:pointer.y,toX:p.x,toY:p.y,duration})
  }
  pointer=undefined
  if(stage.value?.hasPointerCapture(event.pointerId))stage.value.releasePointerCapture(event.pointerId)
}
function wheel(event:WheelEvent){if(!control.value)return;const p=point(event);if(!p)return;if(props.protocol==='wdb'){event.preventDefault();send({type:'wheel',delta:event.deltaY>0?-120:120,horizontal:false})}else if(enhanced.value){event.preventDefault();send({type:'adb.scroll',x:p.x,y:p.y,delta:event.deltaY>0?120:-120})}}
function androidKey(code:number){if(control.value)send({type:'adb.key',code})}
function sendText(){if(control.value&&text.value){send({type:'adb.text',text:text.value});focus();text.value=''}}
function closeText(){focus();textOpen.value=false;text.value=''}
function resetMuxer(){
  if(!muxer||disposed)return
  codec=undefined;lastPts=undefined;needKeyframe=true;muxerReady=false;muxer.reset()
}
function visibility(){
  release();if(!bound.value)return
  send({type:'device.visible',visible:visible()})
  if(visible()&&codecType.value==='h264')resetMuxer()
}
watch(()=>props.active,visibility)
function h264(bytes:Uint8Array){
  if(!muxerReady||!muxer||!visible())return
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  let offset=0
  while(offset<bytes.length){
    if(offset+12>bytes.length)throw new Error(i18nT('m24ab3a256174'))
    const flags=view.getBigUint64(offset),length=view.getUint32(offset+8);offset+=12
    if(!length||offset+length>bytes.length)throw new Error(i18nT('mc51ea436025c'))
    const payload=bytes.subarray(offset,offset+length);offset+=length
    const isConfig=!!(flags&(1n<<63n)),keyframe=!!(flags&(1n<<62n)),pts=Number(flags&((1n<<62n)-1n))
    if(isConfig){if(payload.length>256*1024)throw new Error(i18nT('m2f4aa4a1a66b'));if(codec&&lastPts!==undefined&&(codec.length!==payload.length||codec.some((v,i)=>v!==payload[i]))){resetMuxer();return}codec=payload.slice();continue}
    if(needKeyframe&&!keyframe)continue
    let data=payload
    if(keyframe&&codec){data=new Uint8Array(codec.length+payload.length);data.set(codec);data.set(payload,codec.length)}
    needKeyframe=false
    const duration=lastPts===undefined?1000/30:Math.min(100,Math.max(1,(pts-lastPts)/1000));lastPts=pts
    // The upstream packet is a complete access unit. An Annex-B AUD closes its
    // final NAL for JMuxer 2.1, including the very first SPS/PPS + IDR packet.
    const complete=new Uint8Array(data.length+6);complete.set(data);complete.set([0,0,0,1,9,240],data.length)
    const append=muxer.bufferControllers?.video,track=muxer.remuxController?.tracks.video
    if((append?.queue?.byteLength??0)+(track?.mp4track.len??0)+(track?.remainingData.byteLength??0)+complete.byteLength>8*1024*1024)throw new Error(i18nT('mdc4d6537a08f'))
    muxer.feed({video:complete,duration})
    if(muxer.bufferControllers?.video)muxer.bufferControllers.video.cleanOffset=2
  }
}
async function frame(buffer:ArrayBuffer){
  if(disposed||failed.value)return
  if(buffer.byteLength<5||buffer.byteLength>16*1024*1024+4)throw new Error(i18nT('m71f433002265'))
  const sequence=new DataView(buffer).getUint32(0),bytes=new Uint8Array(buffer,4)
  if(codecType.value==='h264')h264(bytes)
  else if(visible()){
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}))
    try{if(!disposed&&canvas.value){canvas.value.width=bitmap.width;canvas.value.height=bitmap.height;width.value=bitmap.width;height.value=bitmap.height;canvas.value.getContext('2d')?.drawImage(bitmap,0,0);ready()}}finally{bitmap.close()}
  }
  send({type:'device.ack',sequence})
}
function capture(){
  if(disposed||previewBusy||!connected.value||!visible())return
  const source=codecType.value==='h264'?video.value:canvas.value
  if(!source||!width.value||!height.value)return
  const thumbnail=document.createElement('canvas'),scale=Math.min(1,320/width.value,200/height.value)
  thumbnail.width=Math.max(1,Math.round(width.value*scale));thumbnail.height=Math.max(1,Math.round(height.value*scale));previewBusy=true
  try{thumbnail.getContext('2d')?.drawImage(source,0,0,thumbnail.width,thumbnail.height);thumbnail.toBlob(blob=>{previewBusy=false;if(blob&&!disposed)emit('frame',blob)},'image/webp',0.65)}catch{previewBusy=false}
}
let attachmentToken=props.attachToken
function connect(){
  if(disposed)return
  socket=new WebSocket(wsOrigin+'/ws/device');socket.binaryType='arraybuffer'
  socket.onopen=()=>send({type:'device.attach',sessionId:props.sessionId,attachToken:attachmentToken})
  socket.onmessage=event=>{
    if(disposed||failed.value)return
    if(event.data instanceof ArrayBuffer){
      const buffer=event.data;queued+=buffer.byteLength
      if(queued>20*1024*1024){end(i18nT('m844de2ff6e9d'));return}
      chain=chain.then(()=>frame(buffer)).catch(()=>end(i18nT('m98471c7a75c3'))).finally(()=>{queued-=buffer.byteLength});return
    }
    try{
      const m=JSON.parse(event.data)
      if(m.type==='device.ready'){bound.value=true;notice.value=i18nT('mbec258a11f33');send({type:'device.visible',visible:visible()});if(visible()&&codecType.value==='h264')send({type:'device.keyframe'})}
      else if(m.type==='device.info'){if(m.width>0&&m.width<=8192)width.value=m.width;if(m.height>0&&m.height<=8192)height.value=m.height;if(m.mode==='scrcpy')enhanced.value=true;if(m.codec==='h264'&&codecType.value!=='h264'){codecType.value='h264';void setupMuxer()}}
      else if(m.type==='device.control'){control.value=m.enabled===true;if(control.value)focus()}
      else if(m.type==='device.reset')resetMuxer()
      else if(m.type==='device.notice')notice.value=String(m.message)
      else if(m.type==='device.exit'||m.type==='device.error')end(String(m.message??i18nT('m3570ddf53dd9')))
    }catch{end(i18nT('m1baa35028be6'))}
  }
  socket.onclose=()=>end(i18nT('m6263242009ae'))
  socket.onerror=()=>end(i18nT('m177a8b3b2117'))
}
async function setupMuxer(){
    await nextTick()
    if(disposed||muxer)return
    if(!window.MediaSource||!video.value){end(i18nT('m42accc313ff0'));return}
    try{
      muxer=new JMuxer({node:video.value,mode:'video',fps:30,flushingTime:50,maxDelay:300,clearBuffer:true,debug:false,onReady:()=>{muxerReady=true;if(!socket)connect();else if(bound.value&&visible())send({type:'device.keyframe'})},onError:()=>end(i18nT('mec7f15f73936')),onUnsupportedCodec:()=>end(i18nT('mfbe205f4a614'))})
      playbackTimer=setInterval(()=>{
        const now=performance.now();if(now-lastMeasure>=1000){displayFps.value=Math.round(frames*1000/(now-lastMeasure));frames=0;lastMeasure=now}
        const element=video.value;if(!element||!visible()||!element.buffered.length)return
        const endTime=element.buffered.end(element.buffered.length-1)
        if(endTime-element.currentTime>1.5)element.currentTime=Math.max(0,endTime-0.15)
        if(element.paused)void element.play().catch(()=>{notice.value=i18nT('m50b995e11fdd')})
      },500)
      const measure=()=>{if(disposed||!video.value)return;frames++;frameCallback=video.value.requestVideoFrameCallback(measure)}
      frameCallback=video.value.requestVideoFrameCallback(measure)
    }catch{end(i18nT('mc5f3cdc48eec'))}
}
onMounted(async()=>{
  try{if(!attachmentToken)attachmentToken=(await rpc<{attachToken:string}>('devices.attachTicket',{sessionId:props.sessionId})).attachToken}catch(cause){end(cause instanceof Error?cause.message:i18nT('m9ed974773d43'));return}
  if(disposed)return
  connectTimer=setTimeout(()=>end(i18nT('m2d563292271d')),35_000)
  document.addEventListener('visibilitychange',visibility);window.addEventListener('blur',release)
  previewTimer=setInterval(capture,5000)
  if(props.protocol==='wdb')await setupMuxer();else connect()
})
onBeforeUnmount(()=>{release();disposed=true;video.value?.cancelVideoFrameCallback(frameCallback);clearTimeout(connectTimer);clearInterval(previewTimer);clearInterval(playbackTimer);socket?.close();muxer?.destroy();codec=undefined;text.value='';document.removeEventListener('visibilitychange',visibility);window.removeEventListener('blur',release)})
async function fullscreen(){try{if(document.fullscreenElement===pane.value)await document.exitFullscreen();else await pane.value?.requestFullscreen()}catch{notice.value=i18nT('m733c138f0bfb')}}
</script>
<template>
  <div ref="pane" class="device-pane" @focusout="paneBlur">
    <div class="terminal-status device-toolbar"><span role="status">{{notice}}</span><small v-if="width&&height">{{width}} × {{height}} <template v-if="codecType==='png'">{{ i18nT('m66287527438a') }}</template><template v-else>· {{enhanced?'scrcpy · ':''}}{{displayFps}} FPS</template></small><div class="terminal-actions">
      <button class="button device-mode" :disabled="!bound" :aria-pressed="control" :title="control?i18nT('m4945989bf28a'):i18nT('m5db62b1edc50')" @click="mode"><PhCursor v-if="control" :size="16"/><PhEye v-else :size="16"/>{{control?i18nT('mef91aacdcf5e'):i18nT('m39395c1df20e')}}</button>
      <template v-if="protocol==='adb'">
        <button class="icon-button" :disabled="!control" :title="i18nT('m572cf45ba436')" :aria-label="i18nT('mea0d39d2e486')" @click="androidKey(4)"><PhArrowBendUpLeft :size="18"/></button>
        <button class="icon-button" :disabled="!control" :title="i18nT('m3e0d676d2d85')" :aria-label="i18nT('m21b7d4939f60')" @click="androidKey(3)"><PhHouse :size="18"/></button>
        <button class="icon-button" :disabled="!control" :title="i18nT('me69968577d33')" :aria-label="i18nT('mffe4186176c2')" @click="androidKey(187)"><PhSquaresFour :size="18"/></button>
        <button class="icon-button" :disabled="!control" :title="i18nT('m6614e30e04e3')" :aria-label="i18nT('me76c2b635e8b')" @click="androidKey(224)"><PhPower :size="18"/></button>
        <button class="icon-button" :disabled="!control" :title="i18nT('m7159815dd39f')" :aria-label="i18nT('mac794eaac6bc')" @click="textOpen?closeText():textOpen=true"><PhKeyboard :size="18"/></button>
      </template>
      <button v-if="failed" class="button" @click="emit('reconnect')">{{ i18nT('m68891ab35cab') }}</button>
      <button class="icon-button" :title="i18nT('m22ea3f47fee8')" :aria-label="i18nT('mef6d3224859d')" @click="fullscreen"><PhArrowsOut :size="18"/></button>
      <button v-if="!floating" class="icon-button" :title="i18nT('mf561772757ea')" :aria-label="i18nT('mb8a697561156')" @click="emit('float')"><PhArrowSquareOut :size="18"/></button>
    </div></div>
    <form v-if="textOpen&&protocol==='adb'" class="device-text" @submit.prevent="sendText"><input v-model="text" maxlength="512" :aria-label="i18nT('mbea94be17d6d')" :placeholder="enhanced?i18nT('mfac12569f968'):i18nT('m7b7474af8932')"/><button class="button" :disabled="!control||!text">{{ i18nT('medecf0ae6e51') }}</button><button type="button" class="icon-button" :aria-label="i18nT('m2e7a039d0903')" @click="closeText"><PhX :size="18"/></button></form>
    <div ref="stage" class="device-stage" :class="{controlling:control}" tabindex="0" :aria-label="protocol==='adb'?i18nT('m3e5c1199f195'):i18nT('m947d619b5879')" @keydown="key($event,true)" @keyup="key($event,false)" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="release" @blur="stageBlur" @contextmenu.prevent @wheel="wheel" @click="video?.play().catch(()=>{})">
      <canvas v-show="codecType==='png'" ref="canvas"/>
      <video v-show="codecType==='h264'" ref="video" autoplay muted playsinline disablepictureinpicture @loadeddata="ready" @resize="width=video?.videoWidth??width;height=video?.videoHeight??height"/>
      <div v-if="!connected" class="device-placeholder"><strong>{{protocol==='adb'?i18nT('m96a53968e115'):i18nT('m947d619b5879')}}</strong><span>{{notice}}</span></div>
    </div>
  </div>
</template>
<style scoped>
.device-pane{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--surface)}.device-toolbar{height:auto;min-height:36px;padding:5px 10px;color:var(--ink);flex-shrink:0;flex-wrap:wrap;gap:8px}.device-toolbar .terminal-actions{flex-wrap:wrap}.device-toolbar>span{flex:1;min-width:90px;overflow-wrap:anywhere}.device-toolbar small{color:var(--muted);white-space:nowrap}.device-mode{padding:5px 9px;min-height:30px;font-size:12px}.device-mode[aria-pressed=true]{color:var(--accent);border-color:currentColor}.device-stage{position:relative;flex:1;min-height:0;background:#0c1014;outline:none;touch-action:none;overflow:hidden}.device-stage:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}.device-stage.controlling{cursor:crosshair}.device-stage canvas,.device-stage video{display:block;width:100%;height:100%;object-fit:contain}.device-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:24px;color:#adb7c3;text-align:center;pointer-events:none}.device-placeholder strong{font-size:20px;color:#e4e9ef}.device-text{display:flex;gap:8px;padding:10px}.device-text input{flex:1;min-width:0}.device-pane:fullscreen{width:100vw;height:100vh}
</style>
