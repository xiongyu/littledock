<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { pluginMenus, type PluginMenuBinding, type MenuVisualItem } from '../plugin-menus'
import { pluginUi } from '../plugin-ui'
export interface MenuItem extends MenuVisualItem {}
const props = defineProps<{ x: number; y: number; items: MenuItem[]; owner?: Document; label?: string; extension?: PluginMenuBinding; execute?: (id: string) => unknown }>()
const emit = defineEmits<{ action: [id: string]; close: [] }>()
const element = ref<HTMLElement>()
const position = ref({ left: props.x, top: props.y })
const doc = props.owner ?? document
const target = computed(() => doc.body)
let session: ReturnType<typeof pluginMenus.session> | undefined
let instance: ReturnType<typeof pluginUi.mount> | undefined
if (props.extension) {
  try { session = pluginMenus.session(props.extension); instance = pluginUi.mount(props.extension.plugin, props.extension.point, props.extension.context, props.extension.isCurrent, () => {}) } catch { /* Invalid extension bindings never fall back to unguarded actions. */ }
}
const valid = computed(() => !props.extension || (session?.valid() ?? false))
const run = (id: string) => props.execute ? props.execute(id) : emit('action', id)
const displayed = computed(() => session ? session.items(() => props.items, run) : props.extension ? [] : props.items)
watch(valid, value => { if (!value) dismiss() }, { immediate: true })
function invoke(id: string) { if (!valid.value) return; if (session) void session.execute(id); else run(id); dismiss() }
let previous: HTMLElement | null = null
let disposed = false
function dismiss() { emit('close') }
function outside(event: Event) { if (!event.composedPath().includes(element.value!)) dismiss() }
function keyboard(event: KeyboardEvent) {
  const buttons = [...(element.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  const current = buttons.indexOf(doc.activeElement as HTMLButtonElement)
  let index: number
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismiss(); return }
  if (event.key === 'ArrowDown') index = (current + 1) % buttons.length
  else if (event.key === 'ArrowUp') index = (current - 1 + buttons.length) % buttons.length
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = buttons.length - 1
  else return
  event.preventDefault(); buttons[index]?.focus()
}
onMounted(async () => {
  previous = doc.activeElement as HTMLElement | null
  await nextTick()
  if (disposed || !element.value || !valid.value) return
  const rect = element.value!.getBoundingClientRect(), view = doc.defaultView!
  position.value = { left: Math.max(8, Math.min(props.x, view.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(props.y, view.innerHeight - rect.height - 8)) }
  element.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  doc.addEventListener('pointerdown', outside, true)
  view.addEventListener('resize', dismiss)
  view.addEventListener('blur', dismiss)
})
onBeforeUnmount(() => {
  disposed = true; instance?.dispose()
  doc.removeEventListener('pointerdown', outside, true)
  doc.defaultView?.removeEventListener('resize', dismiss)
  doc.defaultView?.removeEventListener('blur', dismiss)
  if (element.value?.contains(doc.activeElement)) previous?.focus({ preventScroll: true })
})
</script>
<template>
  <Teleport :to="target">
    <div ref="element" class="context-menu" role="menu" :aria-label="label ?? i18nT('mfb44d588be71')" :style="{ left: `${position.left}px`, top: `${position.top}px` }" @keydown="keyboard" @contextmenu.prevent.stop>
      <template v-for="item in displayed" :key="item.id">
        <hr v-if="item.separator" role="separator" />
        <button role="menuitem" :disabled="item.disabled" :class="{ danger: item.danger }" :aria-label="item.source ? item.label + ' · ' + item.source : undefined" @click="invoke(item.id)"><span>{{ item.label }}<small v-if="item.source" class="context-menu-source" :title="item.sourceId">{{ item.source }}</small></span><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd></button>
      </template>
    </div>
  </Teleport>
</template>
