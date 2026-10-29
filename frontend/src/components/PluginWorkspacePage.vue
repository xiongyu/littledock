<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'
import { pluginTools, pluginTabs, type PluginWorkspaceTab } from '../plugin-workspace'
const props = defineProps<{ tab: PluginWorkspaceTab; active: boolean }>()
const error = ref('')
function status(value: string) { const index = pluginTabs.findIndex(tab => tab.key === props.tab.key); if (index >= 0) pluginTabs.splice(index, 1, { ...props.tab, status: value }) }
onErrorCaptured(cause => { error.value = cause instanceof Error ? cause.message : '插件页面出错。'; return false })
watch(() => pluginTools[props.tab.key]?.component, () => { error.value = '' })
</script>
<template>
  <section :id="`workspace-panel-${tab.key}`" class="plugin-workspace" role="tabpanel" :aria-labelledby="`workspace-tab-${tab.key}`">
    <div v-if="error" class="empty-state" role="alert"><h2>{{ tab.title }}</h2><p>{{ error }}</p><button class="button" @click="error = ''">重新显示</button></div>
    <component v-else :is="tab.kind === 'tool' ? pluginTools[tab.key]?.component : tab.component" :active="active" :plugin-id="tab.pluginId" :section="tab.section" @status="status" />
  </section>
</template>
<style scoped>
.plugin-workspace{flex:1;min-height:0;min-width:0;overflow:auto;background:var(--page)}
</style>
