<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { BackgroundMedia } from '../appearance'

const props = defineProps<{ media: BackgroundMedia; preview?: boolean }>()
const video = ref<HTMLVideoElement>()
const visible = ref(document.visibilityState !== 'hidden')
function playback() {
  const element = video.value
  if (!element) return
  element.muted = true
  if (visible.value && !props.preview) void element.play().catch(() => { /* Browser autoplay policy may require a user gesture. */ })
  else element.pause()
}
function visibility() { visible.value = document.visibilityState !== 'hidden'; playback() }
document.addEventListener('visibilitychange', visibility)
watch([video, () => props.media.src, () => props.preview], playback, { flush: 'post' })
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibility)
  if (video.value) { video.value.pause(); video.value.removeAttribute('src'); video.value.load() }
})
</script>

<template>
  <video v-if="media.kind === 'video'" ref="video" :src="media.src" :autoplay="visible && !preview" muted loop playsinline preload="auto" aria-hidden="true" tabindex="-1" @loadeddata="playback" />
  <img v-else :src="media.src" alt="" />
</template>
