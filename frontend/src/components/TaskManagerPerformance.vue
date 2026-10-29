<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { PhCpu, PhHardDrives, PhMemory, PhGraphicsCard } from '@phosphor-icons/vue'
import type { TaskManagerSnapshot } from '@webnav/shared'
import TaskManagerChart from './TaskManagerChart.vue'
import { appendSeries, formatMemory, formatPercent, formatRate, gpuSource, memoryShare, performanceReason, type MetricPoint, type SeriesPoint } from '../task-manager'

const props = defineProps<{ snapshot: TaskManagerSnapshot; history: readonly MetricPoint[]; category?: 'cpu' | 'memory' | 'disks' | 'gpus' }>()
const category = ref<'cpu' | 'memory' | 'disks' | 'gpus'>(props.category ?? 'cpu'), cpuMode = ref<'overall' | 'logical'>('overall'), cpuPage = ref(0)
const diskId = ref(''), gpuId = ref('')
const performance = computed(() => props.snapshot.performance)
const cores = computed(() => performance.value?.cpuLogical ?? []), disks = computed(() => performance.value?.disks ?? []), gpus = computed(() => performance.value?.gpus ?? [])
const corePages = computed(() => Math.max(1, Math.ceil(cores.value.length / 64)))
const visibleCores = computed(() => cores.value.slice(cpuPage.value * 64, (cpuPage.value + 1) * 64))
const selectedDisk = computed(() => disks.value.find(disk => disk.id === diskId.value) ?? disks.value[0])
const selectedGpu = computed(() => gpus.value.find(gpu => gpu.id === gpuId.value) ?? gpus.value[0])
const hasSharedMemory = computed(() => selectedGpu.value?.sharedMemoryUsedBytes !== undefined || selectedGpu.value?.sharedMemoryTotalBytes !== undefined)
const limitedGpuScope = computed(() => selectedGpu.value?.utilizationScope === 'visible-clients')
function gpuLabel(gpu: { id: string; name: string }) {
  const sameName = gpus.value.filter(item => item.name === gpu.name)
  const suffix = sameName.filter(item => item.id.slice(-12) === gpu.id.slice(-12)).length > 1 ? gpu.id : gpu.id.slice(-12)
  return sameName.length > 1 ? `${gpu.name} · ${suffix}` : gpu.name
}
const series = shallowRef<Record<string, SeriesPoint[]>>({})
const overall = computed(() => props.history.map(point => ({ at: point.at, value: point.cpu })))
const memory = computed(() => props.history.map(point => ({ at: point.at, value: point.memory })))
const maxCpu = computed(() => { const values = overall.value.flatMap(point => point.value === null ? [] : [point.value]); return values.length ? Math.max(...values) : null })
const diskRead = computed(() => series.value['disk-read'] ?? []), diskWrite = computed(() => series.value['disk-write'] ?? [])
const rateMax = computed(() => Math.max(1024, ...diskRead.value.map(point => point.value ?? 0), ...diskWrite.value.map(point => point.value ?? 0)))
const supportedNames = computed(() => ({ cpu: 'CPU', memory: '内存', disks: '磁盘', gpus: 'GPU' })[category.value])
const unavailable = computed(() => performance.value?.unavailable.filter(reason => category.value === 'cpu' ? /^cpu/.test(reason) : reason.startsWith(category.value) || category.value === 'gpus' && reason.startsWith('gpu')).filter(reason => !limitedGpuScope.value || reason !== 'gpu:intel-visible-clients') ?? [])
const navItems = computed(() => [
  { id: 'cpu' as const, name: 'CPU', icon: PhCpu, value: formatPercent(props.snapshot.cpuPercent), detail: `${props.snapshot.cpuCount} 个逻辑处理器` },
  { id: 'memory' as const, name: '内存', icon: PhMemory, value: formatPercent(memoryShare(props.snapshot.memory.used, props.snapshot.memory.total)), detail: `${formatMemory(props.snapshot.memory.used)} / ${formatMemory(props.snapshot.memory.total)}` },
  { id: 'disks' as const, name: '磁盘', icon: PhHardDrives, value: disks.value.length ? `${disks.value.length} 个设备` : '不可用', detail: '读写吞吐与活动时间' },
  { id: 'gpus' as const, name: 'GPU', icon: PhGraphicsCard, value: gpus.value.length ? `${gpus.value.length} 个适配器` : '不可用', detail: '利用率、专用显存与温度' },
])
const selectedSeriesKey = computed(() => category.value === 'cpu' ? `cpu:${cpuMode.value}:${cpuPage.value}` : category.value === 'disks' ? `disk:${selectedDisk.value?.id}` : category.value === 'gpus' ? `gpu:${selectedGpu.value?.id}` : 'memory')
let seriesIdentity = '', bootIdentity = ''
function collect() {
  const boot = props.snapshot.bootId, identity = selectedSeriesKey.value
  if (boot !== bootIdentity || identity !== seriesIdentity) { series.value = {}; bootIdentity = boot; seriesIdentity = identity }
  const at = (category.value === 'gpus' ? selectedGpu.value?.sampledAt : category.value === 'disks' ? selectedDisk.value?.sampledAt : undefined) ?? performance.value?.sampledAt ?? props.snapshot.sampledAt, values: Record<string, number | null> = {}
  if (category.value === 'cpu' && cpuMode.value === 'logical') for (const core of visibleCores.value) values[`cpu:${core.id}`] = core.usagePercent
  if (category.value === 'disks' && selectedDisk.value) { values['disk-read'] = selectedDisk.value.readBytesPerSecond; values['disk-write'] = selectedDisk.value.writeBytesPerSecond; values['disk-active'] = selectedDisk.value.activePercent }
  if (category.value === 'gpus' && selectedGpu.value) {
    values['gpu-use'] = selectedGpu.value.utilizationPercent
    values['gpu-memory'] = selectedGpu.value.memoryUsedBytes === null ? null : memoryShare(selectedGpu.value.memoryUsedBytes, selectedGpu.value.memoryTotalBytes ?? undefined)
    if (hasSharedMemory.value) values['gpu-shared-memory'] = selectedGpu.value.sharedMemoryUsedBytes == null ? null : memoryShare(selectedGpu.value.sharedMemoryUsedBytes, selectedGpu.value.sharedMemoryTotalBytes ?? undefined)
  }
  const next: Record<string, SeriesPoint[]> = {}
  for (const [key, value] of Object.entries(values)) next[key] = appendSeries(series.value[key] ?? [], { at, value }, category.value === 'cpu' ? 120 : 300)
  series.value = next
}
watch(() => props.category, value => { if (value) category.value = value })
watch(corePages, value => { cpuPage.value = Math.min(cpuPage.value, value - 1) })
watch(cores, value => { if (!value.length) { cpuMode.value = 'overall'; cpuPage.value = 0 } })
watch(disks, value => { if (!value.some(disk => disk.id === diskId.value)) diskId.value = value[0]?.id ?? '' }, { immediate: true })
watch(gpus, value => { if (!value.some(gpu => gpu.id === gpuId.value)) gpuId.value = value[0]?.id ?? '' }, { immediate: true })
watch([() => props.snapshot, selectedSeriesKey], collect, { immediate: true })
function duration(seconds: number) { const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60); return `${days ? days + ' 天 ' : ''}${hours} 小时 ${minutes} 分钟` }
</script>

