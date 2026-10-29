import type { TaskManagerProcess, TaskManagerSnapshot } from '@webnav/shared'
import { appendSeries, processKey, type SeriesPoint } from './task-manager.ts'
export const MAX_WATCHED_PROCESSES = 200
export interface WatchedProcess { key: string; process: TaskManagerProcess; baseline: number; cpu: SeriesPoint[]; memory: SeriesPoint[]; latest?: TaskManagerProcess; sampledAt: number }
export function addWatchedProcess(items: readonly WatchedProcess[], process: TaskManagerProcess, snapshot: TaskManagerSnapshot): WatchedProcess[] {
  if (items.length >= MAX_WATCHED_PROCESSES || items.some(item => item.key === processKey(process)) || process.startedAt <= 0) return [...items]
  return [...items, { key: processKey(process), process, baseline: process.memoryBytes, cpu: [{ at: snapshot.sampledAt, value: process.cpuPercent }], memory: [{ at: snapshot.sampledAt, value: process.memoryBytes }], latest: process, sampledAt: snapshot.sampledAt }]
}
export function updateWatchedProcesses(items: readonly WatchedProcess[], snapshot: TaskManagerSnapshot, interval: number): WatchedProcess[] {
  const live = new Map(snapshot.processes.map(process => [processKey(process), process]))
  return items.map(item => {
    if (snapshot.sampledAt <= item.sampledAt) return item
    const latest = live.get(item.key)
    const append = (points: readonly SeriesPoint[], value: number | null) => {
      const gap = snapshot.sampledAt - item.sampledAt > Math.max(5000, interval * 3)
      return appendSeries(gap ? appendSeries(points, { at: snapshot.sampledAt - 1, value: null }) : points, { at: snapshot.sampledAt, value })
    }
    return { ...item, latest, sampledAt: snapshot.sampledAt, cpu: append(item.cpu, latest?.cpuPercent ?? null), memory: append(item.memory, latest?.memoryBytes ?? null) }
  })
}
