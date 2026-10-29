<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { vResizableColumns } from '../table-columns'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { PhArrowClockwise, PhClockCounterClockwise, PhPlay, PhStop, PhWarningCircle } from '@phosphor-icons/vue'
import { TASK_MANAGER_RECORDING_DEFAULTS, parseTaskManagerHistoryPage, parseTaskManagerHistoryPoint, parseTaskManagerRecordingStatus, type TaskManagerHistoryPage, type TaskManagerHistoryPoint, type TaskManagerRecordingConfig, type TaskManagerRecordingStatus } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
import { formatMemory, formatPercent, formatRate, memoryShare, processKey, usageHeat } from '../task-manager'
import { historyGapReason, historyLocalTime, historyMetric, historyPreset, historyRange, nearestHistoryPoint } from '../task-manager-history'
import TaskManagerHistoryChart from './TaskManagerHistoryChart.vue'
import TaskManagerHistoryHardware from './TaskManagerHistoryHardware.vue'

const props = defineProps<{ active: boolean; targetKey: string; targetLabel: string; monitorId?: string; connected: boolean; capabilities?: string[] }>()
const status = shallowRef<TaskManagerRecordingStatus>(), recordingError = ref(''), historyError = ref(''), pointError = ref('')
const statusBusy = ref(false), configuring = ref(false), queryBusy = ref(false), pointBusy = ref(false), uncertain = ref(false)
const intervalSeconds = ref<TaskManagerRecordingConfig['intervalSeconds']>(5), retentionDays = ref<TaskManagerRecordingConfig['retentionDays']>(7), maxMiB = ref(256)
const initialRange = historyPreset(1), fromText = ref(historyLocalTime(initialRange.from)), toText = ref(historyLocalTime(initialRange.to))
const page = shallowRef<TaskManagerHistoryPage>(), selectedIndex = ref(0), point = shallowRef<TaskManagerHistoryPoint>(), processOrder = ref<'cpu' | 'memory'>('cpu')
let generation = 0, pointGeneration = 0, timer: ReturnType<typeof setTimeout> | undefined, pointTimer: ReturnType<typeof setTimeout> | undefined, disposed = false, initiallyQueried = false, pendingPoint = false, activated = false
const recordingSupported = computed(() => props.capabilities?.includes('recording') === true)
const historySupported = computed(() => props.capabilities?.includes('history') === true)
const canRead = computed(() => !!props.monitorId && props.connected && connectionState.value === 'ready')
const configValid = computed(() => Number.isInteger(maxMiB.value) && maxMiB.value >= 64 && maxMiB.value <= 1024)
const changed = computed(() => !!status.value && (intervalSeconds.value !== status.value.intervalSeconds || retentionDays.value !== status.value.retentionDays || maxMiB.value !== status.value.maxMiB))
const stateLabel = computed(() => !status.value ? i18nT('mc4cf69f358b6') : status.value.enabled && !status.value.running && status.value.state === 'stopped' ? i18nT('m8cee5f0cf54c') : ({ disabled: i18nT('m3cffa9757b69'), starting: i18nT('m087739b986a2'), recording: i18nT('m40291bdda3e7'), stopping: i18nT('maf48159f380f'), stopped: i18nT('mf006455e3baf'), error: i18nT('md58e3730fe66') })[status.value.state])
const selected = computed(() => page.value?.points[selectedIndex.value])
const processes = computed(() => [...(point.value?.processes ?? [])].sort((a, b) => processOrder.value === 'memory' ? b.memoryBytes - a.memoryBytes : (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)))
const cpuSeries = computed(() => page.value ? historyMetric(page.value, value => value.cpuPercent) : [])
const memorySeries = computed(() => page.value ? historyMetric(page.value, value => memoryShare(value.memory.used, value.memory.total)) : [])
const diskRead = computed(() => page.value ? historyMetric(page.value, value => value.disk?.readBytesPerSecond ?? null) : [])
const diskWrite = computed(() => page.value ? historyMetric(page.value, value => value.disk?.writeBytesPerSecond ?? null) : [])
const gpuSeries = computed(() => page.value ? historyMetric(page.value, value => value.gpu?.utilizationPercent ?? null) : [])
const diskMaximum = computed(() => Math.max(1024, ...diskRead.value.map(value => value.value ?? 0), ...diskWrite.value.map(value => value.value ?? 0)))
const hasPartialGpu = computed(() => page.value?.points.some(value => value.gpu?.utilizationScope === 'visible-clients'))
const orderedPointMatches = computed(() => point.value?.id === selected.value?.id)
function timestamp(value?: number) { return value === undefined ? i18nT('m0c3abdcfbfc4') : new Date(value).toLocaleString(displayLocale()) }
function message(cause: unknown) { return cause instanceof Error ? cause.message : i18nT('md8747c22a167') }
function current(token: number) { return !disposed && token === generation }
function syncConfig(value: TaskManagerRecordingConfig) { intervalSeconds.value = value.intervalSeconds; retentionDays.value = value.retentionDays; maxMiB.value = value.maxMiB }
function stopTimer() { clearTimeout(timer); timer = undefined }
function scheduleStatus() { stopTimer(); if (props.active && canRead.value && recordingSupported.value && !disposed) timer = setTimeout(() => void loadStatus(), 5000) }
async function loadStatus() {
  if (!canRead.value || !recordingSupported.value || statusBusy.value || configuring.value) return
  const token = generation, monitorId = props.monitorId
  statusBusy.value = true
  try {
    const result = parseTaskManagerRecordingStatus(await rpc('taskManager.recordingStatus', { monitorId }))
    if (!current(token)) return
    if (status.value && result.revision < status.value.revision) return
    // A status request can finish after the user starts editing the settings.
    const preserveDraft = changed.value
    status.value = result; recordingError.value = ''; uncertain.value = false
    if (!preserveDraft) syncConfig(result)
  } catch (cause) { if (current(token)) recordingError.value = message(cause) }
  finally { if (current(token)) { statusBusy.value = false; scheduleStatus() } }
}
async function configure(enabled: boolean) {
  if (!canRead.value || !recordingSupported.value || !status.value || configuring.value || uncertain.value || enabled && !configValid.value) return
  const token = generation, monitorId = props.monitorId
  const config: TaskManagerRecordingConfig = enabled ? { enabled, intervalSeconds: intervalSeconds.value, retentionDays: retentionDays.value, maxMiB: maxMiB.value } : { enabled, intervalSeconds: status.value.intervalSeconds, retentionDays: status.value.retentionDays, maxMiB: status.value.maxMiB }
  configuring.value = true; recordingError.value = ''; stopTimer()
  try {
    const result = parseTaskManagerRecordingStatus(await rpc('taskManager.configureRecording', { monitorId, config, expectedRevision: status.value.revision }, true))
    if (!current(token)) return
    status.value = result; syncConfig(result)
  } catch (cause) { if (current(token)) { recordingError.value = message(cause); uncertain.value = true } }
  finally {
    if (current(token)) { configuring.value = false; if (uncertain.value) await loadStatus(); else scheduleStatus() }
  }
}
function preset(hours: number) { const range = historyPreset(hours); fromText.value = historyLocalTime(range.from); toText.value = historyLocalTime(range.to) }
async function queryHistory(useCurrentRange = false) {
  if (!canRead.value || !historySupported.value || queryBusy.value) return
  const range = useCurrentRange && page.value ? { from: page.value.from, to: page.value.to } : historyRange(fromText.value, toText.value)
  if (!range) { historyError.value = i18nT('m43eaa4a69ddc'); return }
  const token = generation, monitorId = props.monitorId
  queryBusy.value = true; historyError.value = ''; initiallyQueried = true
  try {
    const result = parseTaskManagerHistoryPage(await rpc('taskManager.queryHistory', { monitorId, query: { ...range, maxPoints: 300 } }))
    if (!current(token)) return
    page.value = result; selectedIndex.value = Math.max(0, result.points.length - 1); point.value = undefined; pointError.value = ''; pointGeneration++; pointBusy.value = false
    if (selected.value) await loadPoint()
  } catch (cause) { if (current(token)) historyError.value = message(cause) }
  finally { if (current(token)) queryBusy.value = false }
}
async function loadPoint() {
  if (!canRead.value || !historySupported.value || !selected.value || !props.active) return
  if (pointBusy.value) { pendingPoint = true; return }
  const token = generation, detailToken = ++pointGeneration, id = selected.value.id, monitorId = props.monitorId
  pointBusy.value = true; point.value = undefined; pointError.value = ''
  try {
    const result = parseTaskManagerHistoryPoint(await rpc('taskManager.historyPoint', { monitorId, id }))
    if (current(token) && detailToken === pointGeneration && selected.value?.id === id && result.id === id) point.value = result
  } catch (cause) { if (current(token) && detailToken === pointGeneration && selected.value?.id === id) pointError.value = message(cause) }
  finally { if (current(token) && detailToken === pointGeneration) { pointBusy.value = false; if (pendingPoint) { pendingPoint = false; void loadPoint() } } }
}
function choose(index: number) { if (!page.value?.points[index]) return; selectedIndex.value = index; point.value = undefined; pointError.value = ''; clearTimeout(pointTimer); pointTimer = setTimeout(() => void loadPoint(), 120) }
function selectTime(at: number) { const index = nearestHistoryPoint(page.value?.points ?? [], at); if (index >= 0) choose(index) }
function reset() {
  generation++; pointGeneration++; stopTimer(); clearTimeout(pointTimer); pendingPoint = false; status.value = undefined; page.value = undefined; point.value = undefined
  recordingError.value = ''; historyError.value = ''; pointError.value = ''; statusBusy.value = false; configuring.value = false; queryBusy.value = false; pointBusy.value = false; uncertain.value = false; initiallyQueried = false; activated = false
  syncConfig(TASK_MANAGER_RECORDING_DEFAULTS); preset(1)
}
watch(() => props.targetKey, reset)
watch(() => props.monitorId, () => { generation++; pointGeneration++; stopTimer(); clearTimeout(pointTimer); pendingPoint = false; statusBusy.value = false; configuring.value = false; queryBusy.value = false; pointBusy.value = false })
watch([() => props.active, canRead, recordingSupported, historySupported, () => props.monitorId], () => {
  stopTimer(); if (!props.active) clearTimeout(pointTimer)
  if (props.active && !activated) { activated = true; preset(1) }
  if (props.active && canRead.value) { void loadStatus(); if (!initiallyQueried && historySupported.value) void queryHistory() }
}, { immediate: true })
watch(connectionState, value => { if (value === 'locked') reset() })
onBeforeUnmount(() => { disposed = true; generation++; pointGeneration++; stopTimer(); clearTimeout(pointTimer) })
</script>

