import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_MANAGER_RECORDING_DEFAULTS, parseTaskManagerRecordingConfig, parseTaskManagerRecordingStatus, parseTaskManagerHistoryQuery, parseTaskManagerHistoryPage, parseTaskManagerHistoryPoint } from '@webnav/shared'

const summary = (id = 'point-1', sampledAt = 1000) => ({ id, sequence: 1, sampledAt, bootId: 'past-boot', cpuPercent: 84, cpuCount: 8, memory: { total: 8192, used: 4096 }, processCount: 156, disk: { id: 'disk0', name: 'Disk 0', readBytesPerSecond: 1024, writeBytesPerSecond: null, activePercent: 62 }, gpu: { id: 'intel0', name: 'Intel', utilizationPercent: 0, source: 'intel-drm-fdinfo', utilizationScope: 'visible-clients' } })
const page = () => ({ from: 0, to: 2000, points: [summary()], totalSamples: 20, truncated: true, availableFrom: 200, availableTo: 1500, gaps: [{ from: 200, to: 400, reason: '采集间断' }] })

test('persistent recording settings bound retention, sample cadence, storage and caller-controlled paths', () => {
  assert.deepEqual(parseTaskManagerRecordingConfig(TASK_MANAGER_RECORDING_DEFAULTS), TASK_MANAGER_RECORDING_DEFAULTS)
  for (const update of [{ intervalSeconds: 0 }, { intervalSeconds: 0.1 }, { intervalSeconds: 60 }, { retentionDays: 365 }, { maxMiB: 63 }, { maxMiB: 1025 }, { maxMiB: 256.5 }, { enabled: 'true' }, { directory: '/etc' }, { command: 'anything' }]) assert.throws(() => parseTaskManagerRecordingConfig({ ...TASK_MANAGER_RECORDING_DEFAULTS, ...update }))
  const state = { ...TASK_MANAGER_RECORDING_DEFAULTS, enabled: true, revision: 4, state: 'stopped', running: false, directory: '/home/fixture/.webnav/tools/task-manager/recording-v1', storedBytes: 4096, lastSampleAt: 1000, lastError: '目标记录程序已停止，保留历史可查看。' }
  assert.deepEqual(parseTaskManagerRecordingStatus(state), state, 'desired enabled does not imply running')
  assert.throws(() => parseTaskManagerRecordingStatus({ ...state, storedBytes: Infinity }))
  assert.throws(() => parseTaskManagerRecordingStatus({ ...state, revision: -1 }))
})

test('fixed history queries preserve peak sample identities and reject oversized or inconsistent replies', () => {
  assert.deepEqual(parseTaskManagerHistoryQuery({ from: 0, to: 2000, maxPoints: 300 }), { from: 0, to: 2000, maxPoints: 300 })
  for (const query of [{ from: 1, to: 0 }, { from: 0, to: 32 * 86400_000 }, { from: 0, to: 1, maxPoints: 301 }, { from: 0, to: 1, maxPoints: 0 }, { from: 0, to: 1, path: '../' }]) assert.throws(() => parseTaskManagerHistoryQuery(query))
  assert.deepEqual(parseTaskManagerHistoryPage(page()), page())
  for (const update of [
    { totalSamples: 0 }, { points: [summary(), summary()] },
    { points: [summary('late', 1500), summary('early', 1000)] },
    { points: [summary('outside', 2001)] },
    { points: Array.from({ length: 301 }, (_, i) => summary(String(i), i)), totalSamples: 301 },
    { gaps: [{ from: 400, to: 200, reason: 'bad' }] },
    { points: [{ ...summary(), gpu: { ...summary().gpu, utilizationPercent: 101 } }] },
    { points: [{ ...summary(), disk: { ...summary().disk, readBytesPerSecond: -1 } }] },
  ]) assert.throws(() => parseTaskManagerHistoryPage({ ...page(), ...update }))
})

test('historical high-usage processes retain their original boot and creation identity with a hard detail bound', () => {
  const process = { pid: 42, ppid: 1, startedAt: 500, name: 'now-exited', cpuPercent: 80, memoryBytes: 1024 }
  const point = { ...summary(), intervalSeconds: 5, processes: [process], truncated: true }
  assert.deepEqual(parseTaskManagerHistoryPoint(point), point)
  assert.equal(parseTaskManagerHistoryPoint(point).bootId, 'past-boot')
  assert.throws(() => parseTaskManagerHistoryPoint({ ...point, processes: [process, process] }))
  assert.throws(() => parseTaskManagerHistoryPoint({ ...point, processes: Array.from({ length: 41 }, (_, i) => ({ ...process, pid: i + 1 })) }))
  assert.throws(() => parseTaskManagerHistoryPoint({ ...point, processes: [{ ...process, cpuPercent: NaN }] }))
})
