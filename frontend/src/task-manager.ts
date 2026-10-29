
import { pluginI18n } from './i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')
import type { TaskManagerProcess, TaskManagerTarget } from '@webnav/shared'

export function targetKey(target: TaskManagerTarget): string { return target.kind === 'local' ? 'local' : JSON.stringify([target.serverId, target.connectionId]) }
export function processKey(process: Pick<TaskManagerProcess, 'pid' | 'startedAt'>): string { return `${process.pid}:${process.startedAt}` }
export type ProcessSort = 'name' | 'pid' | 'cpuPercent' | 'memoryBytes' | 'username'
export interface ProcessRow { process: TaskManagerProcess; depth: number; children: boolean; missing?: boolean }

/** Keep the selected layout bounded to one snapshot; never attach a reused PID to an old row. */
export function updatePinnedProcessRows(layout: readonly ProcessRow[], processes: readonly TaskManagerProcess[]): ProcessRow[] {
  const current = new Map(processes.map(process => [processKey(process), process]))
  return layout.map(row => {
    const process = current.get(processKey(row.process))
    return { ...row, process: process ?? row.process, missing: !process }
  })
}

/** Tree traversal is iterative and cycle-safe; missing/reused parents become roots. */
export function processRows(processes: readonly TaskManagerProcess[], options: { query: string; tree: boolean; sort: ProcessSort; descending: boolean; collapsed: ReadonlySet<string> }): ProcessRow[] {
  const query = options.query.trim().toLocaleLowerCase()
  const filtered = query ? processes.filter(process => [process.name, process.pid, process.username ?? '', process.executable ?? ''].join(' ').toLocaleLowerCase().includes(query)) : [...processes]
  const compare = (a: TaskManagerProcess, b: TaskManagerProcess) => {
    const av = a[options.sort], bv = b[options.sort]
    // Unavailable CPU stays last in either direction.
    if (av == null || bv == null) return av == null ? bv == null ? a.pid - b.pid : 1 : -1
    const result = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN')
    return (options.descending ? -result : result) || a.pid - b.pid
  }
  if (!options.tree || query) return filtered.sort(compare).map(process => ({ process, depth: 0, children: false }))
  const byPid = new Map(filtered.map(process => [process.pid, process]))
  const children = new Map<number, TaskManagerProcess[]>(), roots: TaskManagerProcess[] = []
  for (const process of filtered) {
    const parent = byPid.get(process.ppid)
    if (!parent || parent.pid === process.pid || parent.startedAt > process.startedAt) roots.push(process)
    else { const items = children.get(parent.pid) ?? []; items.push(process); children.set(parent.pid, items) }
  }
  const result: ProcessRow[] = [], visited = new Set<number>()
  const visit = (items: TaskManagerProcess[]) => {
    const stack = items.sort(compare).reverse().map(process => ({ process, depth: 0 }))
    while (stack.length) {
      const row = stack.pop()!
      if (visited.has(row.process.pid)) continue
      visited.add(row.process.pid)
      const descendants = children.get(row.process.pid) ?? []
      result.push({ ...row, children: descendants.length > 0 })
      if (options.collapsed.has(processKey(row.process))) {
        const hidden = [...descendants]
        while (hidden.length) { const item = hidden.pop()!; if (visited.has(item.pid)) continue; visited.add(item.pid); hidden.push(...(children.get(item.pid) ?? [])) }
      } else for (const process of descendants.sort(compare).reverse()) stack.push({ process, depth: Math.min(row.depth + 1, 32) })
    }
  }
  visit(roots)
  // Malformed parent cycles must neither hang nor hide processes.
  visit(filtered.filter(process => !visited.has(process.pid)))
  return result
}

