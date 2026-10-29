<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.freeRdp')

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
const label = computed(() => i18nT('me7cbaf94bfdb', { p0: (props.entryNumber) }))
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
    <label class="form-field"><span>{{ i18nT('m8b91a131263f') }}</span>
      <select v-model="mode" :aria-label="i18nT('m944b7388586a', { p0: (label) })">
        <option value="default">{{ browser ? i18nT('mf084a16e0f5b') : i18nT('m17bb25bce60b') }}</option>
        <option value="windowed">{{ i18nT('m04ee16aad8b8') }}</option>
        <option value="fullscreen">{{ i18nT('m96e7161d7c16') }}</option>
        <option value="multimon" :disabled="browser">{{ i18nT('m57d6404c7626', { p0: (browser ? i18nT('me4164510790a') : '') }) }}</option>
      </select>
    </label>
    <template v-if="mode === 'windowed'">
      <label class="form-field"><span>{{ i18nT('mb92421822c21') }}</span>
        <select v-model="resolution" :aria-label="i18nT('m5ca04f2f26b3', { p0: (label) })">
          <option v-for="[w, h] in resolutions" :key="`${w}x${h}`" :value="`${w}x${h}`">{{ w }} × {{ h }}</option>
          <option value="custom">{{ i18nT('m4eafa9e925b3') }}</option>
        </select>
      </label>
      <div v-if="resolution === 'custom'" class="rdp-custom-resolution">
        <label class="form-field"><span>{{ i18nT('m3b730da0ad1a') }}<small>px</small></span><input v-model.number="width" :aria-label="i18nT('m003450a65c61', { p0: (label) })" type="number" min="200" :max="browser ? 4096 : 8192" step="1" required /></label>
        <label class="form-field"><span>{{ i18nT('m968dd036cbb1') }}<small>px</small></span><input v-model.number="height" :aria-label="i18nT('mab25d231af01', { p0: (label) })" type="number" min="200" :max="browser ? 2160 : 8192" step="1" required /></label>
      </div>
    </template>
    <p v-if="browser" class="rdp-display-hint">{{ i18nT('m31cfcf280ca0') }}</p>
    <p v-else-if="mode === 'fullscreen' || mode === 'multimon'" class="rdp-display-hint">{{ i18nT('m0378f35ddc2b', { p0: (mode === 'multimon' ? i18nT('m391187daccde') : i18nT('me9c23189db5a')) }) }}</p>
  </div>
</template>

<style scoped>
.rdp-custom-resolution { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 13px; }
.rdp-display-fields .form-field { margin-bottom: 12px; }
.rdp-display-fields > :last-child, .rdp-custom-resolution .form-field { margin-bottom: 0; }
.rdp-display-hint { margin: 0; font-size: 11px; color: var(--muted); }
</style>
