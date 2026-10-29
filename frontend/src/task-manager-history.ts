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
  if (reason === 'clock-change') return '系统时钟发生变化，此处不连接曲线'
  const conditions: Record<string, string> = { 'capture-failed': '未能完成采样', 'sampling-delayed': '采样延迟', 'recorder-interrupted': '记录进程曾中断', 'storage-failed': '记录未能写入存储', 'history-corrupt': '这段历史记录无法读取', 'query-limit': '历史扫描达到读取上限', 'not-recording': '这段时间没有记录', stopped: '记录已停止', restart: '目标或记录进程重新启动', reboot: '目标系统重启', 'boot-changed': '目标系统重启', 'missing-samples': '采样间断', 'sampling-gap': '采样间断', 'collection-failed': '未能完成采样', retained: '较早记录已清理', retention: '记录已按保留设置清理', truncated: '历史扫描达到读取上限' }
  return conditions[reason] ?? '这段时间没有连续采样记录'
}