<template>
  <section class="tm-performance" aria-label="性能监控" :data-history-series="Object.keys(series).length">
    <nav class="tm-performance-nav" aria-label="性能分类"><button v-for="item in navItems" :key="item.id" :class="{ active: category === item.id }" :aria-pressed="category === item.id" :aria-label="item.name + ' 性能'" @click="category = item.id"><component :is="item.icon" :size="24"/><span><strong>{{ item.name }}</strong><b>{{ item.value }}</b><small>{{ item.detail }}</small></span></button></nav>
    <div class="tm-performance-main">
      <header class="tm-performance-heading"><div><h2>{{ supportedNames }}</h2><p>{{ snapshot.hostname }} · {{ category === 'cpu' ? '逻辑处理器整体负载' : category === 'memory' ? '目标系统物理内存' : category === 'disks' ? '设备读写吞吐与可用容量' : '设备利用率与专用显存' }}</p></div><div v-if="category === 'cpu'" class="segmented"><button :class="{ active: cpuMode === 'overall' }" :aria-pressed="cpuMode === 'overall'" @click="cpuMode = 'overall'">整机</button><button :class="{ active: cpuMode === 'logical' }" :aria-pressed="cpuMode === 'logical'" :disabled="!cores.length" @click="cpuMode = 'logical'">逻辑处理器</button></div></header>
      <p v-if="!performance" class="tm-performance-notice">当前采集器没有扩展性能数据。重新连接以检测并安装新版采集器；整机 CPU 和内存仍可查看。</p>
      <p v-for="reason in unavailable.slice(0, 1)" :key="reason" class="tm-performance-notice">{{ performanceReason(reason) }}</p>

      <details v-if="unavailable.length > 1" class="tm-performance-notice"><summary>其他指标限制（{{ unavailable.length - 1 }} 项）</summary><p v-for="reason in unavailable.slice(1)" :key="reason">{{ performanceReason(reason) }}</p></details>
      <template v-if="category === 'cpu'">
        <TaskManagerChart v-if="cpuMode === 'overall'" :points="overall" label="整机 CPU 利用率"/>
        <template v-else><div class="tm-core-toolbar"><span>逻辑处理器 {{ cpuPage * 64 + 1 }}–{{ Math.min((cpuPage + 1) * 64, cores.length) }} / {{ cores.length }}</span><span><button class="icon-button" aria-label="上一页逻辑处理器" :disabled="!cpuPage" @click="cpuPage--">‹</button>{{ cpuPage + 1 }} / {{ corePages }}<button class="icon-button" aria-label="下一页逻辑处理器" :disabled="cpuPage + 1 >= corePages" @click="cpuPage++">›</button></span></div><div class="tm-core-grid"><section v-for="core in visibleCores" :key="core.id" class="tm-core"><header><span>CPU {{ core.id }}</span><strong>{{ formatPercent(core.usagePercent) }}</strong></header><TaskManagerChart :points="series['cpu:' + core.id] ?? []" :label="'CPU ' + core.id + ' 利用率'" compact/></section></div><p class="tm-performance-footnote">每页最多 64 个逻辑处理器，曲线从切换到此页开始记录，每个保留最近 120 个样本。</p></template>
        <dl class="tm-performance-facts"><div><dt>利用率</dt><dd>{{ formatPercent(snapshot.cpuPercent) }}</dd></div><div><dt>当前曲线峰值</dt><dd>{{ formatPercent(maxCpu) }}</dd></div><div><dt>逻辑处理器</dt><dd>{{ snapshot.cpuCount }}</dd></div><div><dt>当前进程</dt><dd>{{ snapshot.processes.length }}</dd></div><div><dt>运行时间</dt><dd>{{ duration(snapshot.uptimeSeconds) }}</dd></div></dl>
      </template>
      <template v-else-if="category === 'memory'">
        <TaskManagerChart :points="memory" label="物理内存使用率"/>
        <div class="tm-memory-composition" role="img" :aria-label="'已用物理内存 ' + formatPercent(memoryShare(snapshot.memory.used, snapshot.memory.total))"><span :style="{ width: (memoryShare(snapshot.memory.used, snapshot.memory.total) ?? 0) + '%' }"></span></div>
        <dl class="tm-performance-facts"><div><dt>正在使用</dt><dd>{{ formatMemory(snapshot.memory.used) }}</dd></div><div><dt>剩余容量</dt><dd>{{ formatMemory(Math.max(0, snapshot.memory.total - snapshot.memory.used)) }}</dd></div><div><dt>物理内存总量</dt><dd>{{ formatMemory(snapshot.memory.total) }}</dd></div><div><dt>使用率</dt><dd>{{ formatPercent(memoryShare(snapshot.memory.used, snapshot.memory.total)) }}</dd></div></dl><p class="tm-performance-footnote">已用内存采用目标平台的系统统计；进程列使用工作集 / RSS，共享页面可能重复计入不同进程，不能直接相加作为整机已用内存。</p>
      </template>
      <template v-else-if="category === 'disks' && selectedDisk">
        <label class="tm-device-select"><span>磁盘设备</span><select v-model="diskId" aria-label="磁盘设备"><option v-for="disk in disks" :key="disk.id" :value="disk.id">{{ disk.name }}{{ disk.mount ? ' · ' + disk.mount : '' }}</option></select></label>
        <TaskManagerChart :points="diskRead" :secondary="diskWrite" :max="rateMax" :maximum-label="formatRate(rateMax)" label="磁盘读写速率"/>
        <p class="tm-series-legend"><span>━━ 读取 {{ formatRate(selectedDisk.readBytesPerSecond) }}</span><span>┄┄ 写入 {{ formatRate(selectedDisk.writeBytesPerSecond) }}</span></p>
        <dl class="tm-performance-facts"><div><dt>活动时间</dt><dd>{{ formatPercent(selectedDisk.activePercent) }}</dd></div><div><dt>读取速度</dt><dd>{{ formatRate(selectedDisk.readBytesPerSecond) }}</dd></div><div><dt>写入速度</dt><dd>{{ formatRate(selectedDisk.writeBytesPerSecond) }}</dd></div><div><dt>已用 / 总容量</dt><dd class="tm-fact-text">{{ selectedDisk.usedBytes == null ? '不可用' : formatMemory(selectedDisk.usedBytes) }} / {{ selectedDisk.totalBytes == null ? '不可用' : formatMemory(selectedDisk.totalBytes) }}</dd></div><div v-if="selectedDisk.mount"><dt>挂载位置</dt><dd class="tm-fact-text">{{ selectedDisk.mount }}</dd></div></dl><p class="tm-performance-footnote">设备采样 {{ new Date(selectedDisk.sampledAt ?? performance?.sampledAt ?? snapshot.sampledAt).toLocaleTimeString() }}。速率按设备实际计数差计算；空值表示未提供或正在建立采样基线。虚拟设备与物理设备可能重复覆盖同一数据，不合计各设备吞吐。</p>
      </template>
      <template v-else-if="category === 'gpus' && selectedGpu">
        <label class="tm-device-select"><span>GPU / 显示适配器</span><select v-model="gpuId" aria-label="GPU 设备"><option v-for="gpu in gpus" :key="gpu.id" :value="gpu.id">{{ gpuLabel(gpu) }}</option></select></label>
        <p v-if="limitedGpuScope" class="tm-performance-notice tm-gpu-scope" role="note">可访问进程统计 · 覆盖不完整：利用率只包含当前用户可读取的 GPU 客户端，不代表整个设备。</p>
        <div class="tm-gpu-charts" :class="{ 'has-shared': hasSharedMemory }"><TaskManagerChart :points="series['gpu-use'] ?? []" :label="limitedGpuScope ? 'GPU 利用率（可访问进程）' : 'GPU 利用率'"/><TaskManagerChart :points="series['gpu-memory'] ?? []" label="专用显存使用率"/><TaskManagerChart v-if="hasSharedMemory" :points="series['gpu-shared-memory'] ?? []" label="共享系统内存占比"/></div>
        <dl class="tm-performance-facts"><div><dt>利用率</dt><dd>{{ formatPercent(selectedGpu.utilizationPercent) }}</dd></div><div><dt>已用专用显存</dt><dd>{{ selectedGpu.memoryUsedBytes == null ? '不可用' : formatMemory(selectedGpu.memoryUsedBytes) }}</dd></div><div><dt>专用显存总量</dt><dd>{{ selectedGpu.memoryTotalBytes == null ? '不可用' : formatMemory(selectedGpu.memoryTotalBytes) }}</dd></div><div v-if="hasSharedMemory"><dt>已用共享系统内存</dt><dd>{{ selectedGpu.sharedMemoryUsedBytes == null ? '不可用' : formatMemory(selectedGpu.sharedMemoryUsedBytes) }}</dd></div><div v-if="hasSharedMemory"><dt>共享系统内存上限</dt><dd>{{ selectedGpu.sharedMemoryTotalBytes == null ? '不可用' : formatMemory(selectedGpu.sharedMemoryTotalBytes) }}</dd></div><div><dt>温度</dt><dd>{{ selectedGpu.temperatureCelsius == null ? '不可用' : selectedGpu.temperatureCelsius.toFixed(0) + ' °C' }}</dd></div></dl><p class="tm-performance-footnote">数据来源：{{ gpuSource(selectedGpu.source) }} · 采样 {{ new Date(selectedGpu.sampledAt ?? performance?.sampledAt ?? snapshot.sampledAt).toLocaleTimeString() }}。{{ limitedGpuScope ? '利用率仅覆盖可访问进程。' : selectedGpu.source === 'windows-pdh-dxgi' ? '利用率按最繁忙的 GPU 引擎统计。' : '利用率采用驱动提供的统计口径。' }}专用显存包含 GPU 专用的本地显存或预留系统内存。{{ hasSharedMemory ? '共享系统内存另列，不相加；共享上限不是额外的物理内存。' : '未计共享系统内存。' }}未知上限不推算占比，未支持的指标保持不可用。</p>
      </template>
      <div v-else class="tm-performance-empty"><component :is="category === 'gpus' ? PhGraphicsCard : PhHardDrives" :size="36"/><h3>当前没有可显示的{{ supportedNames }}数据</h3><p>{{ performance ? '此平台、驱动或当前用户权限未提供设备指标。已有的进程、CPU 和内存监控不受影响。' : '采集器升级后会根据目标平台和驱动显示可用设备。' }}</p></div>
    </div>
  </section>
