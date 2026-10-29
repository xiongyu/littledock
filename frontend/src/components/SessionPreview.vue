<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, ref } from 'vue'
import { PhMonitor } from '@phosphor-icons/vue'
import { selectSessionPreview } from '../session-preview'
import type { PreviewFrame, PreviewSession } from '../session-preview'

const props = defineProps<{
  serverName: string
  sessions?: readonly PreviewSession[]
  lastFrame?: PreviewFrame
}>()

const selection = computed(() => selectSessionPreview(props.sessions ?? [], props.lastFrame))
const failedFrameUrl = ref('')
const frameVisible = computed(() => selection.value.frame && selection.value.frame.objectUrl !== failedFrameUrl.value)
const protocol = computed(() => selection.value.session?.protocol ?? selection.value.frame?.protocol)
const description = computed(() => {
  const selected = selection.value
  if (!selected.frame) return i18nT('m2976fc85f8d4', { p0: (props.serverName), p1: (protocol.value?.toUpperCase() ?? i18nT('ma63280253f17')) })
  const time = new Date(selected.frame.capturedAt).toLocaleTimeString(displayLocale(), { hour12: false })
  return `${props.serverName}：${protocol.value?.toUpperCase()} ${selected.running ? i18nT('m1f0eb99b7ed0') : i18nT('m821a9b7e3120')}，${time}`
})
</script>

<template>
  <figure class="session-preview" role="img" :aria-label="description" :title="description" :data-protocol="protocol">
    <img v-if="frameVisible && selection.frame" :src="selection.frame.objectUrl" alt="" draggable="false" @error="failedFrameUrl = selection.frame?.objectUrl ?? ''" />
    <span v-else class="session-preview-empty"><PhMonitor :size="22" /><span>{{ i18nT('m964dbbae8f8c') }}</span></span>
    <figcaption v-if="protocol" class="session-preview-caption"><span v-if="selection.running" class="preview-running-mark"></span>{{ protocol.toUpperCase() }}</figcaption>
  </figure>
</template>
