<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { computed } from 'vue'
import { seriesAreaPath, seriesPath, type SeriesPoint } from '../task-manager'
const props = withDefaults(defineProps<{ points: readonly SeriesPoint[]; secondary?: readonly SeriesPoint[]; label: string; max?: number; maximumLabel?: string; compact?: boolean }>(), { max: 100 })
const valid = computed(() => props.points.filter(point => point.value !== null))
const secondaryValid = computed(() => props.secondary?.filter(point => point.value !== null) ?? [])
const hasAny = computed(() => valid.value.length > 0 || secondaryValid.value.length > 0)
const last = computed(() => props.points.at(-1))
const pointY = computed(() => 180 - Math.max(0, Math.min(props.max, valid.value[0]?.value ?? 0)) / Math.max(1, props.max) * 180)
function singlePointX(points: readonly SeriesPoint[], value: SeriesPoint | undefined) { return value && points.length ? Math.max(2, Math.min(598, (value.at - points[0]!.at) / Math.max(1000, points.at(-1)!.at - points[0]!.at) * 600)) : 2 }
const secondaryPointY = computed(() => 180 - Math.max(0, Math.min(props.max, secondaryValid.value[0]?.value ?? 0)) / Math.max(1, props.max) * 180)
const span = computed(() => props.points.length > 1 ? Math.round((props.points.at(-1)!.at - props.points[0]!.at) / 1000) : 0)
const grid = [...Array.from({ length: 11 }, (_, i) => `M${(i + 1) * 50},0V180`), ...Array.from({ length: 9 }, (_, i) => `M0,${(i + 1) * 18}H600`)].join(' ')
function area(points: readonly SeriesPoint[]) {
  const from = points[0]?.at ?? 0
  return seriesAreaPath(points, from, Math.max(from + 1000, points.at(-1)?.at ?? from), props.max)
}
</script>
<template>
  <div class="tm-performance-chart" :class="{ compact }">
    <div v-if="!compact" class="tm-chart-caption"><span>{{ label }}</span><span>{{ maximumLabel ?? '100%' }}</span></div>
    <div class="tm-chart-plot">
      <svg viewBox="0 0 600 180" preserveAspectRatio="none" role="img" :aria-label="label">
        <path :d="area(points)" class="series-area"/>
        <path v-if="secondary" :d="area(secondary)" class="series-area secondary-area"/>
        <path class="grid" :d="grid"/>
        <path :d="seriesPath(points, max)" class="primary-series"/>
        <path v-if="secondary" :d="seriesPath(secondary, max)" class="secondary-series"/>
        <circle v-if="valid.length === 1" :cx="singlePointX(points, valid[0])" :cy="pointY" r="2" class="first-point"/>
        <circle v-if="secondary && secondaryValid.length === 1" :cx="singlePointX(secondary, secondaryValid[0])" :cy="secondaryPointY" r="2" class="secondary-point"/>
      </svg>
      <span v-if="!hasAny" class="tm-chart-pending">{{ last?.value === null ? i18nT('m0833af8a89b5') : i18nT('me8e939f31da7') }}</span>
    </div>
    <div v-if="!compact" class="tm-chart-times"><span>{{ span ? (span >= 60 ? (span / 60).toFixed(1) + i18nT('m40de54344d22') : span + i18nT('m00fe8dda1fd7')) + i18nT('m6044e9f095e0') : i18nT('ma66671cd506a') }}</span><span>{{ i18nT('m58fc58266916', { p0: (points.length) }) }}</span></div>
  </div>
</template>
<style scoped>
.tm-performance-chart{min-width:0}.tm-chart-caption,.tm-chart-times{display:flex;justify-content:space-between;gap:10px;font-size:var(--tm-font-chart, var(--font-body));color:var(--muted)}.tm-chart-caption{margin-bottom:7px}.tm-chart-times{margin-top:6px;font-variant-numeric:tabular-nums}.tm-chart-plot{position:relative;height:220px;background:var(--tm-chart-surface);border:1px solid var(--tm-chart-border);overflow:hidden}.tm-chart-plot svg{width:100%;height:100%;display:block}.grid{stroke:var(--tm-chart-grid);stroke-width:1;fill:none;vector-effect:non-scaling-stroke;shape-rendering:crispEdges;opacity:.8}.series-area{fill:var(--tm-chart-fill);stroke:none}.secondary-area{opacity:.45}.primary-series,.secondary-series{fill:none;stroke:var(--tm-chart-line);stroke-width:1;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}.secondary-series{stroke:var(--tm-chart-secondary);stroke-dasharray:4 3}.first-point{fill:var(--tm-chart-line)}.secondary-point{fill:var(--tm-chart-secondary)}.tm-chart-pending{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:var(--tm-font-chart, var(--font-body))}.compact .tm-chart-plot{height:62px}.compact .grid{opacity:.55}.compact .tm-chart-pending{font-size:var(--tm-font-chart, var(--font-body))}@media(max-width:520px){.tm-chart-plot{height:175px}.compact .tm-chart-plot{height:55px}}
</style>
