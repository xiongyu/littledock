<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { computed } from 'vue'
import { historyPath } from '../task-manager-history'
import { seriesAreaPath, type SeriesPoint } from '../task-manager'
const props = withDefaults(defineProps<{ points: readonly SeriesPoint[]; secondary?: readonly SeriesPoint[]; label: string; from: number; to: number; selectedAt?: number; max?: number; maximumLabel?: string }>(), { max: 100 })
const emit = defineEmits<{ select: [at: number] }>()
const any = computed(() => props.points.some(point => point.value !== null) || props.secondary?.some(point => point.value !== null))
const single = computed(() => { const valid = props.points.filter(point => point.value !== null); return valid.length === 1 ? valid[0] : undefined })
const singleSecondary = computed(() => { const valid = props.secondary?.filter(point => point.value !== null) ?? []; return valid.length === 1 ? valid[0] : undefined })
function pointX(at: number) { return Math.max(2, Math.min(598, (at - props.from) / Math.max(1, props.to - props.from) * 600)) }
function pointY(value: number | null) { return Math.max(2, Math.min(158, 160 - (value ?? 0) / Math.max(1, props.max) * 160)) }
const selectedX = computed(() => props.selectedAt === undefined ? undefined : Math.max(0, Math.min(600, (props.selectedAt - props.from) / Math.max(1, props.to - props.from) * 600)))
const grid = [...Array.from({ length: 11 }, (_, i) => `M${(i + 1) * 50},0V160`), ...Array.from({ length: 9 }, (_, i) => `M0,${(i + 1) * 16}H600`)].join(' ')
function timeLabel(at: number) {
  const crossDay = new Date(props.from).toDateString() !== new Date(props.to).toDateString()
  return new Date(at).toLocaleString(displayLocale(), { ...(crossDay ? { month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
function select(event: MouseEvent) { const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect(); emit('select', props.from + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (props.to - props.from)) }
</script>
<template>
  <div class="tm-history-chart">
    <header><span>{{ label }}</span><small>{{ maximumLabel ?? '100%' }}</small></header>
    <div class="tm-history-plot" @click="select">
      <svg viewBox="0 0 600 160" preserveAspectRatio="none" role="img" :aria-label="label">
        <path :d="seriesAreaPath(points, from, to, max, 160)" class="series-area"/>
        <path v-if="secondary" :d="seriesAreaPath(secondary, from, to, max, 160)" class="series-area secondary-area"/>
        <path class="grid" :d="grid"/>
        <path :d="historyPath(points, from, to, max)" class="series"/>
        <path v-if="secondary" :d="historyPath(secondary, from, to, max)" class="series second"/>
        <circle v-if="single" :cx="pointX(single.at)" :cy="pointY(single.value)" r="2" fill="var(--tm-chart-line)"/>
        <circle v-if="singleSecondary" :cx="pointX(singleSecondary.at)" :cy="pointY(singleSecondary.value)" r="2" fill="var(--tm-chart-secondary)"/>
        <path v-if="selectedX !== undefined" :d="`M${selectedX},0V160`" class="cursor"/>
      </svg>
      <span v-if="!any">{{ i18nT('meb65fcae2c4c') }}</span>
    </div>
    <footer><time :datetime="new Date(from).toISOString()">{{ timeLabel(from) }}</time><time :datetime="new Date(to).toISOString()">{{ timeLabel(to) }}</time></footer>
  </div>
</template>
<style scoped>
.tm-history-chart{min-width:0}.tm-history-chart header{display:flex;justify-content:space-between;gap:10px;font-size:var(--tm-font-chart, var(--font-body));margin-bottom:7px}.tm-history-chart header small{color:var(--muted);font-size:var(--tm-font-chart, var(--font-body));flex-shrink:0}.tm-history-chart footer{display:flex;justify-content:space-between;gap:8px;margin-top:5px;color:var(--muted);font-size:var(--tm-font-chart, var(--font-body));font-variant-numeric:tabular-nums}.tm-history-plot{position:relative;height:155px;background:var(--tm-chart-surface);border:1px solid var(--tm-chart-border);cursor:crosshair;overflow:hidden}.tm-history-plot svg{width:100%;height:100%;display:block}.grid{stroke:var(--tm-chart-grid);stroke-width:1;fill:none;vector-effect:non-scaling-stroke;shape-rendering:crispEdges;opacity:.8}.series-area{fill:var(--tm-chart-fill);stroke:none}.secondary-area{opacity:.45}.series{fill:none;stroke:var(--tm-chart-line);stroke-width:1;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}.second{stroke:var(--tm-chart-secondary);stroke-dasharray:4 3}.cursor{stroke:var(--tm-chart-line);stroke-width:1;stroke-dasharray:2 4;opacity:.5;vector-effect:non-scaling-stroke}.tm-history-plot>span{position:absolute;inset:0;display:grid;place-items:center;font-size:var(--tm-font-chart, var(--font-body));color:var(--muted);pointer-events:none}@media(max-width:520px){.tm-history-plot{height:125px}}
</style>
