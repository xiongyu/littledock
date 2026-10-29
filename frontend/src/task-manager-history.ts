
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')
import type { TaskManagerHistoryPage, TaskManagerHistorySummary } from '@webnav/shared'
import type { SeriesPoint } from './task-manager'

/** A fixed query range is never advanced by timers or a new incoming sample. */
export function historyPreset(hours: number, now = Date.now()) { return { from: now - hours * 3_600_000, to: now } }
export function historyLocalTime(at: number) {
  const value = new Date(at)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}
export function historyRange(fromText: string, toText: string): { from: number; to: number } | undefined {
  const from = new Date(fromText).getTime(), to = new Date(toText).getTime()
  return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to - from <= 31 * 86_400_000 ? { from, to } : undefined
}
export function historyMetric(page: TaskManagerHistoryPage, read: (point: TaskManagerHistorySummary) => number | null): SeriesPoint[] {
  const values: SeriesPoint[] = page.points.map(point => ({ at: point.sampledAt, value: read(point) }))
  for (const gap of page.gaps) {
    if (gap.to > page.from && gap.from < page.to) values.push({ at: Math.max(page.from, gap.from), value: null }, { at: Math.min(page.to, gap.to), value: null })
  }
  return values.sort((a, b) => a.at - b.at)
}
export function nearestHistoryPoint(points: readonly TaskManagerHistorySummary[], at: number): number {
  if (!points.length) return -1
  let result = 0
  for (let index = 1; index < points.length; index++) if (Math.abs(points[index]!.sampledAt - at) < Math.abs(points[result]!.sampledAt - at)) result = index
  return result
}
export function historyPath(points: readonly SeriesPoint[], from: number, to: number, max: number): string {
  let drawing = false
  return points.map(point => {
    if (point.value === null || point.at < from || point.at > to) { drawing = false; return '' }
    const command = drawing ? 'L' : 'M'; drawing = true
    return `${command}${((point.at - from) / Math.max(1, to - from) * 600).toFixed(1)},${(160 - Math.max(0, Math.min(max, point.value)) / Math.max(1, max) * 160).toFixed(1)}`
  }).join(' ')
}
export function historyGapReason(reason: string) {
  if (reason === 'clock-change') return i18nT('m0d4ce9018e20')
  const conditions: Record<string, string> = { 'capture-failed': i18nT('m6b7b90382164'), 'sampling-delayed': i18nT('m87dea5fab225'), 'recorder-interrupted': i18nT('m98e937801a5d'), 'storage-failed': i18nT('maef807c34a25'), 'history-corrupt': i18nT('ma3c778518864'), 'query-limit': i18nT('m1bdf06b2f7ce'), 'not-recording': i18nT('me2943ac08c3e'), stopped: i18nT('mad5d5fc7795b'), restart: i18nT('m861936b5e1db'), reboot: i18nT('mb21300f80e10'), 'boot-changed': i18nT('mb21300f80e10'), 'missing-samples': i18nT('mfc8ad1c54df9'), 'sampling-gap': i18nT('mfc8ad1c54df9'), 'collection-failed': i18nT('m6b7b90382164'), retained: i18nT('m218e18fb2409'), retention: i18nT('mb9d0f208b4a2'), truncated: i18nT('m1bdf06b2f7ce') }
  return conditions[reason] ?? i18nT('mca9f8371c7be')
}