<template>
  <section class="tm-history" :aria-label="i18nT('m6c413a8e0f3c')">
    <p v-if="!canRead" class="tm-history-notice" role="status"><PhWarningCircle :size="18"/>{{ i18nT('ma28b9ca86afe', { p0: (page ? i18nT('mcc09e1d5b1ed') : i18nT('m2be4fb400047')) }) }}</p>
    <p v-if="capabilities && (!recordingSupported || !historySupported)" class="tm-history-notice">{{ i18nT('md278c264a9ac') }}</p>
    <section class="tm-recorder" :aria-label="i18nT('m4a4f23637685')">
      <header><div><PhClockCounterClockwise :size="21"/><h2>{{ i18nT('m6eccd34fa482') }}</h2><span class="tm-recording-badge" :class="{ running: status?.running }">{{ stateLabel }}</span></div><button class="icon-button" :aria-label="i18nT('m81fdd68daf53')" :title="i18nT('m81fdd68daf53')" :disabled="!canRead || !recordingSupported || statusBusy || configuring" @click="loadStatus"><PhArrowClockwise :size="17" :class="{ 'tm-spinning': statusBusy }"/></button></header>
      <div class="tm-recorder-content"><p>{{ i18nT('m12404a0b6381') }}<strong>{{ targetLabel }}</strong>{{ i18nT('mc28bae9276bc') }}</p>
        <div class="tm-recording-settings"><label>{{ i18nT('m4151f2c31172') }}<select v-model="intervalSeconds" :aria-label="i18nT('m159817f4d88d')" :disabled="configuring"><option :value="1">{{ i18nT('m495bd39763c2') }}</option><option :value="2">{{ i18nT('ma20b6f795a49') }}</option><option :value="5">{{ i18nT('m03510755ab30') }}</option><option :value="10">{{ i18nT('m9911a0d84540') }}</option></select></label><label>{{ i18nT('m4133ba1699ed') }}<select v-model="retentionDays" :aria-label="i18nT('mb5ba761fac2f')" :disabled="configuring"><option :value="1">{{ i18nT('m30c21284df4f') }}</option><option :value="7">{{ i18nT('m38eefacbb326') }}</option><option :value="30">{{ i18nT('m84ad2952a308') }}</option></select></label><label>{{ i18nT('m3276c0f65ee8') }}<span class="tm-recording-cap"><input v-model.number="maxMiB" type="number" min="64" max="1024" step="1" :aria-label="i18nT('mace254e9f852')" :disabled="configuring"/>MiB</span></label>
          <button v-if="!status?.enabled || !status.running && status.state !== 'starting'" class="button primary" :disabled="!canRead || !recordingSupported || !status || configuring || uncertain || !configValid" @click="configure(true)"><PhPlay :size="16"/>{{ configuring ? i18nT('m9f7698381edf') : status?.enabled ? i18nT('mcb28019d17df') : i18nT('mc0ea6ab8ed4a') }}</button><button v-else-if="changed" class="button primary" :disabled="!canRead || configuring || uncertain || !configValid" @click="configure(true)">{{ i18nT('mb3ed730e137f') }}</button><button v-if="status?.enabled" class="button" :disabled="!canRead || configuring || uncertain" @click="configure(false)"><PhStop :size="16"/>{{ i18nT('mea7ca190b1ed') }}</button>
        </div>
        <p v-if="!configValid" class="tm-history-error" role="alert">{{ i18nT('m515b8d8ee6ca') }}</p>
        <p class="tm-recording-note">{{ i18nT('mb7380c538c3d') }}</p>
        <div v-if="status" class="tm-recording-facts"><span>{{ i18nT('m017a5a89ff26') }}<strong>{{ timestamp(status.lastSampleAt) }}</strong></span><span>{{ i18nT('m937683da32c1') }}<strong>{{ formatMemory(status.storedBytes) }} / {{ status.maxMiB }} MiB</strong></span><span v-if="status.recorderVersion">{{ i18nT('m7ce3196650ad') }}<strong>{{ status.recorderVersion }}</strong></span><span :title="status.directory">{{ i18nT('m26fa005acb80') }}<code>{{ status.directory }}</code></span></div>
        <p v-if="recordingError || status?.lastError" class="tm-history-error" role="alert">{{ recordingError || status?.lastError }}</p><p v-if="uncertain" class="tm-history-notice">{{ i18nT('m8aeeaa5b3785') }}</p>
      </div>
    </section>

    <section class="tm-history-query" :aria-label="i18nT('m48fa81de6e23')"><header><h2>{{ i18nT('m0714ba5e46a3') }}</h2><span>{{ i18nT('ma272c96ed7c0') }}</span></header><div class="tm-history-presets"><span>{{ i18nT('m9fd7e1ee0db3') }}</span><button v-for="presetValue in [{ hours: 1, label: i18nT('mcf9f068ebfd0') }, { hours: 6, label: i18nT('ma18c5775f1e2') }, { hours: 24, label: i18nT('m7f4bb32751ac') }, { hours: 168, label: i18nT('m2261b06712a3') }]" :key="presetValue.hours" class="button" @click="preset(presetValue.hours)">{{ presetValue.label }}</button></div><div class="tm-history-range"><label>{{ i18nT('md2bb025a2e51') }}<input v-model="fromText" type="datetime-local" step="1" :aria-label="i18nT('m2b1c2b42067e')"/></label><label>{{ i18nT('mc7b24e7997e9') }}<input v-model="toText" type="datetime-local" step="1" :aria-label="i18nT('m469833793560')"/></label><button class="button primary" :disabled="!canRead || !historySupported || queryBusy" @click="queryHistory(false)">{{ queryBusy ? i18nT('m8bbb38569df1') : i18nT('me74d81c0d444') }}</button><button v-if="page" class="button" :disabled="!canRead || queryBusy" @click="queryHistory(true)"><PhArrowClockwise :size="15"/>{{ i18nT('m4536c545fd2a') }}</button></div><p v-if="status?.availableFrom !== undefined" class="tm-recording-note">{{ i18nT('m180b976a0dc9', { p0: (timestamp(status.availableFrom)), p1: (timestamp(status.availableTo)) }) }}</p></section>
    <p v-if="historyError" class="tm-history-error" role="alert">{{ historyError }}<template v-if="page">{{ i18nT('m9a338c8b0096') }}</template></p>
    <div v-if="!page" class="tm-history-empty" role="status">{{ queryBusy ? i18nT('me81d06d4b225') : i18nT('m2887ae186ebe') }}</div>
    <template v-else><div class="tm-history-result-heading"><span>{{ timestamp(page.from) }} — {{ timestamp(page.to) }}</span><strong>{{ i18nT('m24806e62218a', { p0: (page.points.length), p1: (page.totalSamples) }) }}</strong></div><p v-if="page.totalSamples > page.points.length || page.truncated" class="tm-recording-note">{{ i18nT('m6056aaf77033') }}<template v-if="page.truncated">{{ i18nT('ma566ece70ca6') }}</template>{{ i18nT('m8ab541454439') }}</p>
      <div v-if="!page.points.length" class="tm-history-empty" role="status">{{ i18nT('m64788b92174a', { p0: (status?.enabled ? i18nT('m4dd93587ee19') : i18nT('m261d517b5d40')) }) }}</div>
      <template v-else>
        <div class="tm-history-charts"><TaskManagerHistoryChart :points="cpuSeries" :label="i18nT('mb362f40676cd')" :from="page.from" :to="page.to" :selected-at="selected?.sampledAt" @select="selectTime"/><TaskManagerHistoryChart :points="memorySeries" :label="i18nT('m3c1a4132b148')" :from="page.from" :to="page.to" :selected-at="selected?.sampledAt" @select="selectTime"/><TaskManagerHistoryChart :points="diskRead" :secondary="diskWrite" :label="i18nT('m300853f9a878')" :max="diskMaximum" :maximum-label="formatRate(diskMaximum)" :from="page.from" :to="page.to" :selected-at="selected?.sampledAt" @select="selectTime"/><TaskManagerHistoryChart :points="gpuSeries" :label="hasPartialGpu ? i18nT('ma2a6431470ec') : i18nT('m3c5c24fed18d')" :from="page.from" :to="page.to" :selected-at="selected?.sampledAt" @select="selectTime"/></div>
        <p class="tm-recording-note">{{ i18nT('m6fd7d9c62212') }}</p>
        <div class="tm-history-timeline"><span>{{ timestamp(page.from) }}</span><label><span class="visually-hidden">{{ i18nT('m40f8a1bd7e18') }}</span><input type="range" :value="selectedIndex" min="0" :max="page.points.length - 1" step="1" :aria-label="i18nT('m40f8a1bd7e18')" @input="choose(Number(($event.target as HTMLInputElement).value))"/></label><span>{{ timestamp(page.to) }}</span></div>
        <div v-if="selected" class="tm-history-selected"><header><h3>{{ timestamp(selected.sampledAt) }}</h3><span>{{ i18nT('m4296f5f54a84') }}</span></header><div class="tm-history-selected-metrics"><span>CPU <strong>{{ formatPercent(selected.cpuPercent) }}</strong></span><span>{{ i18nT('m7d8f8c37ec78') }}<strong>{{ formatMemory(selected.memory.used) }} / {{ formatMemory(selected.memory.total) }}</strong></span><span>{{ i18nT('me66dec18d7d6') }}<strong>{{ selected.processCount }}</strong></span><span v-if="selected.disk" :title="selected.disk.name">{{ selected.disk.name }}<strong>{{ i18nT('m7c61f543e449', { p0: (formatRate(selected.disk.readBytesPerSecond)), p1: (formatRate(selected.disk.writeBytesPerSecond)) }) }}</strong></span><span v-if="selected.gpu" :title="selected.gpu.name">{{ selected.gpu.name }}<strong>{{ formatPercent(selected.gpu.utilizationPercent) }}<small v-if="selected.gpu.utilizationScope === 'visible-clients'">{{ i18nT('m25b7385612b8') }}</small></strong></span></div>
          <header class="tm-history-process-heading"><h3>{{ i18nT('m6574941fd2a1') }}</h3><label>{{ i18nT('ma96c9a854190') }}<select v-model="processOrder" :aria-label="i18nT('m05716684f268')"><option value="cpu">CPU</option><option value="memory">{{ i18nT('m7d8f8c37ec78') }}</option></select></label><button class="icon-button" :title="i18nT('mf65dee5aca06')" :aria-label="i18nT('mf65dee5aca06')" :disabled="!canRead || pointBusy" @click="loadPoint"><PhArrowClockwise :size="16"/></button></header><p class="tm-recording-note">{{ i18nT('m77fa46f8434d') }}</p>
          <p v-if="pointBusy" class="tm-history-empty" role="status">{{ i18nT('ma648d8ed6a32') }}</p><p v-else-if="pointError" class="tm-history-error" role="alert">{{ pointError }}</p><template v-else-if="orderedPointMatches"><div class="tm-history-process-scroll"><table v-resizable-columns="{ id: 'task-manager.history-processes', widths: [246, 56, 64, 164, 190, 160], minimums: [120, 52, 56, 120, 100, 90], fill: 5 }" class="tm-history-processes"><thead><tr><th>{{ i18nT('md44e9b3d3b31') }}</th><th>PID</th><th>CPU</th><th>{{ i18nT('m7d8f8c37ec78') }}</th><th>{{ i18nT('m14aedaac76f0') }}</th><th>{{ i18nT('m0d0e1a86b3aa') }}</th></tr></thead><tbody><tr v-for="process in processes" :key="processKey(process)"><td :title="process.name">{{ process.name }}</td><td>{{ process.pid }}</td><td :class="'heat-' + usageHeat(process.cpuPercent)">{{ formatPercent(process.cpuPercent) }}</td><td :class="'heat-' + usageHeat(memoryShare(process.memoryBytes, selected.memory.total))">{{ formatMemory(process.memoryBytes) }}<small>{{ formatPercent(memoryShare(process.memoryBytes, selected.memory.total)) }}</small></td><td>{{ timestamp(process.startedAt) }}</td><td>{{ process.username || i18nT('m460b3574e4bd') }}</td></tr></tbody></table></div><p v-if="!processes.length" class="tm-history-empty">{{ i18nT('m51990717a49f') }}</p><p v-if="point?.truncated" class="tm-recording-note">{{ i18nT('meb01e7f2800d') }}</p></template><p v-else class="tm-recording-note">{{ i18nT('m3b3a6c46c563') }}</p><TaskManagerHistoryHardware v-if="point && orderedPointMatches" :key="point.id" :point="point"/>
        </div>
      </template>
      <details v-if="page.gaps.length" class="tm-history-gaps" open><summary>{{ i18nT('meadf29d72233', { p0: (page.gaps.length) }) }}</summary><ul><li v-for="(gap, index) in page.gaps" :key="index"><time>{{ timestamp(gap.from) }} — {{ timestamp(gap.to) }}</time><span>{{ historyGapReason(gap.reason) }}</span></li></ul></details>
    </template>
  </section>
