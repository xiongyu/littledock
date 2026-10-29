import test from 'node:test'
import assert from 'node:assert/strict'
import { appendMetric, appendSeries, formatRate, memoryShare, metricPath, processKey, processRows, seriesPath, targetKey, updatePinnedProcessRows, usageHeat } from '../src/task-manager.ts'

const process = (pid, ppid = 0, startedAt = pid, name = `process-${pid}`, cpuPercent = pid) => ({ pid, ppid, startedAt, name, cpuPercent, memoryBytes: pid * 100 })
const options = { query: '', tree: true, sort: 'pid', descending: false, collapsed: new Set() }

test('tree keeps ancestry, does not attach to a reused newer parent, and handles parent cycles', () => {
  const rows = processRows([process(3, 2), process(2, 1), process(1), process(4, 5), process(5, 0, 20), process(6, 7, 30), process(7, 6, 30)], options)
  assert.deepEqual(rows.map(row => [row.process.pid, row.depth]), [[1, 0], [2, 1], [3, 2], [4, 0], [5, 0], [6, 0], [7, 1]])
  assert.equal(new Set(rows.map(row => row.process.pid)).size, 7)
})

test('collapse follows stable process identity and search finds children under collapsed parents', () => {
  const processes = [process(1), process(2, 1), process(3, 2)]
  assert.deepEqual(processRows(processes, { ...options, collapsed: new Set([processKey(processes[0])]) }).map(row => row.process.pid), [1])
  assert.deepEqual(processRows(processes, { ...options, query: 'process-3', collapsed: new Set(['1:1']) }).map(row => row.process.pid), [3])
  assert.equal(processRows(processes, { ...options, collapsed: new Set(['1:99']) }).length, 3)
})

test('CPU sort keeps unavailable values last and does not mutate source process order', () => {
  const processes = [process(1, 0, 1, 'a', null), process(2, 0, 2, 'b', 10), process(3, 0, 3, 'c', 90)]
  assert.deepEqual(processRows(processes, { ...options, tree: false, sort: 'cpuPercent', descending: true }).map(row => row.process.pid), [3, 2, 1])
  assert.deepEqual(processRows(processes, { ...options, tree: false, sort: 'cpuPercent', descending: false }).map(row => row.process.pid), [2, 3, 1])
  assert.deepEqual(processes.map(item => item.pid), [1, 2, 3])
})

test('target keys do not collide and PID reuse changes identity', () => {
  assert.notEqual(targetKey({ kind: 'ssh', serverId: 'ab', connectionId: 'c' }), targetKey({ kind: 'ssh', serverId: 'a', connectionId: 'bc' }))
  assert.notEqual(processKey(process(10)), processKey(process(10, 0, 999)))
})

test('selected layout stays in place while metrics change and process identities come and go', () => {
  const original = [process(1), process(2, 1), process(3, 1)]
  const layout = processRows(original, options)
  const latest = [process(3, 1, 3, 'changed', 99), process(2, 1, 200, 'reused', 80), process(4)]
  const result = updatePinnedProcessRows(layout, latest)
  assert.deepEqual(result.map(row => row.process.pid), [1, 2, 3])
  assert.deepEqual(result.map(row => row.depth), [0, 1, 1])
  assert.deepEqual(result.map(row => row.missing), [true, true, false])
  assert.equal(result[1].process.startedAt, 2, 'reused PID does not inherit an old row')
  assert.equal(result[2].process.cpuPercent, 99, 'live metrics still refresh')
  assert.equal(layout[2].process.cpuPercent, 3, 'layout snapshot stays unchanged')
  assert.equal(updatePinnedProcessRows(layout, []).length, layout.length, 'missing predecessors cannot shift the selected row')
})

test('chart history is bounded by duration and count; unknown CPU is a gap', () => {
  const points = Array.from({ length: 400 }, (_, at) => ({ at: at * 1000, cpu: at % 100, memory: 20 }))
  assert.equal(appendMetric(points, { at: 400_000, cpu: 10, memory: 30 }).length, 300)
  assert.deepEqual(appendMetric(points, { at: 1_000_000, cpu: null, memory: 30 }), [{ at: 1_000_000, cpu: null, memory: 30 }])
  assert.match(metricPath([{ at: 1, cpu: 1, memory: 20 }, { at: 2, cpu: null, memory: 20 }, { at: 3, cpu: 2, memory: 20 }], 'cpu'), /^M[^L]+ M/)
})

test('resource heat thresholds use exact percentages; unknown metrics never become idle green', () => {
  assert.deepEqual([null, undefined, 0, 9.9, 10, 29.9, 30, 59.9, 60, 100].map(usageHeat), ['unknown', 'unknown', 'low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical'])
  assert.equal(memoryShare(4 * 1024 ** 3, 16 * 1024 ** 3), 25)
  assert.equal(usageHeat(memoryShare(4 * 1024 ** 3, 16 * 1024 ** 3)), 'medium')
  assert.equal(memoryShare(1024, 0), null)
})

test('logical processor/device history is bounded and cached sample timestamps do not inflate it', () => {
  const points = Array.from({ length: 300 }, (_, at) => ({ at: at * 1000, value: 20 }))
  const next = appendSeries(points, { at: 300_000, value: 30 }, 120)
  assert.equal(next.length, 120)
  assert.equal(appendSeries(next, { at: 300_000, value: 30 }, 120).length, 120)
  assert.equal(appendSeries(next, { at: 700_000, value: null }, 120).length, 1)
  assert.match(seriesPath([{ at: 1, value: 10 }, { at: 2, value: null }, { at: 3, value: 20 }]), /^M[^L]+ M/)
  assert.equal(formatRate(null), '不可用')
  assert.equal(formatRate(0), '0.0 KiB/s')
})
