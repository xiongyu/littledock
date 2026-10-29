<script setup lang="ts">
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
    <a :href="bookmark.url" target="_blank" rel="noopener noreferrer" :title="`${bookmark.name}\n${bookmark.url}`" :aria-label="`打开网站 ${bookmark.name}（新标签页）`">
      <div class="web-bookmark-preview">
        <img v-if="image" :src="image" :alt="`${bookmark.name}的网页截图`" />
        <div v-else class="web-bookmark-placeholder"><PhGlobeHemisphereWest :size="30" /><span>{{ pending ? '正在生成截图' : bookmark.previewState === 'failed' ? '截图未能生成' : '网页预览' }}</span></div>
        <span v-if="image && pending" class="web-bookmark-badge">更新中</span>
      </div>
      <strong>{{ bookmark.name }}</strong>
    </a>
    <div class="web-bookmark-actions">
      <button class="icon-button small" :disabled="!bookmark.hasLogin" :aria-label="`查看${bookmark.name}的账号密码`" :title="bookmark.hasLogin ? '查看账号密码' : '尚未保存账号密码'" @click="emit('reveal')"><PhKey :size="16" /></button>
      <button class="icon-button small" :aria-label="`编辑网页收藏 ${bookmark.name}`" title="编辑收藏" @click="emit('edit')"><PhPencilSimple :size="16" /></button>
      <button class="icon-button small" :disabled="pending" :aria-label="`刷新${bookmark.name}的截图`" title="刷新截图" @click="emit('refresh')"><PhArrowClockwise :size="16" /></button>
    </div>
  </article>
</template>
