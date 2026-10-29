<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { builtInTerminalThemes, resolveTerminalTheme } from '@webnav/shared'
import { catalogLoaded, connectionState, groups, saveCatalog, saving, servers, terminalThemes } from '../backend'
import TerminalThemePreview from './TerminalThemePreview.vue'

const props = defineProps<{ serverId: string; connectionId: string }>()
const emit = defineEmits<{ manage: [] }>()
const server = computed(() => servers.value.find(item => item.id === props.serverId))
const connection = computed(() => server.value?.connections.find(item => item.id === props.connectionId && ['ssh', 'local'].includes(item.type)))
const baseline = ref(connection.value?.terminalThemeId ?? '')
const selected = ref(baseline.value)
const busy = ref(false), error = ref(''), saved = ref(false)
const dirty = computed(() => selected.value !== baseline.value)
const all = computed(() => [...builtInTerminalThemes, ...terminalThemes.value.themes])
const theme = computed(() => resolveTerminalTheme(terminalThemes.value, selected.value || undefined))
const missingTheme = computed(() => !!selected.value && !all.value.some(item => item.id === selected.value))
const unavailable = computed(() => !catalogLoaded.value || connectionState.value !== 'ready' || !connection.value)
const changedElsewhere = computed(() => !!connection.value && (connection.value.terminalThemeId ?? '') !== baseline.value)

async function save() {
  if (busy.value || saving.value || unavailable.value) return false
  error.value = ''; saved.value = false
  if (changedElsewhere.value) { error.value = '该入口的配色已在其他页面修改，请关闭后重新打开。'; return false }
  if (!dirty.value) return true
  busy.value = true
  const themeId = selected.value
  try {
    // Apply only this entry to the latest catalog, preserving unrelated edits.
    await saveCatalog(groups.value, servers.value.map(item => item.id !== props.serverId ? item : {
      ...item,
      connections: item.connections.map(entry => entry.id !== props.connectionId ? entry : { ...entry, terminalThemeId: themeId || undefined }),
    }))
    baseline.value = themeId; saved.value = true
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败。'
    return false
  } finally { busy.value = false }
}

function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) event.preventDefault() }
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ dirty, save, busy })
</script>

<template>
  <form class="terminal-themes-panel connection-theme-panel" :aria-busy="busy" @submit.prevent="save">
    <div class="theme-toolbar">
      <button type="button" class="button" :disabled="busy" @click="emit('manage')">管理配色方案</button>
      <button class="button primary" :disabled="busy || saving || unavailable || changedElsewhere">{{ busy ? '保存中…' : '保存当前连接配色' }}</button>
    </div>
    <p class="connection-theme-target">{{ server?.name }} · {{ connection?.name }}</p>
    <p class="field-hint">配色按连接入口保存，同一入口的终端一起更新。不同 SSH 可分别选择，保存后立即生效，保留连接和输出。</p>
    <label class="form-field">
      <span>当前连接配色</span>
      <select v-model="selected" aria-label="当前连接配色" :disabled="busy || unavailable">
        <option value="">{{ '跟随全局默认（' + resolveTerminalTheme(terminalThemes).name + '）' }}</option>
        <option v-for="item in all" :key="item.id" :value="item.id">{{ item.name }}</option>
        <option v-if="missingTheme" :value="selected">配色已移除，使用全局默认</option>
      </select>
    </label>
    <div class="theme-presets" aria-label="终端配色方案">
      <button v-for="item in all" :key="item.id" type="button" :class="{ selected: selected === item.id }" :aria-pressed="selected === item.id" :disabled="busy || unavailable" @click="selected = item.id">
        <span class="theme-chip" :style="{ background: item.colors.background, color: item.colors.foreground }">Aa <i :style="{ background: item.colors.green }"></i><i :style="{ background: item.colors.blue }"></i></span>
        <span>{{ item.name }}</span>
      </button>
    </div>
    <TerminalThemePreview :theme="theme" />
    <p v-if="unavailable" class="field-error" role="alert">{{ connection ? '请先恢复服务连接或解锁，再保存配色。' : '该连接入口已不存在，请关闭后重新选择。' }}</p>
    <p v-else-if="changedElsewhere" class="field-error" role="alert">该入口的配色已在其他页面修改，请关闭后重新打开。</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <p v-else-if="saved && !dirty" role="status">已保存到当前连接，终端配色已更新。</p>
  </form>
</template>
