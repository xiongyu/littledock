<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RdpDisplay } from '../catalog'

const props = defineProps<{ entryNumber: number; browser?: boolean }>()
const display = defineModel<RdpDisplay>()
const resolutions = [
  [1024, 768], [1280, 720], [1280, 800], [1366, 768], [1600, 900],
  [1920, 1080], [1920, 1200], [2560, 1440], [2560, 1600], [3440, 1440], [3840, 2160],
] as const
const width = ref(display.value?.mode === 'windowed' ? display.value.width : 1920)
const height = ref(display.value?.mode === 'windowed' ? display.value.height : 1080)
const presetValue = () => resolutions.some(([w, h]) => w === width.value && h === height.value) ? `${width.value}x${height.value}` : 'custom'
const resolution = ref(presetValue())
const label = computed(() => `入口 ${props.entryNumber}`)
const mode = computed({
  get: () => display.value?.mode ?? 'default',
  set: (value: string) => {
    if (value === 'default') display.value = undefined
    else if (value === 'windowed') display.value = { mode: value, width: width.value, height: height.value }
    else if (value === 'fullscreen' || value === 'multimon') display.value = { mode: value }
  },
})
watch(resolution, value => {
  if (value === 'custom') return
  const selected = resolutions.find(([w, h]) => `${w}x${h}` === value)
  if (selected) [width.value, height.value] = selected
})
watch([width, height], ([w, h]) => {
  if (display.value?.mode === 'windowed') display.value = { mode: 'windowed', width: w, height: h }
})
</script>

<template>
  <div class="rdp-display-fields">
    <label class="form-field"><span>显示模式</span>
      <select v-model="mode" :aria-label="`${label} 显示模式`">
        <option value="default">{{ browser ? '默认 · 1920 × 1080' : '跟随客户端' }}</option>
        <option value="windowed">窗口 · 指定分辨率</option>
        <option value="fullscreen">全屏 · 单个显示器</option>
        <option value="multimon" :disabled="browser">全屏 · 所有显示器{{ browser ? '（仅系统客户端）' : '' }}</option>
      </select>
    </label>
    <template v-if="mode === 'windowed'">
      <label class="form-field"><span>分辨率</span>
        <select v-model="resolution" :aria-label="`${label} 分辨率`">
          <option v-for="[w, h] in resolutions" :key="`${w}x${h}`" :value="`${w}x${h}`">{{ w }} × {{ h }}</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <div v-if="resolution === 'custom'" class="rdp-custom-resolution">
        <label class="form-field"><span>宽度 <small>px</small></span><input v-model.number="width" :aria-label="`${label} 分辨率宽度`" type="number" min="200" :max="browser ? 4096 : 8192" step="1" required /></label>
        <label class="form-field"><span>高度 <small>px</small></span><input v-model.number="height" :aria-label="`${label} 分辨率高度`" type="number" min="200" :max="browser ? 2160 : 8192" step="1" required /></label>
      </div>
    </template>
    <p v-if="browser" class="rdp-display-hint">网页桌面最大 4096 × 2160；连接后可点全屏按钮。多屏模式请使用系统客户端。</p>
    <p v-else-if="mode === 'fullscreen' || mode === 'multimon'" class="rdp-display-hint">分辨率跟随{{ mode === 'multimon' ? '各个' : '所在' }}显示器。</p>
  </div>
</template>

<style scoped>
.rdp-custom-resolution { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 13px; }
.rdp-display-fields .form-field { margin-bottom: 12px; }
.rdp-display-fields > :last-child, .rdp-custom-resolution .form-field { margin-bottom: 0; }
.rdp-display-hint { margin: 0; font-size: 11px; color: var(--muted); }
</style>
