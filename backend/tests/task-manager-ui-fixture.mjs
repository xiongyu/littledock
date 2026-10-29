// UI-only fixture: task-manager methods return bounded test data; no collector or real host is contacted.
import { randomUUID } from 'node:crypto'
import { AppError } from '../src/core/errors.ts'
import { automationFixture, waitFor } from './automation-fixture.mjs'
export { waitFor }
export async function taskManagerUiFixture(options = {}) {
  const fixture = await automationFixture(options)
  const monitors = new Map(), plans = new Map(), recordings = new Map(), historyPoints = new Map(), stats = { starts: [], closes: [], installs: 0, applies: 0, snapshots: 0, details: 0, commandLines: 0, recordingStatuses: 0, recordingConfigurations: [], historyQueries: [], historyPoints: 0 }
  let pendingCommand, resolveCommand, commandMode = 'ok', pendingSnapshot, resolveSnapshot, forceApplyError = false, recordingUnknown = false, historyMode = 'full', pendingHistory, resolveHistory, pendingRecordingStatus, resolveRecordingStatus
  const get = id => { const monitor = monitors.get(id); if (!monitor) throw new Error('模拟监控不存在'); return monitor }
  const process = (pid, name, offset = 0) => ({ pid, ppid: pid === 120 ? 0 : 120, startedAt: 1_700_000_000_000 + pid + offset, name, cpuPercent: [63, 22, 7, 3, 2, 1, 1, 1][pid - 120] ?? 0, memoryBytes: ([1.5, 3, 6, 10, .15, .5, .8, .1][pid - 120] ?? .1) * 1024 ** 3, username: 'fixture', status: 'running', threads: 4, executable: `/test/${name}` })
  const recording = id => {
    const monitor = get(id), key = JSON.stringify(monitor.state.target)
    if (!recordings.has(key)) recordings.set(key, { enabled: false, intervalSeconds: 5, retentionDays: 7, maxMiB: 256, revision: 0, state: 'disabled', running: false, directory: `${monitor.state.platform.home}/.webnav/tools/task-manager/recording-v1`, storedBytes: 12 * 1024 ** 2, availableFrom: Date.now() - 7 * 86400_000, availableTo: Date.now(), recorderVersion: '0.3.0' })
    return recordings.get(key)
  }
  const fake = {
    get size() { return [...monitors.values()].filter(monitor => monitor.state.phase !== 'closed').length },
    get sizeRemote() { return [...monitors.values()].filter(monitor => monitor.state.phase !== 'closed' && monitor.state.target.kind === 'ssh').length },
    hasResources() { return this.size > 0 },
    closeOwner(owner) { for (const monitor of monitors.values()) if (monitor.owner === owner) monitor.state.phase = 'closed' },
    async start(owner, target) {
      const id = randomUUID(), local = target.kind === 'local', failure = target.serverId === 'beta'
      const state = { id, target, label: local ? '本机 · UI 测试电脑' : `Fixture ${target.serverId} · fixture@127.0.0.1`, phase: local ? 'ready' : failure ? 'error' : 'host-key', platform: { os: local ? 'win32' : 'linux', arch: 'x64', hostname: local ? 'ui-test' : 'alpha-test', home: local ? 'C:/Users/fixture' : '/home/fixture', username: 'fixture' }, installPath: local ? 'C:/Users/fixture/.webnav/tools' : '/home/fixture/.webnav/tools', ...(failure ? { message: '模拟失败：目标暂时不可用。' } : {}), ...(!local && !failure ? { hostKey: { host: '127.0.0.1', port: 2222, fingerprint: 'SHA256:ui-test-fingerprint', previous: '', changed: false } } : {}) }
      monitors.set(id, { owner, state, sequence: 0, performanceMode: 'full', processes: [process(120, local ? 'node-fixture' : 'alpha-worker'), process(121, local ? 'renderer-fixture' : 'alpha-child'), ...['database-fixture', 'cache-fixture', 'editor-fixture', 'shell-fixture', 'worker-fixture', 'agent-fixture'].map((name, index) => process(index + 122, name))] }); stats.starts.push(id)
      return structuredClone(state)
    },
    status(owner, id) { return structuredClone(get(id).state) },
    hostKeyDecision(owner, id, accept) { const monitor = get(id); monitor.state.phase = accept ? 'not-installed' : 'closed'; delete monitor.state.hostKey; return structuredClone(monitor.state) },
    install(owner, id) { const monitor = get(id); stats.installs++; monitor.state.phase = 'installing'; monitor.state.progress = '正在上传已校验的测试采集器…'; setTimeout(() => { if (monitor.state.phase === 'installing') monitor.state.phase = 'ready' }, 350); return structuredClone(monitor.state) },
    async snapshot(owner, id) {
      const monitor = get(id); stats.snapshots++
      if (monitor.state.phase !== 'ready') throw new Error('采集器尚未连接。')
      const result = { sequence: ++monitor.sequence, sampledAt: Date.now(), bootId: 'ui-boot-' + id, hostname: monitor.state.platform.hostname, platform: monitor.state.platform.os, arch: 'x64', cpuPercent: 54 + (monitor.sequence % 8) * 5, cpuCount: 128, uptimeSeconds: 7200, memory: { total: 16 * 1024 ** 3, used: 12.1 * 1024 ** 3 }, processes: structuredClone(monitor.processes), truncated: false, capabilities: ['processes', 'cpu', 'memory', 'details', 'terminate-force', ...(monitor.recordingUnsupported ? [] : ['recording', 'history']), ...(monitor.state.platform.os === 'linux' ? ['terminate-graceful'] : [])] }
      if (monitor.performanceMode !== 'legacy') result.performance = monitor.performanceMode === 'unsupported' ? { sampledAt: Date.now(), cpuLogical: [], disks: [], gpus: [], unavailable: ['cpu-logical:unsupported', 'disks:permission', 'gpu:unsupported'] } : { sampledAt: Date.now(), cpuLogical: Array.from({ length: 128 }, (_, id) => ({ id, usagePercent: id % 19 === 0 ? null : (id * 17 + monitor.sequence * 9) % 100 })), disks: [{ id: 'disk-0', name: 'NVMe 测试磁盘', readBytesPerSecond: (32 + (monitor.sequence % 9) * 7) * 1024 ** 2, writeBytesPerSecond: (8 + (monitor.sequence % 5) * 4) * 1024 ** 2, activePercent: 62, sampledAt: Date.now() }, { id: 'disk-1', name: '辅助测试磁盘', readBytesPerSecond: null, writeBytesPerSecond: null, activePercent: null }], gpus: [{ id: 'gpu-0', name: '测试 GPU 0', utilizationPercent: 10 + ((42 + monitor.sequence * 7) % 81), memoryUsedBytes: (4 + (monitor.sequence % 7) * .4) * 1024 ** 3, memoryTotalBytes: 12 * 1024 ** 3, temperatureCelsius: 62, source: 'UI fixture', sampledAt: Date.now() }, { id: 'gpu-1', name: '测试 GPU 0', utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, temperatureCelsius: null, source: 'UI fixture' }, { id: 'gpu-intel', name: 'Intel 共享内存测试适配器', utilizationPercent: monitor.intelZero ? 0 : 37.5, utilizationScope: 'visible-clients', memoryUsedBytes: null, memoryTotalBytes: null, sharedMemoryUsedBytes: monitor.intelZero ? 0 : 2 * 1024 ** 3, sharedMemoryTotalBytes: monitor.intelSharedTotal ?? null, source: 'intel-drm-fdinfo', sampledAt: Date.now() }], unavailable: [] }
      if (pendingSnapshot) { const waiting = pendingSnapshot; pendingSnapshot = undefined; await waiting }
      return result
    },
    async commandLine(owner, id, identity) { stats.commandLines++; const process = get(id).processes.find(item => item.pid === identity.pid && item.startedAt === identity.startedAt); if (!process) throw new Error('进程已退出'); const result = { pid: process.pid, startedAt: process.startedAt, commandLine: commandMode === 'permission' ? null : process.name + ' --port=9000 --title="two words 中文"', truncated: false, ...(commandMode === 'permission' ? { unavailable: 'permission' } : {}) }; if (pendingCommand) { const waiting = pendingCommand; pendingCommand = undefined; await waiting }; return result },
    details(owner, id, identity) { stats.details++; const process = get(id).processes.find(item => item.pid === identity.pid && item.startedAt === identity.startedAt); if (!process) throw new Error('进程已退出'); return { process, files: [], connections: [{ protocol: 'tcp', localAddress: '127.0.0.1', localPort: 5151, remoteAddress: '127.0.0.1', remotePort: 5000, state: 'ESTABLISHED' }], modules: ['/test/fixture-module.dll'], threads: [{ id: 501, cpuTime: 4.2, state: 'running' }], unavailable: ['files', 'modules:truncated'] } },
    async recordingStatus(owner, id) { stats.recordingStatuses++; const result = structuredClone(recording(id)); if (pendingRecordingStatus) { const waiting = pendingRecordingStatus; pendingRecordingStatus = undefined; await waiting } return result },
    configureRecording(owner, id, input) {
      const state = recording(id)
      stats.recordingConfigurations.push(structuredClone(input))
      if (input.expectedRevision !== state.revision) throw new Error('持续监控设置已发生变化，请重新核对。')
      Object.assign(state, input.config, { revision: state.revision + 1, state: input.config.enabled ? 'recording' : 'stopped', running: input.config.enabled, ...(input.config.enabled ? { lastSampleAt: Date.now(), instanceId: 'ui-recorder-test' } : {}) })
      if (recordingUnknown) { recordingUnknown = false; throw new Error('持续监控设置结果未知，请核对状态，不要重复提交。') }
      return structuredClone(state)
    },
    async queryHistory(owner, id, query) {
      get(id); stats.historyQueries.push(structuredClone(query))
      if (historyMode === 'error') throw new AppError('HISTORY_CORRUPT', '模拟历史读取失败，记录仍保留在目标机器。')
      const gap = { from: Math.round(query.from + (query.to - query.from) * .38), to: Math.round(query.from + (query.to - query.from) * .47), reason: 'recorder-interrupted' }
      const points = historyMode === 'empty' ? [] : Array.from({ length: 24 }, (_, index) => {
        const sampledAt = Math.round(query.from + (query.to - query.from) * index / 23), pointId = `fixture-history-${sampledAt}`
        const summary = { id: pointId, sequence: index + 1, sampledAt, bootId: 'fixture-history-boot', cpuPercent: index === 0 ? null : 12 + (index * 17 % 76), cpuCount: 128, memory: { total: 16 * 1024 ** 3, used: (4 + (index % 9) * .8) * 1024 ** 3 }, processCount: 53 + index, disk: { id: 'history-disk-0', name: '历史测试 NVMe', readBytesPerSecond: (index % 7) * 11 * 1024 ** 2, writeBytesPerSecond: (index % 5) * 4 * 1024 ** 2, activePercent: index * 3 % 100 }, gpu: { id: 'history-gpu-intel', name: '历史 Intel 测试适配器', utilizationPercent: index * 11 % 100, source: 'intel-drm-fdinfo', utilizationScope: 'visible-clients' } }
        const historicalProcesses = [process(120, 'exited-worker-fixture'), process(121, 'archived-database-fixture'), process(122, 'historical-renderer-fixture')].map(({ username: _username, executable: _executable, ...retained }) => retained)
        const performance = { sampledAt, cpuLogical: Array.from({ length: 128 }, (_, id) => ({ id, usagePercent: id % 19 === 0 ? null : (id * 7 + index * 9) % 100 })), disks: [{ id: 'history-disk-0', name: '历史测试 NVMe', readBytesPerSecond: summary.disk.readBytesPerSecond, writeBytesPerSecond: summary.disk.writeBytesPerSecond, activePercent: summary.disk.activePercent, totalBytes: 1024 ** 4, sampledAt }, { id: 'history-disk-1', name: '历史测试辅助盘', readBytesPerSecond: null, writeBytesPerSecond: null, activePercent: null }], gpus: [{ id: 'history-gpu-dedicated', name: '历史独显测试适配器', utilizationPercent: 0, memoryUsedBytes: 4 * 1024 ** 3, memoryTotalBytes: 12 * 1024 ** 3, source: 'windows-pdh-dxgi', sampledAt }, { id: 'history-gpu-intel', name: '历史 Intel 测试适配器', utilizationPercent: summary.gpu.utilizationPercent, memoryUsedBytes: null, memoryTotalBytes: null, sharedMemoryUsedBytes: 2 * 1024 ** 3, sharedMemoryTotalBytes: null, utilizationScope: 'visible-clients', source: 'intel-drm-fdinfo', sampledAt: sampledAt - 1000 }], unavailable: ['gpu:memory-total-unavailable'] }
        historyPoints.set(pointId, { ...summary, intervalSeconds: 5, processes: historicalProcesses, performance, truncated: true })
        return summary
      }).filter(point => point.sampledAt < gap.from || point.sampledAt > gap.to)
      const result = { from: query.from, to: query.to, points, totalSamples: points.length ? 720 : 0, truncated: false, availableFrom: query.from - 3600_000, availableTo: query.to, gaps: points.length ? [gap] : [] }
      if (pendingHistory) { const waiting = pendingHistory; pendingHistory = undefined; await waiting }
      return result
    },
    historyPoint(owner, id, pointId) { get(id); stats.historyPoints++; const point = historyPoints.get(pointId); if (!point) throw new Error('历史采样已清理。'); return structuredClone(point) },
    prepareAction(owner, id, identity) { const monitor = get(id), process = monitor.processes.find(item => item.pid === identity.pid && item.startedAt === identity.startedAt); const plan = { id: randomUUID(), monitorId: id, target: monitor.state.target, label: monitor.state.label, process: { pid: process.pid, startedAt: process.startedAt, name: process.name }, force: identity.force, expiresAt: Date.now() + 30_000 }; plans.set(plan.id, plan); return plan },
    applyAction(owner, id, planId) { stats.applies++; if (forceApplyError) throw new Error('模拟结果未知，请核对后继续。'); const plan = plans.get(planId), monitor = get(id); monitor.processes = monitor.processes.filter(process => process.pid !== plan.process.pid); return { status: 'exited', pid: plan.process.pid, startedAt: plan.process.startedAt } },
    close(owner, id) { const monitor = monitors.get(id); if (monitor) monitor.state.phase = 'closed'; stats.closes.push(id); return {} },
  }
  const slot = fixture.ctx.plugins.slots.get('taskManager'), previous = slot.bridge.current
  slot.bridge.swap(fake)
  return { ...fixture, sshStats: fixture.stats, commandMode(mode) { commandMode = mode }, delayCommand() { pendingCommand = new Promise(resolve => { resolveCommand = resolve }); return () => { resolveCommand?.(); resolveCommand = undefined } }, stats, monitors, recordings, async close() { slot.bridge.swap(previous); await fixture.close() }, delaySnapshot() { pendingSnapshot = new Promise(resolve => { resolveSnapshot = resolve }); return () => { resolveSnapshot?.(); resolveSnapshot = undefined } }, delayHistory() { pendingHistory = new Promise(resolve => { resolveHistory = resolve }); return () => { resolveHistory?.(); resolveHistory = undefined } }, delayRecordingStatus() { pendingRecordingStatus = new Promise(resolve => { resolveRecordingStatus = resolve }); return () => { resolveRecordingStatus?.(); resolveRecordingStatus = undefined } }, historyMode(mode) { historyMode = mode }, unknownRecordingResult() { recordingUnknown = true }, failApply() { forceApplyError = true }, reusePid(id) { const monitor = get(id); monitor.processes[0] = process(120, 'reused-pid-fixture', 5000) } }
}
