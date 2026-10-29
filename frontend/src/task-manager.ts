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
  if (bytes == null) return '不可用'
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
  const name = ({ cpuLogical: '逻辑处理器', 'cpu-logical': '逻辑处理器', disks: '磁盘', gpus: 'GPU', gpu: 'GPU' } as Record<string, string>)[category ?? ''] ?? '部分性能指标'
  const specific: Record<string, string> = {
    'unsupported-id': '部分逻辑处理器编号无法识别，未显示对应数据。', 'duplicate-id': '系统返回了重复的逻辑处理器编号，已省略重复记录。',
    'io-unavailable': '磁盘读写速率暂不可用，其他已提供的指标仍可查看。', 'active-unavailable': '此平台没有提供磁盘活动时间；已提供的读写速率仍可查看。',
    'no-supported-driver': '没有检测到可读取性能指标的 GPU 驱动。', 'no-supported-adapter': '没有检测到支持采集的显示适配器。', 'unsupported-platform': '此平台暂未提供 GPU 性能采集。',
    'dxgi-unavailable': '显示适配器信息不可用。', 'pdh-unavailable': 'Windows GPU 性能计数器不可用。', 'adapter-enumeration-failed': '未能读取显示适配器列表。', 'adapter-description-unavailable': '部分显示适配器信息无法读取。', 'driver-counters-unavailable': 'GPU 驱动未提供可读取的性能计数器。',
    'utilization-warming-up': 'GPU 利用率正在建立采样基线，下一次更新后显示。', 'utilization-unavailable': 'GPU 利用率不可用，其他已提供的指标仍可查看。', 'memory-used-unavailable': '已用专用显存暂不可用。', 'memory-total-unavailable': '专用显存总量暂不可用，无法计算占比。',
    'nvidia-compute-unavailable': 'NVIDIA 计算模式指标暂不可用。', 'nvidia-unavailable': 'NVIDIA 驱动指标暂不可用。', 'nvidia-partial': '仅获取到部分 NVIDIA 适配器指标。', 'nvidia-invalid': 'NVIDIA 驱动返回的设备信息无效，未采用。', 'nvidia-invalid-output': 'NVIDIA 驱动返回的指标无效，未采用。', 'nvidia-output-limit': 'NVIDIA 驱动响应超出读取上限。', 'nvidia-invalid-identity': 'NVIDIA 适配器标识无效，未采用对应指标。', 'nvidia-memory-invalid': 'NVIDIA 显存统计无效，未采用对应指标。', 'amdgpu-partial': '仅获取到部分 AMD 适配器指标。',
    'shared-memory-unavailable': '共享系统内存指标暂不可用，未用主机内存推算。',
    'ioreg-unavailable': 'macOS 驱动信息暂不可用。', 'ioreg-output-limit': 'macOS 驱动响应超出读取上限。', 'ioreg-invalid-output': 'macOS 驱动返回的指标无效，未采用。', 'ioreg-invalid-identity': 'macOS 显示适配器标识无效，未采用对应指标。', 'ioreg-no-supported-driver': 'macOS 驱动未提供支持采集的 GPU 指标。',
    'ioreg-permission-denied': '当前用户没有读取 macOS GPU 驱动信息的权限。', 'ioreg-inventory-unavailable': 'macOS 显示适配器清单暂不可用。', 'ioreg-duplicate-identity': 'macOS 驱动返回了重复适配器标识，已省略重复记录。', 'ioreg-statistics-unavailable': 'macOS 驱动未提供此适配器的性能指标。', 'ioreg-memory-invalid': 'macOS 驱动返回的显存统计无效，未采用对应指标。',
    'intel-visible-clients': 'Intel GPU 利用率只覆盖当前用户可读取的客户端，不代表整个设备。', 'intel-no-visible-clients': '未找到当前用户可读取的 Intel GPU 客户端，无法判断设备是否空闲。', 'intel-engine-counters-unavailable': 'Intel GPU 客户端未提供可读取的引擎计数。', 'intel-warming-up': 'Intel GPU 利用率正在建立采样基线。', 'intel-counter-reset': 'Intel GPU 计数发生重置，正在重新建立采样基线。', 'intel-fdinfo-permission-denied': '部分 Intel GPU 客户端没有读取权限，利用率覆盖不完整。', 'intel-fdinfo-truncated': 'Intel GPU 客户端采样达到上限，利用率覆盖不完整。', 'intel-memory-permission-denied': '当前用户没有读取 Intel GPU 内存统计的权限。', 'intel-memory-query-unavailable': 'Intel GPU 驱动没有提供可读取的设备内存统计。', 'intel-render-node-unavailable': 'Intel GPU 渲染设备不可访问。', 'nvidia-tool-missing': '未找到 NVIDIA 驱动提供的性能查询工具。', 'driver-unavailable': '显示适配器驱动指标不可用。',
    'intel-fdinfo-invalid': 'Intel GPU 客户端计数格式无法识别，未采用对应指标。', 'intel-fdinfo-unavailable': 'Intel GPU 客户端计数目录无法读取。', 'intel-shared-memory-unavailable': 'Intel GPU 驱动未提供可核对的整卡共享内存用量，未汇总进程内存推算。',
  }
  if (condition && specific[condition]) return specific[condition]!
  if (condition === 'truncated') return `${name}超过采集上限，仅显示部分设备。`
  if (condition === 'warming-up' || condition === 'initial-sample') return `${name}正在建立采样基线，下一次更新后显示速率。`
  if (condition === 'permission') return `当前用户没有读取${name}指标所需的权限。`
  if (condition === 'timeout' || condition === 'timed-out') return `${name}采集超时，暂时没有新指标；请核对设备采样时间。`
  if (condition === 'stopped') return `${name}采集已停止。`
  if (condition === 'partial') return `${name}仅完成部分采样，未取得的指标保持不可用。`
  return `${name}在此平台、驱动或当前权限下不可用。`
}

export function gpuSource(source: string): string {
  return ({ 'windows-pdh-dxgi': 'Windows 性能计数器 / 显示适配器', 'nvidia-smi': 'NVIDIA 驱动', 'nvidia-smi-tcc': 'NVIDIA 计算模式驱动', 'nvidia-smi-compute': 'NVIDIA 计算模式驱动', 'amdgpu-sysfs': 'AMD 内核驱动', 'macos-ioreg': 'macOS 驱动信息', 'intel-drm-fdinfo': 'Intel GPU 客户端统计', 'linux-pci': 'Linux 显示适配器清单' } as Record<string, string>)[source] ?? source
}
