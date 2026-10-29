import test from 'node:test'
import assert from 'node:assert/strict'
import { historyGapReason, historyLocalTime, historyMetric, historyPath, historyPreset, historyRange, nearestHistoryPoint } from '../src/task-manager-history.ts'
import { seriesAreaPath } from '../src/task-manager.ts'

test('history range stays fixed and validates local time and maximum window', () => {
  const range = historyPreset(6, 1_800_000_000_000)
  assert.deepEqual(range, { from: 1_799_978_400_000, to: 1_800_000_000_000 })
  const parsed = historyRange(historyLocalTime(range.from), historyLocalTime(range.to))
  assert.deepEqual(parsed, range)
  assert.equal(historyRange('invalid', historyLocalTime(range.to)), undefined)
  assert.equal(historyRange(historyLocalTime(range.to), historyLocalTime(range.from)), undefined)
  assert.equal(historyRange(historyLocalTime(range.from - 32 * 86400_000), historyLocalTime(range.to)), undefined)
})

test('historical charts break only at reported gaps and retain real zero', () => {
  const page = { from: 0, to: 1000, points: [{ sampledAt: 100, cpuPercent: 0 }, { sampledAt: 900, cpuPercent: 80 }], gaps: [{ from: 300, to: 600, reason: 'recorder-interrupted' }] }
  const points = historyMetric(page, point => point.cpuPercent)
  assert.deepEqual(points, [{ at: 100, value: 0 }, { at: 300, value: null }, { at: 600, value: null }, { at: 900, value: 80 }])
  assert.equal((historyPath(points, 0, 1000, 100).match(/M/g) ?? []).length, 2)
  const area = seriesAreaPath(points, 0, 1000, 100, 160)
  assert.equal((area.match(/Z/g) ?? []).length, 2, 'filled areas close independently on each side of a recording gap')
  assert.match(area, /M60\.0,160\.0/, 'true zero stays on the baseline')
  assert.match(area, /M540\.0,32\.0/, 'area uses the actual sample height without smoothing peaks')
  const aggregated = historyMetric({ ...page, gaps: [] }, point => point.cpuPercent)
  assert.equal((historyPath(aggregated, 0, 1000, 100).match(/L/g) ?? []).length, 1, 'downsampling is not a recording gap')
  assert.equal(historyGapReason('recorder-interrupted'), '记录进程曾中断')
  assert.equal(nearestHistoryPoint(page.points, 850), 1)
  assert.equal(nearestHistoryPoint([], 850), -1)
})
