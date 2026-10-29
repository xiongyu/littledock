<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { computed, ref, watch } from 'vue'
import type { WatchedProcess } from '../task-manager-watch'
import { formatMemory, formatPercent } from '../task-manager'
import TaskManagerChart from './TaskManagerChart.vue'
const props = defineProps<{ items: readonly WatchedProcess[]; paused: boolean; inactive: boolean }>()
const page = ref(0), pages = computed(() => Math.max(1, Math.ceil(props.items.length / 12)))
const visible = computed(() => props.items.slice(page.value * 12, (page.value + 1) * 12))
watch(pages, value => { page.value = Math.min(page.value, value - 1) })
function delta(item: WatchedProcess) { const value = item.latest ? item.latest.memoryBytes - item.baseline : undefined; return value === undefined ? '—' : (value >= 0 ? '+' : '−') + formatMemory(Math.abs(value)) }
function memoryMax(item: WatchedProcess) { return Math.max(1024 ** 2, ...item.memory.map(point => point.value ?? 0)) * 1.1 }
</script>
<template>
  <section class="tm-watch" :aria-label="i18nT('m3f28825420e6')">
    <header><strong>{{ i18nT('m3ce86f596c53') }}<small>{{ i18nT('m980fda45d8ef', { p0: (items.length) }) }}</small></strong><span>{{ i18nT('m2c7b139b6fa2', { p0: (paused ? i18nT('meb0c326b60ae') : inactive ? i18nT('m760e979308c0') : i18nT('m968657000480')) }) }}</span></header>
    <div class="tm-watch-grid"><article v-for="item in visible" :key="item.key" :data-process-key="item.key">
      <header><strong :title="item.process.name">{{ item.process.name }}</strong><span>PID {{ item.process.pid }}</span></header>
      <p v-if="!item.latest" class="tm-watch-missing">{{ i18nT('m10516f965b5c') }}</p>
      <div class="tm-watch-metrics"><div><span>CPU</span><b>{{ formatPercent(item.latest?.cpuPercent) }}</b><TaskManagerChart :points="item.cpu" :label="item.process.name + i18nT('m61bc32acc722')" compact /></div><div><span>{{ i18nT('m7d8f8c37ec78') }}</span><b>{{ item.latest ? formatMemory(item.latest.memoryBytes) : '—' }}</b><TaskManagerChart :points="item.memory" :max="memoryMax(item)" :label="item.process.name + i18nT('m390114b0787f')" compact /></div></div>
      <footer><span>{{ i18nT('m7b9ad3b2e02e') }}<strong>{{ delta(item) }}</strong></span><time>{{ new Date(item.sampledAt).toLocaleTimeString(displayLocale()) }}</time></footer>
    </article></div>
    <footer><span>{{ i18nT('mae8892226ae4') }}</span><div v-if="pages > 1"><button class="icon-button" :aria-label="i18nT('m521b87036159')" :disabled="page === 0" @click="page--">‹</button>{{ page + 1 }} / {{ pages }}<button class="icon-button" :aria-label="i18nT('m3e1b1cd530f6')" :disabled="page + 1 >= pages" @click="page++">›</button></div></footer>
  </section>
</template>
