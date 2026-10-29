<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowSquareIn, PhX, PhMinus, PhCornersOut } from '@phosphor-icons/vue'
import type { RdpDisplay, WorkspaceProtocol } from '@webnav/shared'
import { pluginViews } from '../plugins'
import { connectorViews } from '../connectors'

const TerminalPane = defineAsyncComponent(() => import('./TerminalPane.vue'))
const AiTerminalPane = defineAsyncComponent(() => import('./AiTerminalPane.vue'))
const DevicePane = defineAsyncComponent(() => import('./DevicePane.vue'))
const DesktopPane = defineAsyncComponent(() => import('./DesktopPane.vue'))
const props = defineProps<{
  protocol: WorkspaceProtocol
  ai?: boolean
  paneNumber?: number
  locateRequest?: number
  themeId?: string
  ownerDocument?: Document
  detached?: boolean
  split?: boolean
  focused?: boolean
  minimized?: boolean
  collapsedRail?: boolean
  display?: RdpDisplay
  sessionId: string
  attachToken: string
  name: string
  active: boolean
  floating: boolean
  order: number
  focusRequest: number
}>()
const emit = defineEmits<{ status: [text: string]; running: [value: boolean]; frame: [blob: Blob]; history: []; float: []; dock: []; close: []; raise: []; select: []; reconnect: []; configure: []; colors: []; menu: [event:MouseEvent]; minimize: [] }>()
const windowElement = ref<HTMLElement>()
const locatePulse = ref(0)
watch(() => props.locateRequest, request => { if (request) locatePulse.value=request })
const pane = ref<{ focus(): void }>()
const position = ref({ left: 0, top: 0, width: 540, height: 380 })
const bounds = ref({ left: 0, top: 72, width: 1000, height: 600 })
let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
let resize: ResizeObserver | undefined
let sizeFrame = 0
let initialized = false
const windowStyle = computed(() => props.floating ? {
  left: `${position.value.left}px`, top: `${position.value.top}px`,
  width: `${position.value.width}px`, height: `${position.value.height}px`,
  maxWidth: `${bounds.value.left + bounds.value.width - position.value.left}px`,
  maxHeight: `${bounds.value.top + bounds.value.height - position.value.top}px`,
  minWidth: `${Math.min(280, bounds.value.width)}px`,
  minHeight: `${Math.min(220, bounds.value.height)}px`,
  zIndex: 20 + props.order,
} : undefined)

function updateBounds() {
  const header = document.querySelector('.topbar')?.getBoundingClientRect()
  const left = header?.left ?? 0
  const top = Math.max(0, header?.bottom ?? 0)
  bounds.value = { left, top, width: window.innerWidth - left, height: Math.max(0, window.innerHeight - top) }
  constrain()
}
function constrain() {
  if (!props.floating) return
  const area = bounds.value
  position.value.width = Math.min(position.value.width, area.width)
  position.value.height = Math.min(position.value.height, area.height)
  position.value.left = Math.max(area.left, Math.min(position.value.left, area.left + area.width - position.value.width))
  position.value.top = Math.max(area.top, Math.min(position.value.top, area.top + area.height - position.value.height))
}
function startDrag(event: PointerEvent) {
  if (!props.floating || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
  event.preventDefault()
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: position.value.left, top: position.value.top }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  position.value.left = drag.left + event.clientX - drag.x
  position.value.top = drag.top + event.clientY - drag.y
  constrain()
}
function stopDrag() { drag = undefined }
function keyboardMenu(event:KeyboardEvent){
  const target=event.currentTarget as HTMLElement,bounds=target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:bounds.left+12,clientY:bounds.bottom}))
}
watch(() => props.floating, async floating => {
  if (floating) {
    updateBounds()
    if (!initialized) {
      const offset = (props.order % 5) * 24
      position.value.left = bounds.value.left + 16 + offset
      position.value.top = bounds.value.top + 16 + offset
      initialized = true
    }
    constrain()
  } else {
    // CSS resize sets inline dimensions; remove them when returning to the full workspace.
    windowElement.value?.style.removeProperty('width')
    windowElement.value?.style.removeProperty('height')
  }
  await nextTick()
  pane.value?.focus()
}, { immediate: true })
watch(() => props.focusRequest, () => { void nextTick(() => pane.value?.focus()) })
onMounted(() => {
  updateBounds()
  window.addEventListener('resize', updateBounds)
  resize = new ResizeObserver(() => {
    if (!props.floating || !windowElement.value) return
    const rect = windowElement.value.getBoundingClientRect()
    cancelAnimationFrame(sizeFrame)
    sizeFrame = requestAnimationFrame(() => {
      if (props.floating && rect.width && rect.height) {
        position.value.width = rect.width
        position.value.height = rect.height
      }
    })
  })
  if (windowElement.value) resize.observe(windowElement.value)
})
onBeforeUnmount(() => { cancelAnimationFrame(sizeFrame); resize?.disconnect(); window.removeEventListener('resize', updateBounds) })
</script>

