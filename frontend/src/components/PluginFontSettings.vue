<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed } from 'vue'
import { PhArrowCounterClockwise } from '@phosphor-icons/vue'
import { registeredFonts, setPluginFontSize, fontStorageError } from '../plugin-fonts'
const props = defineProps<{ pluginId?: string }>()
const fonts = computed(() => registeredFonts.value.filter(font => !props.pluginId || font.pluginId === props.pluginId))
const groups = computed(() => [...new Set(fonts.value.map(font => font.pluginId))].map(id => ({ id, name: fonts.value.find(font => font.pluginId === id)!.pluginName, fonts: fonts.value.filter(font => font.pluginId === id) })))
function change(key: string, event: Event) { const value = Number((event.target as HTMLInputElement).value); setPluginFontSize(key, value) }
</script>
<template>
  <div class="plugin-font-settings">
    <p class="field-hint">{{ i18nT('m4f7caf03e964') }}</p>
    <section v-for="group in groups" :key="group.id" class="font-plugin-card">
      <header><h3>{{ group.name }}</h3><span>{{ i18nT('m42bf56b7bfb2', { p0: (group.fonts.length) }) }}</span></header>
      <div v-for="font in group.fonts" :key="font.key" class="font-setting-row">
        <label :for="`font-${font.key}`"><strong>{{ group.name }} · {{ font.name }}</strong><small>{{ font.group }}</small></label>
        <span class="font-preview" :style="{ fontSize: `${font.size}px` }">{{ i18nT('m42b7f4b2a4b8') }}</span>
        <input :id="`font-${font.key}`" type="range" :min="font.minSize" :max="font.maxSize" step="1" :value="font.size" :aria-label="i18nT('mf936cdeda363', { p0: (group.name), p1: (font.name) })" @input="change(font.key, $event)" />
        <output>{{ font.size }}px</output><button class="icon-button" :aria-label="i18nT('mdc63e5e86cee', { p0: (group.name), p1: (font.name) })" :title="i18nT('m7aa5d86bfdc4')" @click="setPluginFontSize(font.key)"><PhArrowCounterClockwise :size="18" /></button>
      </div>
    </section>
    <p v-if="!fonts.length" class="field-hint">{{ i18nT('m0618d2401492') }}</p>
    <p v-if="fontStorageError" class="field-error" role="alert">{{ fontStorageError }}</p>
  </div>
</template>
<style scoped>
.plugin-font-settings{font-size:var(--font-body)}.font-plugin-card{border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-block:16px;background:var(--surface)}.font-plugin-card header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.font-plugin-card h3{margin:0;font-size:var(--font-heading)}.font-plugin-card header span,.font-setting-row small{color:var(--muted);font-size:var(--font-caption)}.font-setting-row{padding:16px 18px;display:grid;grid-template-columns:minmax(180px,1fr) minmax(160px,1fr) 120px 48px 36px;align-items:center;gap:12px;border-top:1px solid var(--border)}.font-setting-row label{display:grid;gap:5px}.font-preview{overflow-wrap:anywhere}.font-setting-row input{width:100%}.font-setting-row output{font-variant-numeric:tabular-nums}@media(max-width:900px){.font-setting-row{grid-template-columns:1fr 60px 36px}.font-setting-row label,.font-preview{grid-column:1/-1}.font-setting-row input{grid-column:1}}
</style>
