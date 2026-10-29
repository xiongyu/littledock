import { parseTaskManagerPerformance, parseTaskManagerProcess, type TaskManagerPerformance, type TaskManagerProcess } from './task-manager.js'

export interface TaskManagerRecordingConfig {
  enabled: boolean
  intervalSeconds: 1 | 2 | 5 | 10
  retentionDays: 1 | 7 | 30
  maxMiB: number
}
export interface TaskManagerRecordingStatus extends TaskManagerRecordingConfig {
  revision: number
  state: 'disabled' | 'starting' | 'recording' | 'stopping' | 'stopped' | 'error'
  running: boolean
  directory: string
  storedBytes: number
  lastSampleAt?: number
  lastError?: string
  availableFrom?: number
  availableTo?: number
  instanceId?: string
  recorderVersion?: string
}
export interface TaskManagerHistoryQuery { from: number; to: number; maxPoints?: number }
export interface TaskManagerHistorySummary {
  id: string
  sequence: number
  sampledAt: number
  bootId: string
  cpuPercent: number | null
  cpuCount: number
  memory: { total: number; used: number }
  processCount: number
  disk: { id: string; name: string; readBytesPerSecond: number | null; writeBytesPerSecond: number | null; activePercent: number | null } | null
  gpu: { id: string; name: string; utilizationPercent: number | null; source: string; utilizationScope?: 'device' | 'visible-clients' } | null
}
export interface TaskManagerHistoryPage {
  from: number
  to: number
  points: TaskManagerHistorySummary[]
  totalSamples: number
  truncated: boolean
  availableFrom?: number
  availableTo?: number
  gaps: { from: number; to: number; reason: string }[]
}
export interface TaskManagerHistoryPoint extends TaskManagerHistorySummary {
  intervalSeconds: 1 | 2 | 5 | 10
  processes: TaskManagerProcess[]
  performance?: TaskManagerPerformance
  truncated: boolean
}
export const TASK_MANAGER_RECORDING_DEFAULTS: TaskManagerRecordingConfig = { enabled: false, intervalSeconds: 5, retentionDays: 7, maxMiB: 256 }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('持续监控数据格式不正确。')
  return value as Record<string, unknown>
}
function numeric(value: unknown, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || integer && !Number.isSafeInteger(value)) throw new Error('持续监控数值无效。')
  return value
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.length || value.includes('\0')) throw new Error('持续监控文本无效。')
  return value
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('持续监控状态无效。'); return value }
function metric(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null { return value === null ? null : numeric(value, max) }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error('历史记录超过读取上限。'); return value }
function time(value: unknown): number { return numeric(value, Number.MAX_SAFE_INTEGER, true) }
function interval(value: unknown): TaskManagerRecordingConfig['intervalSeconds'] {
  if (value !== 1 && value !== 2 && value !== 5 && value !== 10) throw new Error('请选择 1、2、5 或 10 秒采样。')
  return value
}
function config(data: Record<string, unknown>): TaskManagerRecordingConfig {
  const retentionDays = data.retentionDays
  if (retentionDays !== 1 && retentionDays !== 7 && retentionDays !== 30) throw new Error('请选择保留 1、7 或 30 天。')
  const maxMiB = numeric(data.maxMiB, 1024, true)
  if (maxMiB < 64) throw new Error('历史容量须为 64–1024 MiB。')
  return { enabled: bool(data.enabled), intervalSeconds: interval(data.intervalSeconds), retentionDays, maxMiB }
}
function available(data: Record<string, unknown>): { availableFrom?: number; availableTo?: number } {
  const from = data.availableFrom === undefined ? undefined : time(data.availableFrom), to = data.availableTo === undefined ? undefined : time(data.availableTo)
  if (from !== undefined && to !== undefined && to < from) throw new Error('历史可用时间范围无效。')
  return { ...(from === undefined ? {} : { availableFrom: from }), ...(to === undefined ? {} : { availableTo: to }) }
}
export function parseTaskManagerRecordingConfig(value: unknown): TaskManagerRecordingConfig {
  const data = object(value)
  if (Object.keys(data).some(key => !['enabled', 'intervalSeconds', 'retentionDays', 'maxMiB'].includes(key))) throw new Error('持续监控设置包含未知字段。')
  return config(data)
}
export function parseTaskManagerRecordingStatus(value: unknown): TaskManagerRecordingStatus {
  const data = object(value), state = data.state
  if (state !== 'disabled' && state !== 'starting' && state !== 'recording' && state !== 'stopping' && state !== 'stopped' && state !== 'error') throw new Error('持续监控运行状态无效。')
  return { ...config(data), revision: time(data.revision), state, running: bool(data.running), directory: text(data.directory, 4096), storedBytes: numeric(data.storedBytes), ...available(data), ...(data.lastSampleAt === undefined ? {} : { lastSampleAt: time(data.lastSampleAt) }), ...(data.lastError === undefined ? {} : { lastError: text(data.lastError, 2048, true) }), ...(data.instanceId === undefined ? {} : { instanceId: text(data.instanceId, 256) }), ...(data.recorderVersion === undefined ? {} : { recorderVersion: text(data.recorderVersion, 60) }) }
}
export function parseTaskManagerHistoryQuery(value: unknown): TaskManagerHistoryQuery {
  const data = object(value)
  if (Object.keys(data).some(key => !['from', 'to', 'maxPoints'].includes(key))) throw new Error('历史查询包含未知字段。')
  const from = time(data.from), to = time(data.to)
  if (to < from || to - from > 31 * 86400_000) throw new Error('单次历史查询范围不能超过 31 天。')
  const maxPoints = data.maxPoints === undefined ? undefined : numeric(data.maxPoints, 300, true)
  if (maxPoints !== undefined && maxPoints < 1) throw new Error('历史查询点数无效。')
  return { from, to, ...(maxPoints === undefined ? {} : { maxPoints }) }
}
function summary(value: unknown): TaskManagerHistorySummary {
  const data = object(value), memory = object(data.memory), total = numeric(memory.total), used = numeric(memory.used)
  if (used > total) throw new Error('历史内存占用超出总量。')
  let disk: TaskManagerHistorySummary['disk'] = null, gpu: TaskManagerHistorySummary['gpu'] = null
  if (data.disk !== null) {
    const row = object(data.disk)
    disk = { id: text(row.id, 256), name: text(row.name, 256), readBytesPerSecond: metric(row.readBytesPerSecond), writeBytesPerSecond: metric(row.writeBytesPerSecond), activePercent: metric(row.activePercent, 100) }
  }
  if (data.gpu !== null) {
    const row = object(data.gpu), scope = row.utilizationScope
    if (scope !== undefined && scope !== 'device' && scope !== 'visible-clients') throw new Error('历史 GPU 统计范围无效。')
    gpu = { id: text(row.id, 256), name: text(row.name, 256), utilizationPercent: metric(row.utilizationPercent, 100), source: text(row.source, 100), ...(scope === undefined ? {} : { utilizationScope: scope }) }
  }
  return { id: text(data.id, 160), sequence: time(data.sequence), sampledAt: time(data.sampledAt), bootId: text(data.bootId, 256), cpuPercent: metric(data.cpuPercent, 100), cpuCount: numeric(data.cpuCount, 65536, true), memory: { total, used }, processCount: numeric(data.processCount, 1_000_000, true), disk, gpu }
}
export function parseTaskManagerHistoryPage(value: unknown): TaskManagerHistoryPage {
  const data = object(value), range = parseTaskManagerHistoryQuery({ from: data.from, to: data.to }), points = list(data.points, 300).map(summary), totalSamples = numeric(data.totalSamples, Number.MAX_SAFE_INTEGER, true)
  if (points.length > totalSamples || new Set(points.map(point => point.id)).size !== points.length || points.some((point, index) => point.sampledAt < range.from || point.sampledAt > range.to || index > 0 && point.sampledAt < points[index - 1]!.sampledAt)) throw new Error('历史采样标识或时间顺序无效。')
  const gaps = list(data.gaps, 100).map(value => {
    const gap = object(value), from = time(gap.from), to = time(gap.to)
    if (to < from) throw new Error('历史间断范围无效。')
    return { from, to, reason: text(gap.reason, 500) }
  })
  return { from: range.from, to: range.to, points, totalSamples, truncated: bool(data.truncated), gaps, ...available(data) }
}
export function parseTaskManagerHistoryPoint(value: unknown): TaskManagerHistoryPoint {
  const data = object(value), processes = list(data.processes, 40).map(parseTaskManagerProcess)
  if (new Set(processes.map(process => process.pid)).size !== processes.length) throw new Error('历史进程标识重复。')
  return { ...summary(data), intervalSeconds: interval(data.intervalSeconds), processes, truncated: bool(data.truncated), ...(data.performance === undefined ? {} : { performance: parseTaskManagerPerformance(data.performance) }) }
}
