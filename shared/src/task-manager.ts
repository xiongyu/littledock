/** Task-manager v1: all process identities are scoped to a monitor and target boot. */
export type TaskManagerOS = 'win32' | 'linux' | 'darwin'
export type TaskManagerArch = 'x64' | 'arm64'
export type TaskManagerTarget = { kind: 'local' } | { kind: 'ssh'; serverId: string; connectionId: string }
export interface TaskManagerPlatform { os: TaskManagerOS; arch: TaskManagerArch; hostname: string; home: string; username: string }
export interface TaskManagerHello { version: string; protocol: 1; platform: TaskManagerOS; arch: TaskManagerArch; hostname: string; username: string; home: string; bootId: string; capabilities: string[] }
export interface TaskManagerProcess { pid: number; ppid: number; startedAt: number; name: string; cpuPercent: number | null; memoryBytes: number; username?: string; status?: string; threads?: number; executable?: string }
export interface TaskManagerCommandLine { pid: number; startedAt: number; commandLine: string | null; truncated: boolean; unavailable?: 'permission' | 'unavailable' }
export function parseTaskManagerCommandLine(value: unknown): TaskManagerCommandLine {
  const data = object(value)
  if (data.unavailable !== undefined && data.unavailable !== 'permission' && data.unavailable !== 'unavailable') throw new Error('启动参数状态无效。')
  if ((data.commandLine === null) !== (data.unavailable !== undefined)) throw new Error('启动参数结果不一致。')
  return { pid: number(data.pid, 0x7fffffff, true), startedAt: number(data.startedAt), commandLine: data.commandLine === null ? null : text(data.commandLine, 32768), truncated: bool(data.truncated), ...(data.unavailable === undefined ? {} : { unavailable: data.unavailable }) }
}
export interface TaskManagerDisk { id: string; name: string; readBytesPerSecond: number | null; writeBytesPerSecond: number | null; activePercent: number | null; totalBytes?: number; usedBytes?: number; mount?: string; sampledAt?: number }
export interface TaskManagerGpu { id: string; name: string; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; sharedMemoryUsedBytes?: number | null; sharedMemoryTotalBytes?: number | null; utilizationScope?: 'device' | 'visible-clients'; temperatureCelsius?: number | null; source: string; sampledAt?: number }
export interface TaskManagerPerformance { sampledAt: number; cpuLogical: { id: number; usagePercent: number | null }[]; disks: TaskManagerDisk[]; gpus: TaskManagerGpu[]; unavailable: string[] }
export interface TaskManagerSnapshot { sequence: number; sampledAt: number; bootId: string; hostname: string; platform: TaskManagerOS; arch: TaskManagerArch; cpuPercent: number | null; cpuCount: number; uptimeSeconds: number; memory: { total: number; used: number }; processes: TaskManagerProcess[]; truncated: boolean; capabilities: string[]; performance?: TaskManagerPerformance }
export interface TaskManagerDetails { process: TaskManagerProcess; files: { fd: number; path: string; type: string }[]; connections: { protocol: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string }[]; modules: string[]; threads: { id: number; cpuTime?: number; state?: string }[]; unavailable: string[] }
export interface TaskManagerState {
  id: string; target: TaskManagerTarget; label: string
  phase: 'connecting' | 'host-key' | 'not-installed' | 'installing' | 'starting' | 'ready' | 'error' | 'closed'
  platform?: TaskManagerPlatform; collectorVersion?: string; installPath?: string; message?: string; progress?: string
  hostKey?: { fingerprint: string; changed: boolean; previous: string; host: string; port: number }
}
export interface TaskManagerActionPlan { id: string; monitorId: string; target: TaskManagerTarget; label: string; process: Pick<TaskManagerProcess, 'pid' | 'startedAt' | 'name'>; force: boolean; expiresAt: number }
export interface TaskManagerActionResult { status: 'exited' | 'pending' | 'already-exited'; pid: number; startedAt: number; message?: string }
export const TASK_MANAGER_PROTOCOL = 1
export const TASK_MANAGER_LIMITS = { processes: 10_000, details: 200, messageBytes: 2 * 1024 * 1024, requestBytes: 256 * 1024, intervalMs: 1000, historyPoints: 300, logicalProcessors: 4096, disks: 64, gpus: 16 } as const

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务管理器数据格式不正确。'); return value as Record<string, unknown> }
function text(value: unknown, max = 4096, empty = true): string { if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || value.includes('\0')) throw new Error('任务管理器文本无效。'); return value }
function number(value: unknown, max = Number.MAX_SAFE_INTEGER, integer = false): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new Error('任务管理器数值无效。'); return value }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error('任务管理器记录超出范围。'); return value }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('任务管理器状态无效。'); return value }
function cpu(value: unknown): number | null { return value === null ? null : number(value, 100) }
function os(value: unknown): TaskManagerOS { if (value !== 'win32' && value !== 'linux' && value !== 'darwin') throw new Error('不支持的采集目标系统。'); return value }
function arch(value: unknown): TaskManagerArch { if (value !== 'x64' && value !== 'arm64') throw new Error('不支持的采集目标架构。'); return value }
function capabilities(value: unknown): string[] { return list(value, 64).map(item => text(item, 100, false)) }
function nullableNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null { return value === null ? null : number(value, max) }
function temperature(value: unknown): number | null { if (value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 250) throw new Error('GPU 温度统计无效。'); return value }
function optionalTime(data: Record<string, unknown>): { sampledAt?: number } { return data.sampledAt === undefined ? {} : { sampledAt: number(data.sampledAt, Number.MAX_SAFE_INTEGER, true) } }
function uniqueIds<T extends { id: number | string }>(rows: T[]): T[] { if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('性能快照包含重复设备标识。'); return rows }
export function parseTaskManagerPerformance(value: unknown): TaskManagerPerformance {
  const data = object(value)
  const cpuLogical = uniqueIds(list(data.cpuLogical, TASK_MANAGER_LIMITS.logicalProcessors).map(value => { const row = object(value); return { id: number(row.id, 65535, true), usagePercent: cpu(row.usagePercent) } }))
  const disks = uniqueIds(list(data.disks, TASK_MANAGER_LIMITS.disks).map(value => {
    const row = object(value), totalBytes = row.totalBytes === undefined ? undefined : number(row.totalBytes), usedBytes = row.usedBytes === undefined ? undefined : number(row.usedBytes)
    if (usedBytes !== undefined && (totalBytes === undefined || usedBytes > totalBytes)) throw new Error('磁盘容量统计无效。')
    return { id: text(row.id, 256, false), name: text(row.name, 256, false), readBytesPerSecond: nullableNumber(row.readBytesPerSecond), writeBytesPerSecond: nullableNumber(row.writeBytesPerSecond), activePercent: cpu(row.activePercent), ...(totalBytes === undefined ? {} : { totalBytes }), ...(usedBytes === undefined ? {} : { usedBytes }), ...(row.mount === undefined ? {} : { mount: text(row.mount, 1024) }), ...optionalTime(row) }
  }))
  const gpus = uniqueIds(list(data.gpus, TASK_MANAGER_LIMITS.gpus).map(value => {
    const row = object(value), memoryUsedBytes = nullableNumber(row.memoryUsedBytes), memoryTotalBytes = nullableNumber(row.memoryTotalBytes)
    if (memoryUsedBytes !== null && memoryTotalBytes !== null && memoryUsedBytes > memoryTotalBytes) throw new Error('GPU 显存统计超出总量。')
    const sharedMemoryUsedBytes = row.sharedMemoryUsedBytes === undefined ? undefined : nullableNumber(row.sharedMemoryUsedBytes), sharedMemoryTotalBytes = row.sharedMemoryTotalBytes === undefined ? undefined : nullableNumber(row.sharedMemoryTotalBytes)
    if (sharedMemoryUsedBytes != null && sharedMemoryTotalBytes != null && sharedMemoryUsedBytes > sharedMemoryTotalBytes) throw new Error('GPU 共享系统内存统计超出上限。')
    const utilizationScope = row.utilizationScope
    if (utilizationScope !== undefined && utilizationScope !== 'device' && utilizationScope !== 'visible-clients') throw new Error('GPU 利用率统计范围无效。')
    return { id: text(row.id, 256, false), name: text(row.name, 256, false), utilizationPercent: cpu(row.utilizationPercent), memoryUsedBytes, memoryTotalBytes, ...(sharedMemoryUsedBytes === undefined ? {} : { sharedMemoryUsedBytes }), ...(sharedMemoryTotalBytes === undefined ? {} : { sharedMemoryTotalBytes }), ...(utilizationScope === undefined ? {} : { utilizationScope: utilizationScope as 'device' | 'visible-clients' }), ...(row.temperatureCelsius === undefined ? {} : { temperatureCelsius: temperature(row.temperatureCelsius) }), source: text(row.source, 100, false), ...optionalTime(row) }
  }))
  return { sampledAt: number(data.sampledAt, Number.MAX_SAFE_INTEGER, true), cpuLogical, disks, gpus, unavailable: list(data.unavailable, 64).map(value => text(value, 500)) }
}
export function parseTaskManagerTarget(value: unknown): TaskManagerTarget {
  const target = object(value)
  if (target.kind === 'local' && Object.keys(target).length === 1) return { kind: 'local' }
  if (target.kind === 'ssh' && Object.keys(target).every(key => ['kind', 'serverId', 'connectionId'].includes(key))) return { kind: 'ssh', serverId: text(target.serverId, 100, false), connectionId: text(target.connectionId, 100, false) }
  throw new Error('请选择本机或已保存的 SSH 入口。')
}
export function parseTaskManagerHello(value: unknown): TaskManagerHello {
  const data = object(value)
  if (data.protocol !== TASK_MANAGER_PROTOCOL) throw new Error('采集器协议不兼容，请更新采集器。')
  return { protocol: 1, version: text(data.version, 60, false), platform: os(data.platform), arch: arch(data.arch), hostname: text(data.hostname, 256), username: text(data.username, 256), home: text(data.home, 4096, false), bootId: text(data.bootId, 256, false), capabilities: capabilities(data.capabilities) }
}
export function parseTaskManagerProcess(value: unknown): TaskManagerProcess {
  const data = object(value)
  return { pid: number(data.pid, 0xffffffff, true), ppid: number(data.ppid, 0xffffffff, true), startedAt: number(data.startedAt), name: text(data.name, 1024), cpuPercent: cpu(data.cpuPercent), memoryBytes: number(data.memoryBytes), ...(data.username === undefined ? {} : { username: text(data.username, 256) }), ...(data.status === undefined ? {} : { status: text(data.status, 100) }), ...(data.threads === undefined ? {} : { threads: number(data.threads, 1_000_000, true) }), ...(data.executable === undefined ? {} : { executable: text(data.executable) }) }
}
export function parseTaskManagerSnapshot(value: unknown): TaskManagerSnapshot {
  const data = object(value), memory = object(data.memory), processes = list(data.processes, TASK_MANAGER_LIMITS.processes).map(parseTaskManagerProcess)
  if (new Set(processes.map(process => process.pid)).size !== processes.length) throw new Error('进程快照包含重复 PID。')
  const total = number(memory.total), used = number(memory.used)
  if (used > total) throw new Error('内存统计超出总量。')
  return { sequence: number(data.sequence, Number.MAX_SAFE_INTEGER, true), sampledAt: number(data.sampledAt), bootId: text(data.bootId, 256, false), hostname: text(data.hostname, 256), platform: os(data.platform), arch: arch(data.arch), cpuPercent: cpu(data.cpuPercent), cpuCount: number(data.cpuCount, 65536, true), uptimeSeconds: number(data.uptimeSeconds), memory: { total, used }, processes, truncated: bool(data.truncated), capabilities: capabilities(data.capabilities), ...(data.performance === undefined ? {} : { performance: parseTaskManagerPerformance(data.performance) }) }
}
export function parseTaskManagerDetails(value: unknown): TaskManagerDetails {
  const data = object(value), max = TASK_MANAGER_LIMITS.details
  return { process: parseTaskManagerProcess(data.process), files: list(data.files, max).map(value => { const row = object(value); return { fd: number(row.fd), path: text(row.path), type: text(row.type, 100) } }), connections: list(data.connections, max).map(value => { const row = object(value); return { protocol: text(row.protocol, 30), localAddress: text(row.localAddress, 256), localPort: number(row.localPort, 65535, true), remoteAddress: text(row.remoteAddress, 256), remotePort: number(row.remotePort, 65535, true), state: text(row.state, 100) } }), modules: list(data.modules, max).map(value => text(value)), threads: list(data.threads, max).map(value => { const row = object(value); return { id: number(row.id, 0xffffffff, true), ...(row.cpuTime === undefined ? {} : { cpuTime: number(row.cpuTime) }), ...(row.state === undefined ? {} : { state: text(row.state, 100) }) } }), unavailable: list(data.unavailable, 64).map(value => text(value, 500)) }
}
export function parseTaskManagerActionResult(value: unknown): TaskManagerActionResult {
  const data = object(value)
  if (data.status !== 'exited' && data.status !== 'pending' && data.status !== 'already-exited') throw new Error('采集器操作结果无效。')
  return { status: data.status, pid: number(data.pid, 0xffffffff, true), startedAt: number(data.startedAt), ...(data.message === undefined ? {} : { message: text(data.message, 500) }) }
}
