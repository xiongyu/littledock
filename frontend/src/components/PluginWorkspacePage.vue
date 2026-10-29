<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { onErrorCaptured, ref, watch } from 'vue'
import { pluginTools, pluginTabs, type PluginWorkspaceTab } from '../plugin-workspace'
const props = defineProps<{ tab: PluginWorkspaceTab; active: boolean }>()
const error = ref('')
function status(value: string) { const index = pluginTabs.findIndex(tab => tab.key === props.tab.key); if (index >= 0) pluginTabs.splice(index, 1, { ...props.tab, status: value }) }
onErrorCaptured(cause => { error.value = cause instanceof Error ? cause.message : i18nT('m1ae075e7a57c'); return false })
watch(() => pluginTools[props.tab.key]?.component, () => { error.value = '' })
</script>
<template>
  <section :id="`workspace-panel-${tab.key}`" class="plugin-workspace" role="tabpanel" :aria-labelledby="`workspace-tab-${tab.key}`">
    <div v-if="error" class="empty-state" role="alert"><h2>{{ tab.title }}</h2><p>{{ error }}</p><button class="button" @click="error = ''">{{ i18nT('mbc50c1d9523e') }}</button></div>
    <component v-else :is="tab.kind === 'tool' ? pluginTools[tab.key]?.component : tab.component" :active="active" :plugin-id="tab.pluginId" :section="tab.section" @status="status" />
  </section>
</template>
<style scoped>
.plugin-workspace{flex:1;min-height:0;min-width:0;overflow:auto;background:var(--page)}
</style>
