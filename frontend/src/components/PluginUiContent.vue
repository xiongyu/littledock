<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import type { PluginMenuContext } from '@webnav/shared'
import type { UiContributionView } from '../plugin-ui'
defineProps<{ item: UiContributionView; context: PluginMenuContext; active: boolean }>()
const failed = ref(false)
onErrorCaptured(() => { failed.value = true; return false })
</script>
<template><div v-if="failed" class="plugin-ui-error" role="alert">{{ item.pluginName }} 的扩展内容暂时不可用。</div><div v-else class="plugin-ui-content"><component :is="item.component" :context="context" :active="active" /></div></template>
