<script setup lang="ts">
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
const labels: Record<string, string> = { background: '背景', foreground: '文字', cursor: '光标', selectionBackground: '选中背景', black: '黑', red: '红', green: '绿', yellow: '黄', blue: '蓝', magenta: '紫', cyan: '青', white: '白', brightBlack: '亮黑', brightRed: '亮红', brightGreen: '亮绿', brightYellow: '亮黄', brightBlue: '亮蓝', brightMagenta: '亮紫', brightCyan: '亮青', brightWhite: '亮白' }
function add() {
  if (draft.value.themes.length >= 64) { error.value = '最多保存 64 个自定义配色。'; return }
  const copy: TerminalTheme = JSON.parse(JSON.stringify(theme.value))
  copy.id = crypto.randomUUID(); copy.name = `${copy.name.slice(0, 30)} · 自定义`
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
    message.value = '已保存，打开的终端已更新。'; return true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败。' }
  finally { busy.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault() }
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>
<template>
  <form class="terminal-themes-panel" @submit.prevent="save">
    <div class="theme-toolbar"><button type="button" class="button" @click="emit('back')">{{ connectionContext ? '返回当前连接' : '返回设置' }}</button><button class="button primary" :disabled="busy || connectionState !== 'ready'">{{ busy ? '保存中…' : '保存配色' }}</button></div>
    <label class="form-field"><span>默认配色</span><select v-model="draft.defaultId"><option v-for="item in all" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <div class="theme-presets" aria-label="终端配色方案"><button v-for="item in all" :key="item.id" type="button" :class="{ selected: selected === item.id }" :aria-pressed="selected === item.id" @click="selected = item.id"><span class="theme-chip" :style="{ background: item.colors.background, color: item.colors.foreground }">Aa <i :style="{ background: item.colors.green }"></i><i :style="{ background: item.colors.blue }"></i></span><span>{{ item.name }}</span></button></div>
    <div class="theme-toolbar"><strong>{{ editable ? '自定义配色' : '内置配色' }}</strong><div><button type="button" class="button" @click="add">新建配色</button><button v-if="editable" type="button" class="button danger" @click="remove">删除</button></div></div>
    <label v-if="editable" class="form-field"><span>配色名称</span><input v-model="theme.name" required maxlength="40" /></label>
    <TerminalThemePreview :theme="theme" />
    <p class="field-hint">{{ editable ? '修改下面的颜色，预览会即时更新。' : '以当前配色为基础新建，即可调整所有颜色。' }}</p>
    <div class="terminal-color-grid"><label v-for="key in terminalColorKeys" :key="key"><input v-model="theme.colors[key]" type="color" :aria-label="labels[key]" :disabled="!editable" /><span>{{ labels[key] }}</span><input v-model="theme.colors[key]" :aria-label="`${labels[key]}色值`" pattern="#[0-9a-fA-F]{6}" maxlength="7" :disabled="!editable" /></label></div>
    <p class="field-hint">SSH 入口可单独选用。删除自定义配色后，引用它的入口自动使用默认配色。</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
  </form>
</template>
