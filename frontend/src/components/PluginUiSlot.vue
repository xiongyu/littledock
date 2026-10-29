<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { PluginMenuContext } from '@webnav/shared'
import { pluginUi } from '../plugin-ui'
import PluginUiContent from './PluginUiContent.vue'
const props = defineProps<{ plugin: string; point: string; context: PluginMenuContext; isCurrent: () => boolean; items?: { id: string; label: string }[]; active?: string }>()
const emit = defineEmits<{ 'update:active': [id: string] }>()
const instance = shallowRef<ReturnType<typeof pluginUi.mount>>(), selected = shallowRef(props.active ?? props.items?.[0]?.id ?? ''), error = shallowRef('')
function select(id: string) { selected.value = id; emit('update:active', id) }
watch(() => [props.plugin, props.point, JSON.stringify(props.context)], () => {
  instance.value?.dispose(); instance.value = undefined; error.value = ''
  try { instance.value = pluginUi.mount(props.plugin, props.point, () => props.context, props.isCurrent, select) } catch { error.value = '此扩展区域暂时不可用。' }
}, { immediate: true })
const valid = computed(() => { pluginUi.revision.value; return instance.value?.valid() ?? false })
const extensions = computed(() => instance.value?.items() ?? [])
const keys = new WeakMap<object, number>(); let nextKey = 0
function key(scope: object, id: string) { if (!keys.has(scope)) keys.set(scope, ++nextKey); return instance.value?.id + ':' + id + ':' + keys.get(scope) }
watch(() => props.active, value => { if (value !== undefined) selected.value = value })
watch(() => [...(props.items ?? []).map(item => item.id), ...extensions.value.map(item => item.key)], ids => { if (!ids.includes(selected.value)) select(ids[0] ?? '') }, { immediate: true })
onBeforeUnmount(() => instance.value?.dispose())
</script>
<template>
  <div class="plugin-ui-slot" :data-plugin-slot="plugin + '/' + point">
    <p v-if="error" class="plugin-ui-error" role="alert">{{ error }}</p>
    <template v-else-if="valid && instance">
      <header v-if="instance.kind === 'tabs'" class="plugin-ui-tabs"><div role="tablist" aria-label="扩展标签页"><button v-for="item in items" :key="item.id" role="tab" :aria-selected="selected === item.id" :class="{active:selected === item.id}" @click="select(item.id)">{{ item.label }}</button><button v-for="item in extensions" :key="item.key" role="tab" :aria-selected="selected === item.key" :aria-label="item.title + ' · ' + item.pluginName" :class="{active:selected === item.key}" :title="item.pluginName + ' · ' + item.plugin" @click="select(item.key)">{{ item.title }}<small>{{ item.pluginName }}</small></button></div><slot name="actions" /></header>
      <div v-if="instance.kind === 'tabs'" class="plugin-ui-tab-content" role="tabpanel">
        <slot v-if="items?.some(item => item.id === selected)" :active="selected" />
        <template v-for="item in extensions" :key="key(item.scope,item.key)"><PluginUiContent v-if="item.key === selected" :item="item" :context="instance.context" active /></template>
      </div>
      <div v-else :class="'plugin-ui-' + instance.kind"><slot /><section v-for="item in extensions" :key="key(item.scope,item.key)" :title="item.pluginName + ' · ' + item.plugin"><header v-if="instance.kind === 'panel'"><strong>{{ item.title }}</strong><small>{{ item.pluginName }}</small></header><PluginUiContent :item="item" :context="instance.context" active /></section></div>
    </template>
  </div>
</template>
