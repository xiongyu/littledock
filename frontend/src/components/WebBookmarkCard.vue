<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.webBookmarks')

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhGlobeHemisphereWest, PhKey, PhPencilSimple, PhArrowClockwise } from '@phosphor-icons/vue'
import type { WebBookmark } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
import { loadBookmarkPreview } from '../bookmark-preview'

const props = defineProps<{ bookmark: WebBookmark }>()
const emit = defineEmits<{ edit: []; reveal: []; refresh: [] }>()
const card = ref<HTMLElement>(), visible = ref(false), image = ref<string>()
const pending = computed(() => ['pending', 'capturing'].includes(props.bookmark.previewState))
let observer: IntersectionObserver | undefined, generation = 0
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting) }, { rootMargin: '160px' })
  if (card.value) observer.observe(card.value)
})
watch([visible, () => props.bookmark.capturedAt, () => props.bookmark.url, connectionState], async () => {
  const attempt = ++generation
  image.value = undefined
  if (!visible.value || !props.bookmark.capturedAt || connectionState.value !== 'ready') return
  try {
    const result = await loadBookmarkPreview(() => attempt === generation, () => rpc<{ dataUrl: string | null; capturedAt: number }>('bookmarks.thumbnail', { id: props.bookmark.id }))
    if (attempt === generation && result?.capturedAt === props.bookmark.capturedAt && result.dataUrl?.startsWith('data:image/jpeg;base64,')) image.value = result.dataUrl
  } catch { /* The card remains usable with its placeholder; refresh retries the capture. */ }
}, { immediate: true })
onBeforeUnmount(() => { generation++; observer?.disconnect(); image.value = undefined })
</script>

<template>
  <article ref="card" class="web-bookmark-card">
    <a :href="bookmark.url" target="_blank" rel="noopener noreferrer" :title="`${bookmark.name}\n${bookmark.url}`" :aria-label="i18nT('m361fdca91bf2', { p0: (bookmark.name) })">
      <div class="web-bookmark-preview">
        <img v-if="image" :src="image" :alt="i18nT('m494c3d1bd697', { p0: (bookmark.name) })" />
        <div v-else class="web-bookmark-placeholder"><PhGlobeHemisphereWest :size="30" /><span>{{ pending ? i18nT('m0674f458af24') : bookmark.previewState === 'failed' ? i18nT('m6c51a555a646') : i18nT('m07a1166b5022') }}</span></div>
        <span v-if="image && pending" class="web-bookmark-badge">{{ i18nT('maa06c367f0d8') }}</span>
      </div>
      <strong>{{ bookmark.name }}</strong>
    </a>
    <div class="web-bookmark-actions">
      <button class="icon-button small" :disabled="!bookmark.hasLogin" :aria-label="i18nT('m35824b173fbc', { p0: (bookmark.name) })" :title="bookmark.hasLogin ? i18nT('m08c3d6fbbb52') : i18nT('mbbc0d033cd81')" @click="emit('reveal')"><PhKey :size="16" /></button>
      <button class="icon-button small" :aria-label="i18nT('m9268247bda57', { p0: (bookmark.name) })" :title="i18nT('mc8edd776b553')" @click="emit('edit')"><PhPencilSimple :size="16" /></button>
      <button class="icon-button small" :disabled="pending" :aria-label="i18nT('m78f29c15d513', { p0: (bookmark.name) })" :title="i18nT('m62bfb1c1a1c3')" @click="emit('refresh')"><PhArrowClockwise :size="16" /></button>
    </div>
  </article>
</template>
