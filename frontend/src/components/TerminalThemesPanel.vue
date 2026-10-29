<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.terminalThemes')

import { computed, onBeforeUnmount, ref } from 'vue'
import { builtInTerminalThemes, terminalColorKeys, parseTerminalThemes, type TerminalTheme, type TerminalThemeSettings } from '@webnav/shared'
import { terminalThemes, rpc, connectionState } from '../backend'
import TerminalThemePreview from './TerminalThemePreview.vue'
defineProps<{ connectionContext?: boolean }>()
const emit = defineEmits<{ back: [] }>()
const draft = ref<TerminalThemeSettings>(structuredClone(JSON.parse(JSON.stringify(terminalThemes.value))))
const selected = ref(draft.value.defaultId), busy = ref(false), error = ref(''), message = ref('')
const all = computed(() => [...builtInTerminalThemes, ...draft.value.themes])
const theme = computed(() => all.value.find(item => item.id === selected.value) ?? all.value[0]!)
const editable = computed(() => draft.value.themes.some(item => item.id === selected.value))
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const baseline = ref(JSON.stringify(draft.value))
defineExpose({ dirty, save, busy })
const labels: Record<string, string> = { get background() { return i18nT('mf4b669c55756') }, get foreground() { return i18nT('m14b69bd6eeb0') }, get cursor() { return i18nT('m47a75ca0b8fe') }, get selectionBackground() { return i18nT('m627a4f181ce0') }, get black() { return i18nT('m59650f41f74b') }, get red() { return i18nT('m0eb7ee7e38ef') }, get green() { return i18nT('m84b34ffba5aa') }, get yellow() { return i18nT('mc732e4d7e380') }, get blue() { return i18nT('m52f354ecfccb') }, get magenta() { return i18nT('m3d0158cb7cfd') }, get cyan() { return i18nT('mdc06463a46eb') }, get white() { return i18nT('m3366645622a7') }, get brightBlack() { return i18nT('m7a3cba93f471') }, get brightRed() { return i18nT('m0048027d769d') }, get brightGreen() { return i18nT('m91130646a508') }, get brightYellow() { return i18nT('mb2e495b8f3e9') }, get brightBlue() { return i18nT('ma2287e7d598c') }, get brightMagenta() { return i18nT('m27d99bf1d888') }, get brightCyan() { return i18nT('m8da76936a019') }, get brightWhite() { return i18nT('md9596c440b55') } }
function add() {
  if (draft.value.themes.length >= 64) { error.value = i18nT('ma35b5f67b456'); return }
  const copy: TerminalTheme = JSON.parse(JSON.stringify(theme.value))
  copy.id = crypto.randomUUID(); copy.name = i18nT('mfaad413c09ee', { p0: (copy.name.slice(0, 30)) })
  draft.value.themes.push(copy); selected.value = copy.id
}
function remove() {
  const id = selected.value
  draft.value.themes = draft.value.themes.filter(item => item.id !== id)
  if (draft.value.defaultId === id) draft.value.defaultId = 'forest'
  selected.value = draft.value.defaultId
}
async function save() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const saved = await rpc<TerminalThemeSettings>('terminalThemes.save', { settings: parseTerminalThemes(draft.value) }, true)
    terminalThemes.value = saved; draft.value = JSON.parse(JSON.stringify(saved)); baseline.value = JSON.stringify(draft.value)
    message.value = i18nT('m0e49dd54a1f0'); return true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('mcf1487e7aa89') }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault() }
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>
<template>
  <form class="terminal-themes-panel" @submit.prevent="save">
    <div class="theme-toolbar"><button type="button" class="button" @click="emit('back')">{{ connectionContext ? i18nT('connection.back') : i18nT('md00bfe7c685c') }}</button><button class="button primary" :disabled="busy || connectionState !== 'ready'">{{ busy ? i18nT('mff509c9ba052') : i18nT('m0335851b1bc0') }}</button></div>
    <label class="form-field"><span>{{ i18nT('m7f08135823e4') }}</span><select v-model="draft.defaultId"><option v-for="item in all" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <div class="theme-presets" :aria-label="i18nT('mbd7416c03901')"><button v-for="item in all" :key="item.id" type="button" :class="{ selected: selected === item.id }" :aria-pressed="selected === item.id" @click="selected = item.id"><span class="theme-chip" :style="{ background: item.colors.background, color: item.colors.foreground }">Aa <i :style="{ background: item.colors.green }"></i><i :style="{ background: item.colors.blue }"></i></span><span>{{ item.name }}</span></button></div>
    <div class="theme-toolbar"><strong>{{ editable ? i18nT('m91415af8fea3') : i18nT('m5d63c764082f') }}</strong><div><button type="button" class="button" @click="add">{{ i18nT('m7c41cb2374ca') }}</button><button v-if="editable" type="button" class="button danger" @click="remove">{{ i18nT('m2f9daa828907') }}</button></div></div>
    <label v-if="editable" class="form-field"><span>{{ i18nT('m30255f922a29') }}</span><input v-model="theme.name" required maxlength="40" /></label>
    <TerminalThemePreview :theme="theme" />
    <p class="field-hint">{{ editable ? i18nT('m79e4b88a5472') : i18nT('m695a78c111e1') }}</p>
    <div class="terminal-color-grid"><label v-for="key in terminalColorKeys" :key="key"><input v-model="theme.colors[key]" type="color" :aria-label="labels[key]" :disabled="!editable" /><span>{{ labels[key] }}</span><input v-model="theme.colors[key]" :aria-label="i18nT('mef417fa8a333', { p0: (labels[key]) })" pattern="#[0-9a-fA-F]{6}" maxlength="7" :disabled="!editable" /></label></div>
    <p class="field-hint">{{ i18nT('m8e77608957f9') }}</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
  </form>
</template>
