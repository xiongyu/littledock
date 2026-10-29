<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhActivity, PhHardDrives, PhArrowSquareOut, PhX } from '@phosphor-icons/vue'
import { workbenchFonts } from '../plugin-fonts'
import { connectorViews } from '../connectors'

const props = defineProps<{
  terminals: readonly { sessionId: string; name: string; status: string; floating: boolean; protocol: 'ssh' | 'rdp' | 'vnc' | 'local' | 'adb' | 'wdb' | 'plugin'; paneCount: number; ai?:boolean }[]
  activeId: string
  directoryName: string
}>()
const emit = defineEmits<{ select: [id: string]; close: [id: string]; menu: [id:string, event:MouseEvent] }>()
const list = ref<HTMLElement>()
const availableWidth = ref(0)
const tabWidth = computed(() => Math.max(40, Math.min(190, (availableWidth.value - 44) / props.terminals.length)))
const iconOnly = computed(() => tabWidth.value < 92)
const navigationFont = workbenchFonts.getFontInfo('navigation')
const fontSize = computed(() => navigationFont.size)
let observer: ResizeObserver | undefined
let resizeFrame = 0

function keyboardMenu(id:string,event:KeyboardEvent){
  if(id.startsWith('plugin-tool:')||id.startsWith('plugin-settings:'))return
  const bounds=(event.target as HTMLElement).getBoundingClientRect()
  emit('menu',id,new MouseEvent('contextmenu',{clientX:bounds.left,clientY:bounds.bottom}))
}
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
    <div v-for="item in terminals" :key="item.sessionId" class="workspace-tab" :class="{ active: activeId === item.sessionId }" role="presentation" @contextmenu.prevent="item.protocol !== 'plugin' && emit('menu', item.sessionId, $event)" @keydown.shift.f10.prevent="keyboardMenu(item.sessionId,$event)">
      <button :id="`workspace-tab-${item.sessionId}`" class="workspace-tab-select" role="tab" :aria-selected="activeId === item.sessionId" :tabindex="activeId === item.sessionId ? 0 : -1" :aria-controls="`workspace-panel-${item.sessionId}`" :aria-label="`${item.name} · ${item.status}`" :title="`${item.name} · ${item.status}`" @click="emit('select', item.sessionId)">
        <span v-if="item.ai" class="ai-badge" title="AI 发起的终端">AI</span><PhArrowSquareOut v-else-if="item.floating" :size="17" /><PhActivity v-else-if="item.protocol === 'plugin'" :size="17" /><component v-else :is="connectorViews[item.protocol].icon" :size="17" /><span class="workspace-tab-name">{{ item.name }}</span><small v-if="item.paneCount>1" class="workspace-pane-count" :title="`${item.paneCount} 个终端`">{{ item.paneCount }}</small>
      </button>
      <button class="workspace-tab-close" :aria-label="`${item.paneCount>1 ? '关闭整组终端' : item.protocol === 'plugin' ? '关闭插件页面' : item.protocol === 'ssh' ? '关闭终端' : '关闭桌面'} ${item.name}`" :title="`${item.paneCount>1 ? '关闭整组终端' : item.protocol === 'plugin' ? '关闭插件页面' : item.protocol === 'ssh' ? '关闭终端' : '关闭桌面'} ${item.name}`" @click="emit('close', item.sessionId)"><PhX :size="12" /></button>
    </div>
  </div>
</template>