</template>

<style scoped>
.tm-performance{display:grid;grid-template-columns:195px minmax(0,1fr);gap:18px;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}.tm-performance-nav{padding:10px;background:var(--tm-rail);border-right:1px solid var(--tm-header-border)}.tm-performance-nav button{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:15px 10px;border:1px solid transparent;border-radius:5px;color:var(--muted);margin-bottom:7px}.tm-performance-nav button.active{background:var(--surface);border-color:var(--accent);box-shadow:inset 3px 0 var(--accent);color:var(--ink)}.tm-performance-nav button:hover{background:var(--hover)}.tm-performance-nav span{display:flex;flex-direction:column;min-width:0;gap:3px}.tm-performance-nav strong{font-size:var(--tm-font-process-table, var(--font-body))}.tm-performance-nav b{font-size:var(--tm-font-heading, var(--font-body));font-weight:600}.tm-performance-nav small{font-size:var(--tm-font-caption, var(--font-body));overflow-wrap:anywhere}.tm-performance-main{min-width:0;padding:20px 22px 17px 0}.tm-performance-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}.tm-performance-heading h2{font-size:var(--tm-font-metric, var(--font-body));font-weight:600;letter-spacing:-.03em}.tm-performance-heading p{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-top:3px}.tm-performance-heading .segmented button{padding:6px 11px;font-size:var(--tm-font-caption, var(--font-body))}.tm-performance-facts{display:flex;flex-wrap:wrap;gap:20px 36px;margin:22px 0 7px}.tm-performance-facts>div{min-width:100px;max-width:100%}.tm-performance-facts dt{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-bottom:4px}.tm-performance-facts dd{margin:0;font-size:var(--tm-font-metric, var(--font-body));font-weight:500;font-variant-numeric:tabular-nums}.tm-performance-facts .tm-fact-text{font-size:var(--tm-font-process-table, var(--font-body));overflow-wrap:anywhere}.tm-performance-footnote{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);line-height:1.8;margin-top:18px}.tm-performance-notice{font-size:var(--tm-font-caption, var(--font-body));padding:10px 12px;background:var(--surface-soft);border-left:3px solid var(--accent);margin:0 0 14px;line-height:1.7}.tm-core-toolbar{display:flex;justify-content:space-between;align-items:center;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-bottom:10px}.tm-core-toolbar>span:last-child{display:flex;align-items:center}.tm-core-toolbar .icon-button{width:28px;height:28px}.tm-core-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:12px;max-height:490px;overflow:auto}.tm-core{min-width:0}.tm-core header{display:flex;justify-content:space-between;font-size:var(--tm-font-caption, var(--font-body));margin-bottom:5px}.tm-core header>span{color:var(--muted)}.tm-core strong{font-weight:600}.tm-device-select{display:flex;align-items:center;gap:12px;margin-bottom:18px;font-size:var(--tm-font-caption, var(--font-body))}.tm-device-select>span{color:var(--muted);flex-shrink:0}.tm-device-select select{background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:5px;padding:7px 10px;max-width:100%;min-width:0;flex:1}.tm-series-legend{display:flex;gap:24px;flex-wrap:wrap;font-size:var(--tm-font-caption, var(--font-body));margin-top:12px}.tm-series-legend>span:first-child{color:var(--accent)}.tm-series-legend>span:last-child{color:var(--metric-memory)}.tm-gpu-charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}.tm-memory-composition{height:24px;margin-top:20px;border:1px solid var(--metric-memory);background:color-mix(in srgb,var(--metric-memory) 10%,var(--surface))}.tm-memory-composition>span{display:block;background:var(--metric-memory);height:100%}.tm-performance-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:45px 20px;gap:13px;color:var(--muted)}.tm-performance-empty h3{color:var(--ink);font-size:var(--tm-font-heading, var(--font-body))}.tm-performance-empty p{font-size:var(--tm-font-caption, var(--font-body));line-height:1.9;max-width:500px}@media(max-width:1000px){.tm-performance{grid-template-columns:155px minmax(0,1fr);gap:14px}.tm-performance-nav button{padding:12px 7px;gap:7px}.tm-performance-nav button>svg{width:19px}.tm-performance-nav b{font-size:var(--tm-font-process-table, var(--font-body))}.tm-performance-main{padding-right:15px}.tm-gpu-charts{grid-template-columns:1fr}.tm-performance-facts{gap:17px 24px}}@media(max-width:650px){.tm-performance{grid-template-columns:1fr;gap:0}.tm-performance-nav{display:grid;grid-template-columns:repeat(4,1fr);border-right:0;border-bottom:1px solid var(--tm-header-border);padding:7px;gap:5px}.tm-performance-nav button{margin:0;padding:8px 5px;justify-content:center;gap:5px}.tm-performance-nav button>svg,.tm-performance-nav small{display:none}.tm-performance-nav b{font-size:var(--tm-font-caption, var(--font-body))}.tm-performance-nav strong{font-size:var(--tm-font-caption, var(--font-body))}.tm-performance-nav button.active{box-shadow:inset 0 -2px var(--accent)}.tm-performance-main{padding:16px 12px}.tm-performance-facts dd{font-size:var(--tm-font-heading, var(--font-body))}.tm-performance-heading{margin-bottom:15px}.tm-core-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tm-performance-facts{gap:16px 22px}.tm-performance-heading h2{font-size:var(--tm-font-metric, var(--font-body))}}
.tm-gpu-charts.has-shared>:first-child{grid-row:span 2}.tm-gpu-charts.has-shared>:first-child :deep(.tm-chart-plot){height:276px}.tm-gpu-charts.has-shared>:not(:first-child) :deep(.tm-chart-plot){height:105px}@media(max-width:1000px){.tm-gpu-charts.has-shared>:first-child{grid-row:auto}.tm-gpu-charts.has-shared>:first-child :deep(.tm-chart-plot),.tm-gpu-charts.has-shared>:not(:first-child) :deep(.tm-chart-plot){height:175px}}
</style>
