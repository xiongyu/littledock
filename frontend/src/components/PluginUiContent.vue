<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { onErrorCaptured, ref } from 'vue'
import type { PluginMenuContext } from '@webnav/shared'
import type { UiContributionView } from '../plugin-ui'
defineProps<{ item: UiContributionView; context: PluginMenuContext; active: boolean }>()
const failed = ref(false)
onErrorCaptured(() => { failed.value = true; return false })
</script>
<template><div v-if="failed" class="plugin-ui-error" role="alert">{{ i18nT('m1a41a8b8023d', { p0: (item.pluginName) }) }}</div><div v-else class="plugin-ui-content"><component :is="item.component" :context="context" :active="active" /></div></template>
