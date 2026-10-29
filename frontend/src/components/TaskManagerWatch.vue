<script setup lang="ts">
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
  <section class="tm-watch" aria-label="已勾选进程变化">
    <header><strong>进程观察 <small>{{ items.length }} 项</small></strong><span>{{ paused ? '已暂停' : inactive ? '后台暂停' : '随采样更新' }} · 最近 5 分钟</span></header>
    <div class="tm-watch-grid"><article v-for="item in visible" :key="item.key" :data-process-key="item.key">
      <header><strong :title="item.process.name">{{ item.process.name }}</strong><span>PID {{ item.process.pid }}</span></header>
      <p v-if="!item.latest" class="tm-watch-missing">未采集 · 可能退出或不可访问</p>
      <div class="tm-watch-metrics"><div><span>CPU</span><b>{{ formatPercent(item.latest?.cpuPercent) }}</b><TaskManagerChart :points="item.cpu" :label="item.process.name + ' CPU 变化'" compact /></div><div><span>内存</span><b>{{ item.latest ? formatMemory(item.latest.memoryBytes) : '—' }}</b><TaskManagerChart :points="item.memory" :max="memoryMax(item)" :label="item.process.name + ' 内存变化'" compact /></div></div>
      <footer><span>较勾选时 <strong>{{ delta(item) }}</strong></span><time>{{ new Date(item.sampledAt).toLocaleTimeString() }}</time></footer>
    </article></div>
    <footer><span>CPU 为整机占比；内存为工作集 / RSS。空缺保持断线，PID 复用不替换观察对象。</span><div v-if="pages > 1"><button class="icon-button" aria-label="上一页观察进程" :disabled="page === 0" @click="page--">‹</button>{{ page + 1 }} / {{ pages }}<button class="icon-button" aria-label="下一页观察进程" :disabled="page + 1 >= pages" @click="page++">›</button></div></footer>
  </section>
</template>