<template>
  <section ref="windowElement" v-show="active || floating || detached" :id="`terminal-pane-${sessionId}`" class="terminal-window" :class="{ 'is-floating': floating, 'is-detached':detached, 'is-split':split, 'is-focused':focused, 'is-minimized':minimized, 'collapsed-rail':collapsedRail }" :style="windowStyle" role="region" :aria-label="`${(protocol === 'ssh' || protocol === 'local') ? '终端' : '桌面'} ${name}`" @pointerdown.capture="floating ? emit('raise') : emit('select')" @focusin="!floating && emit('select')">
    <div v-if="locatePulse" :key="locatePulse" class="terminal-locate-pulse" aria-hidden="true" @animationend.self="locatePulse=0"><span>{{ paneNumber }}</span></div>
    <header v-if="floating || detached || split" class="floating-terminal-header" tabindex="0" :aria-label="`${name} 窗格标题`" :title="`${name} · 右键管理窗格`" @contextmenu.prevent.stop="emit('menu',$event)" @keydown.shift.f10.prevent.stop="keyboardMenu" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag">
      <span v-if="paneNumber" class="terminal-pane-number" :title="'终端 '+paneNumber">{{ paneNumber }}</span><component :is="connectorViews[protocol].icon" :size="17" /><strong :title="name">{{ ai ? 'AI · ' + name : name }}</strong>
      <button v-if="floating || detached" class="icon-button" title="收回标签页" aria-label="收回标签页" @click="emit('dock')"><PhArrowSquareIn :size="17" /></button>
      <button v-if="split && !floating && !detached" class="icon-button" :aria-label="minimized ? '还原终端' : '最小化终端'" :title="minimized ? '还原终端' : '最小化终端'" @click="emit('minimize')"><PhCornersOut v-if="minimized" :size="16"/><PhMinus v-else :size="16"/></button>
      <button class="icon-button" :title="`${(protocol === 'ssh' || protocol === 'local') ? '关闭终端' : '关闭桌面'} ${name}`" :aria-label="`${(protocol === 'ssh' || protocol === 'local') ? '关闭终端' : '关闭桌面'} ${name}`" @click="emit('close')"><PhX :size="17" /></button>
    </header>
    <component :is="ai ? AiTerminalPane : pluginViews.terminal ?? TerminalPane" :key="attachToken" v-show="!minimized" v-if="(protocol === 'ssh' || protocol === 'local')" ref="pane" :session-id="sessionId" :attach-token="attachToken" :active="!minimized && (active || floating || detached)" :floating="floating || detached" :theme-id="themeId" :owner-document="ownerDocument" @reconnect="emit('reconnect')" @configure="emit('configure')" @colors="emit('colors')" @close="emit('close')" @status="emit('status', $event)" @running="emit('running', $event)" @history="emit('history')" @float="emit('float')" />
    <DevicePane :key="attachToken" v-else-if="protocol==='adb'||protocol==='wdb'" ref="pane" :session-id="sessionId" :attach-token="attachToken" :protocol="protocol" :active="active || floating" :floating="floating" @status="emit('status',$event)" @running="emit('running',$event)" @frame="emit('frame',$event)" @float="emit('float')" @reconnect="emit('reconnect')"/>
    <component :is="pluginViews.desktop ?? DesktopPane" :key="attachToken" v-else ref="pane" :session-id="sessionId" :attach-token="attachToken" :protocol="protocol" :display="display" :active="active || floating || detached" :floating="floating || detached" @status="emit('status', $event)" @running="emit('running', $event)" @frame="emit('frame', $event)" @float="emit('float')" />
  </section>
</template>
