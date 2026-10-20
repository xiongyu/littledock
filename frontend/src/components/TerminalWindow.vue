<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowSquareIn, PhTerminalWindow, PhX } from '@phosphor-icons/vue'

const TerminalPane = defineAsyncComponent(() => import('./TerminalPane.vue'))
const props = defineProps<{
  sessionId: string
  attachToken: string
  name: string
  active: boolean
  floating: boolean
  order: number
  focusRequest: number
}>()
const emit = defineEmits<{ status: [text: string]; history: []; float: []; dock: []; close: []; raise: [] }>()
const windowElement = ref<HTMLElement>()
const pane = ref<InstanceType<typeof TerminalPane>>()
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
  if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return
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
  <section ref="windowElement" v-show="active || floating" :id="`workspace-panel-${sessionId}`" class="terminal-window" :class="{ 'is-floating': floating }" :style="windowStyle" :role="floating ? 'region' : 'tabpanel'" :aria-label="floating ? `悬浮终端 ${name}` : undefined" :aria-labelledby="floating ? undefined : `workspace-tab-${sessionId}`" @pointerdown.capture="floating && emit('raise')">
    <header v-if="floating" class="floating-terminal-header" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag">
      <PhTerminalWindow :size="17" /><strong :title="name">{{ name }}</strong>
      <button class="icon-button" title="收回标签页" aria-label="收回标签页" @click="emit('dock')"><PhArrowSquareIn :size="17" /></button>
      <button class="icon-button" :title="`关闭终端 ${name}`" :aria-label="`关闭终端 ${name}`" @click="emit('close')"><PhX :size="17" /></button>
    </header>
    <TerminalPane ref="pane" :session-id="sessionId" :attach-token="attachToken" :active="active || floating" :floating="floating" @status="emit('status', $event)" @history="emit('history')" @float="emit('float')" />
  </section>
</template>