</template>

<style scoped>
.tm-history{display:flex;flex-direction:column;gap:14px;min-width:0}.tm-recorder,.tm-history-query,.tm-history-selected{background:var(--surface);border:1px solid var(--tm-header-border);border-radius:8px;overflow:hidden;min-width:0}.tm-recorder>header,.tm-history-query>header,.tm-history-selected>header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--tm-header);border-bottom:1px solid var(--tm-header-border)}.tm-recorder>header>div{display:flex;align-items:center;gap:9px;flex:1;flex-wrap:wrap}.tm-recorder h2,.tm-history-query h2{font-size:var(--tm-font-process-table, var(--font-body));font-weight:650}.tm-recording-badge{padding:3px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface);font-size:var(--tm-font-caption, var(--font-body))}.tm-recording-badge.running{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--surface));border-color:var(--accent)}.tm-recorder-content{padding:13px 15px;display:flex;flex-direction:column;gap:12px}.tm-recorder-content>p{font-size:var(--tm-font-caption, var(--font-body));line-height:1.7}.tm-recording-settings,.tm-history-range,.tm-history-presets{display:flex;flex-wrap:wrap;align-items:end;gap:10px}.tm-recording-settings label,.tm-history-range label{display:flex;flex-direction:column;gap:5px;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-recording-settings select,.tm-recording-settings input,.tm-history-range input,.tm-history-process-heading select{min-height:34px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--ink);padding:6px 8px;font-size:var(--tm-font-caption, var(--font-body));max-width:100%}.tm-recording-settings select{min-width:95px}.tm-recording-cap{display:flex;align-items:center;gap:6px}.tm-recording-cap input{width:88px}.tm-recording-settings .button,.tm-history-range .button,.tm-history-presets .button{font-size:var(--tm-font-caption, var(--font-body));min-height:34px;padding:6px 10px}.tm-recording-note{font-size:var(--tm-font-caption, var(--font-body))!important;color:var(--muted);line-height:1.7}.tm-recording-facts{display:flex;flex-wrap:wrap;gap:7px 22px;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-recording-facts strong{font-weight:500;color:var(--ink)}.tm-recording-facts>span:last-child{flex-basis:100%;overflow-wrap:anywhere}.tm-recording-facts code{font-size:var(--tm-font-caption, var(--font-body))}.tm-history-error{font-size:var(--tm-font-caption, var(--font-body));line-height:1.8;padding:7px 0;color:light-dark(#9a3434,#f0a6a6);overflow-wrap:anywhere}.tm-history-notice{display:flex;align-items:start;gap:9px;padding:10px 12px;border:1px solid var(--border);background:var(--surface-soft);border-radius:6px;font-size:var(--tm-font-caption, var(--font-body));line-height:1.7}.tm-history-notice>svg{flex-shrink:0;margin-top:2px}.tm-history-query>header>span,.tm-history-selected>header>span{margin-left:auto;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-history-presets,.tm-history-range{padding:12px 14px 0}.tm-history-presets{align-items:center;gap:6px}.tm-history-presets>span{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-right:5px}.tm-history-presets .button{min-height:28px;padding:4px 9px;font-size:var(--tm-font-caption, var(--font-body))}.tm-history-range{padding-bottom:13px}.tm-history-query>.tm-recording-note{padding:0 14px 12px}.tm-history-result-heading{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-history-result-heading strong{font-weight:500;color:var(--ink)}.tm-history-empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:var(--tm-font-caption, var(--font-body));line-height:1.8;background:var(--surface);border:1px dashed var(--border);border-radius:6px}.tm-history-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;background:var(--surface);border:1px solid var(--border);padding:15px;border-radius:7px}.tm-history-timeline{display:flex;align-items:center;gap:12px;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-history-timeline label{flex:1;min-width:60px}.tm-history-timeline input{width:100%;accent-color:var(--accent)}.tm-history-selected h3{font-size:var(--tm-font-process-table, var(--font-body));font-weight:600}.tm-history-selected-metrics{display:flex;gap:15px 26px;flex-wrap:wrap;padding:15px;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-history-selected-metrics strong{display:block;color:var(--ink);font-size:var(--tm-font-process-table, var(--font-body));font-weight:550;margin-top:3px}.tm-history-selected-metrics small{font-size:var(--tm-font-caption, var(--font-body));font-weight:400}.tm-history-selected>header.tm-history-process-heading{background:var(--tm-rail);border-top:1px solid var(--border);padding:7px 14px;gap:9px}.tm-history-process-heading label{display:flex;align-items:center;gap:7px;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-left:auto}.tm-history-process-heading select{min-height:28px;padding:4px 7px}.tm-history-selected>.tm-recording-note,.tm-history-selected>.tm-history-error{padding:8px 14px}.tm-history-process-scroll{overflow:auto;max-height:370px}.tm-history-processes{width:100%;border-collapse:collapse;font-size:var(--tm-font-caption, var(--font-body));white-space:nowrap;text-align:left}.tm-history-processes th{background:var(--tm-header);color:var(--ink);font-weight:600;position:sticky;top:0}.tm-history-processes th,.tm-history-processes td{padding:8px 12px;border-bottom:1px solid var(--border);max-width:260px;overflow:hidden;text-overflow:ellipsis}.tm-history-processes td{font-variant-numeric:tabular-nums}.tm-history-processes td small{font-size:var(--tm-font-caption, var(--font-body));margin-left:10px;opacity:.8}.tm-history-gaps{font-size:var(--tm-font-caption, var(--font-body));border:1px solid var(--border);background:var(--surface);border-radius:6px;padding:10px 13px}.tm-history-gaps summary{cursor:pointer;font-weight:550}.tm-history-gaps ul{list-style:none;margin:9px 0 0;padding:0;max-height:150px;overflow:auto}.tm-history-gaps li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:5px 0;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}@media(max-width:700px){.tm-history-charts{gap:12px;padding:11px}.tm-history-timeline{flex-wrap:wrap;justify-content:space-between}.tm-history-timeline label{order:-1;flex-basis:100%}.tm-history-range label{flex:1;min-width:180px}.tm-history-range input{width:100%}}@media(max-width:520px){.tm-recorder-content{padding:12px}.tm-recording-settings{gap:9px}.tm-recording-settings label{flex:1;min-width:80px}.tm-recording-settings select{min-width:0;width:100%}.tm-recording-settings .button{flex-basis:100%}.tm-history-charts{grid-template-columns:minmax(0,1fr)}.tm-history-range label{flex-basis:100%;min-width:0}.tm-history-range input{min-width:0}.tm-history-range .button{flex:1}.tm-history-query>header,.tm-history-selected>header{flex-wrap:wrap}.tm-history-query>header>span,.tm-history-selected>header>span{margin-left:0}.tm-history-selected-metrics{gap:12px;justify-content:space-between}.tm-history-selected-metrics>span{min-width:40%}.tm-history-selected-metrics strong{font-size:var(--tm-font-process-table, var(--font-body))}.tm-history-result-heading{line-height:1.8}}
</style>
