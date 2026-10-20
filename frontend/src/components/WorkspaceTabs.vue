<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhHardDrives, PhTerminalWindow, PhArrowSquareOut, PhX } from '@phosphor-icons/vue'

const props = defineProps<{
  terminals: readonly { sessionId: string; name: string; status: string; floating: boolean }[]
  activeId: string
  directoryName: string
}>()
const emit = defineEmits<{ select: [id: string]; close: [id: string] }>()
const list = ref<HTMLElement>()
const availableWidth = ref(0)
const tabWidth = computed(() => Math.max(40, Math.min(190, (availableWidth.value - 44) / props.terminals.length)))
const iconOnly = computed(() => tabWidth.value < 92)
const fontSize = computed(() => Math.max(11, Math.min(13, tabWidth.value / 12)))
let observer: ResizeObserver | undefined
let resizeFrame = 0

function revealActive() {
  const active = list.value?.querySelector<HTMLElement>('[aria-selected="true"]')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
function keyboard(event: KeyboardEvent) {
  // Close controls remain ordinary buttons; arrow navigation belongs to tabs.
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
  const ids = ['', ...props.terminals.map(item => item.sessionId)]
  const tabs = [...(list.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
  const index = tabs.indexOf(event.target)
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % ids.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + ids.length) % ids.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = ids.length - 1
  else return
  event.preventDefault()
  emit('select', ids[next]!)
  void nextTick(() => tabs[next]?.focus())
}
watch(() => props.activeId, () => { void nextTick(revealActive) })
onMounted(() => {
  observer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0
    if (width === availableWidth.value) return
    cancelAnimationFrame(resizeFrame)
    // Width changes alter label visibility and scrolling; do that after observer delivery.
    resizeFrame = requestAnimationFrame(() => {
      availableWidth.value = width
      void nextTick(revealActive)
    })
  })
  if (list.value) observer.observe(list.value)
})
onBeforeUnmount(() => { cancelAnimationFrame(resizeFrame); observer?.disconnect() })
</script>

<template>
  <div ref="list" class="workspace-tabs" :class="{ 'icons-only': iconOnly }" role="tablist" aria-label="工作区标签" :style="{ '--tab-width': `${tabWidth}px`, '--tab-font-size': `${fontSize}px` }" @keydown="keyboard">
    <button id="workspace-tab-catalog" class="directory-tab" :class="{ active: !activeId }" role="tab" :aria-selected="!activeId" :tabindex="activeId ? -1 : 0" aria-controls="workspace-catalog" :aria-label="`服务器目录 · ${directoryName}`" :title="`服务器目录 · ${directoryName}`" @click="emit('select', '')"><PhHardDrives :size="18" /></button>
    <div v-for="item in terminals" :key="item.sessionId" class="workspace-tab" :class="{ active: activeId === item.sessionId }" role="presentation">
      <button :id="`workspace-tab-${item.sessionId}`" class="workspace-tab-select" role="tab" :aria-selected="activeId === item.sessionId" :tabindex="activeId === item.sessionId ? 0 : -1" :aria-controls="`workspace-panel-${item.sessionId}`" :aria-label="`${item.name} · ${item.status}`" :title="`${item.name} · ${item.status}`" @click="emit('select', item.sessionId)">
        <PhArrowSquareOut v-if="item.floating" :size="17" /><PhTerminalWindow v-else :size="17" /><span class="workspace-tab-name">{{ item.name }}</span>
      </button>
      <button class="workspace-tab-close" :aria-label="`关闭终端 ${item.name}`" :title="`关闭终端 ${item.name}`" @click="emit('close', item.sessionId)"><PhX :size="12" /></button>
    </div>
  </div>
</template>