export interface MetricPoint { at: number; cpu: number | null; memory: number }
export function appendMetric(points: readonly MetricPoint[], point: MetricPoint): MetricPoint[] {
  return [...points.filter(item => item.at < point.at && item.at >= point.at - 300_000), point].slice(-300)
}
export function metricPath(points: readonly MetricPoint[], metric: 'cpu' | 'memory'): string {
  if (!points.length) return ''
  const first = points[0]!.at, duration = Math.max(1000, points.at(-1)!.at - first)
  let drawing = false
  return points.map(point => { const value = point[metric]; if (value === null) { drawing = false; return '' }; const prefix = drawing ? 'L' : 'M'; drawing = true; return `${prefix}${((point.at - first) / duration * 240).toFixed(1)},${(48 - Math.max(0, Math.min(100, value)) / 100 * 44).toFixed(1)}` }).join(' ')
}
export function formatMemory(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB` }
export function formatPercent(value: number | null | undefined): string { return value == null ? '—' : `${value.toFixed(1)}%` }

export type HeatLevel = 'unknown' | 'low' | 'medium' | 'high' | 'critical'
export function usageHeat(percent: number | null | undefined): HeatLevel {
  return percent == null || !Number.isFinite(percent) ? 'unknown' : percent < 10 ? 'low' : percent < 30 ? 'medium' : percent < 60 ? 'high' : 'critical'
}
export function memoryShare(bytes: number, total: number | undefined): number | null { return total && total > 0 ? bytes / total * 100 : null }
export function formatRate(bytes: number | null | undefined): string {
  if (bytes == null) return i18nT('m460b3574e4bd')
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB/s`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB/s`
  return `${(bytes / 1024).toFixed(1)} KiB/s`
}
export interface SeriesPoint { at: number; value: number | null }
export function appendSeries(points: readonly SeriesPoint[], point: SeriesPoint, limit = 300): SeriesPoint[] {
  return [...points.filter(item => item.at < point.at && item.at >= point.at - 300_000), point].slice(-limit)
}
export function seriesPath(points: readonly SeriesPoint[], max = 100, width = 600, height = 180): string {
  if (!points.length) return ''
  const first = points[0]!.at, duration = Math.max(1000, points.at(-1)!.at - first)
  let drawing = false
  return points.map(point => {
    if (point.value === null) { drawing = false; return '' }
    const prefix = drawing ? 'L' : 'M'; drawing = true
    return `${prefix}${((point.at - first) / duration * width).toFixed(1)},${(height - Math.max(0, Math.min(max, point.value)) / Math.max(1, max) * height).toFixed(1)}`
  }).join(' ')
}
/** Close each continuous sample run separately so area fills never bridge gaps. */
export function seriesAreaPath(points: readonly SeriesPoint[], from: number, to: number, max = 100, height = 180): string {
  const parts: string[] = []
  let firstX: string | undefined, lastX = ''
  const close = () => {
    if (firstX !== undefined) parts.push(`L${lastX},${height} L${firstX},${height} Z`)
    firstX = undefined
  }
  for (const point of points) {
    if (point.value === null || point.at < from || point.at > to) { close(); continue }
    const x = ((point.at - from) / Math.max(1, to - from) * 600).toFixed(1)
    const y = (height - Math.max(0, Math.min(max, point.value)) / Math.max(1, max) * height).toFixed(1)
    parts.push(`${firstX === undefined ? 'M' : 'L'}${x},${y}`)
    firstX ??= x
    lastX = x
  }
  close()
  return parts.join(' ')
}
export function performanceReason(reason: string): string {
  const [category, condition] = reason.split(':')
  const name = ({ cpuLogical: i18nT('me6f3fc975d0d'), 'cpu-logical': i18nT('me6f3fc975d0d'), disks: i18nT('mde7b72a3f852'), gpus: 'GPU', gpu: 'GPU' } as Record<string, string>)[category ?? ''] ?? i18nT('m4e06fc7c22f5')
  const specific: Record<string, string> = {
    'unsupported-id': i18nT('m72db78d061de'), 'duplicate-id': i18nT('m0d379802bb04'),
    'io-unavailable': i18nT('m8ee29628b494'), 'active-unavailable': i18nT('m0f127a1460a5'),
    'no-supported-driver': i18nT('m4eeb7dce1634'), 'no-supported-adapter': i18nT('mc69bd0e61de8'), 'unsupported-platform': i18nT('m9029c24e6941'),
    'dxgi-unavailable': i18nT('m8fabc0bcf8d0'), 'pdh-unavailable': i18nT('md6ecfe7a29e6'), 'adapter-enumeration-failed': i18nT('m741019dc7abe'), 'adapter-description-unavailable': i18nT('m0a2da842f18d'), 'driver-counters-unavailable': i18nT('mcc73414c4186'),
    'utilization-warming-up': i18nT('m93c19ca7d9af'), 'utilization-unavailable': i18nT('m021a28fd9505'), 'memory-used-unavailable': i18nT('m8c6e8fdc855f'), 'memory-total-unavailable': i18nT('ma1f2378bcb9f'),
    'nvidia-compute-unavailable': i18nT('mff5079cc5849'), 'nvidia-unavailable': i18nT('m6ecdd29ebc15'), 'nvidia-partial': i18nT('md3aff84f8f86'), 'nvidia-invalid': i18nT('me216523cc6dc'), 'nvidia-invalid-output': i18nT('m33bac03605e3'), 'nvidia-output-limit': i18nT('m6dfa2301cde3'), 'nvidia-invalid-identity': i18nT('md906040b07d9'), 'nvidia-memory-invalid': i18nT('ma627ad1f45ff'), 'amdgpu-partial': i18nT('m0a3276749092'),
    'shared-memory-unavailable': i18nT('mdc0fe47cc315'),
    'ioreg-unavailable': i18nT('m4ab75fee65b0'), 'ioreg-output-limit': i18nT('mb291b73c32f6'), 'ioreg-invalid-output': i18nT('mcd6fed8a692b'), 'ioreg-invalid-identity': i18nT('md843cc5d04e7'), 'ioreg-no-supported-driver': i18nT('mfba6901b5ff6'),
    'ioreg-permission-denied': i18nT('md19ea9cb687a'), 'ioreg-inventory-unavailable': i18nT('m67491f16594f'), 'ioreg-duplicate-identity': i18nT('mfe41532f4036'), 'ioreg-statistics-unavailable': i18nT('m3db21cfc9237'), 'ioreg-memory-invalid': i18nT('m8f819d08226f'),
    'intel-visible-clients': i18nT('m64ca1155cd2a'), 'intel-no-visible-clients': i18nT('md8dd884e6782'), 'intel-engine-counters-unavailable': i18nT('mf4bca1d92f01'), 'intel-warming-up': i18nT('m8515cf252d02'), 'intel-counter-reset': i18nT('ma73ae2ed7149'), 'intel-fdinfo-permission-denied': i18nT('m0be717397943'), 'intel-fdinfo-truncated': i18nT('mbe181d0b0fb2'), 'intel-memory-permission-denied': i18nT('m7624c9658d61'), 'intel-memory-query-unavailable': i18nT('m779689cc799b'), 'intel-render-node-unavailable': i18nT('m189e1a120582'), 'nvidia-tool-missing': i18nT('m48a3a8ca3026'), 'driver-unavailable': i18nT('m994dafae2f8f'),
    'intel-fdinfo-invalid': i18nT('ma9cccaade42f'), 'intel-fdinfo-unavailable': i18nT('m7dfdb4b3f1f0'), 'intel-shared-memory-unavailable': i18nT('m8fb952180f44'),
  }
  if (condition && specific[condition]) return specific[condition]!
  if (condition === 'truncated') return i18nT('mccdde99527e7', { p0: (name) })
  if (condition === 'warming-up' || condition === 'initial-sample') return i18nT('me486f5d0f893', { p0: (name) })
  if (condition === 'permission') return i18nT('mc42da4804b2b', { p0: (name) })
  if (condition === 'timeout' || condition === 'timed-out') return i18nT('md724b1fd0563', { p0: (name) })
  if (condition === 'stopped') return i18nT('m7abe25e1be64', { p0: (name) })
  if (condition === 'partial') return i18nT('mf460a276f008', { p0: (name) })
  return i18nT('m9c8485cca330', { p0: (name) })
}

export function gpuSource(source: string): string {
  return ({ 'windows-pdh-dxgi': i18nT('mef2dc25719d9'), 'nvidia-smi': i18nT('m1635a0fba850'), 'nvidia-smi-tcc': i18nT('m04330d87a24e'), 'nvidia-smi-compute': i18nT('m04330d87a24e'), 'amdgpu-sysfs': i18nT('ma0006ac8e9ff'), 'macos-ioreg': i18nT('m19534232fbe0'), 'intel-drm-fdinfo': i18nT('md715585d9b64'), 'linux-pci': i18nT('m7fdea25a4970') } as Record<string, string>)[source] ?? source
}
