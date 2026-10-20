import assert from 'node:assert/strict'
import test from 'node:test'
import { selectSessionPreview } from '../src/session-preview.ts'

const frame = (protocol, id, capturedAt = 100) => ({ protocol, sessionId: id, objectUrl: `blob:preview-${id}`, capturedAt })
const session = (protocol, id, options = {}) => ({ protocol, id, state: 'running', lastActivityAt: 100, ...options })

test('running sessions follow VNC > RDP > SSH regardless of activity time', () => {
  const ssh = session('ssh', 'ssh', { lastActivityAt: 300 })
  const rdp = session('rdp', 'rdp', { lastActivityAt: 200 })
  const vnc = session('vnc', 'vnc', { lastActivityAt: 100 })
  assert.equal(selectSessionPreview([ssh, rdp, vnc]).session.id, 'vnc')
  assert.equal(selectSessionPreview([ssh, rdp]).session.id, 'rdp')
  assert.equal(selectSessionPreview([ssh]).session.id, 'ssh')
})

test('a higher-priority running session without a frame does not display an SSH frame', () => {
  const sshFrame = frame('ssh', 'ssh')
  const selected = selectSessionPreview([session('ssh', 'ssh', { frame: sshFrame }), session('vnc', 'vnc')], sshFrame)
  assert.equal(selected.session.protocol, 'vnc')
  assert.equal(selected.frame, undefined)
})

test('only the same session and protocol can reuse a retained frame', () => {
  const previous = frame('ssh', 'first')
  assert.equal(selectSessionPreview([session('ssh', 'first')], previous).frame, previous)
  assert.equal(selectSessionPreview([session('ssh', 'second')], previous).frame, undefined)
  assert.equal(selectSessionPreview([session('rdp', 'first')], previous).frame, undefined)
})

test('stopping a preferred session returns to the remaining running session', () => {
  const selected = selectSessionPreview([session('vnc', 'vnc', { state: 'stopped' }), session('ssh', 'ssh')], frame('vnc', 'vnc'))
  assert.equal(selected.session.protocol, 'ssh')
  assert.equal(selected.running, true)
  assert.equal(selected.frame, undefined)
})

test('a delayed frame cannot replace a newer retained frame from the same session', () => {
  const retained = frame('ssh', 'ssh', 200)
  const selected = selectSessionPreview([session('ssh', 'ssh', { frame: frame('ssh', 'ssh', 100) })], retained)
  assert.equal(selected.frame, retained)
})

test('after all sessions stop, retain the last displayed frame', () => {
  const lastDisplayed = frame('ssh', 'ssh', 100)
  const selected = selectSessionPreview([session('vnc', 'vnc', { state: 'stopped', frame: frame('vnc', 'vnc', 200) })], lastDisplayed)
  assert.equal(selected.frame, lastDisplayed)
  assert.equal(selected.running, false)
  assert.equal(selected.session, undefined)
})

test('when no previous selection exists, use the most recently captured stopped frame', () => {
  const latest = frame('ssh', 'ssh', 200)
  const selected = selectSessionPreview([session('vnc', 'vnc', { state: 'stopped', frame: frame('vnc', 'vnc', 100) }), session('ssh', 'ssh', { state: 'stopped', frame: latest })])
  assert.equal(selected.frame, latest)
})

test('same-protocol sessions select latest activity without mutating input', () => {
  const sessions = [session('ssh', 'first'), session('ssh', 'second', { lastActivityAt: 200 })]
  assert.equal(selectSessionPreview(sessions).session.id, 'second')
  assert.equal(sessions[0].id, 'first')
})

test('empty input and mismatched frame ownership remain empty', () => {
  assert.deepEqual(selectSessionPreview([]), { frame: undefined, running: false })
  const selected = selectSessionPreview([session('ssh', 'ssh', { frame: frame('rdp', 'other') })])
  assert.equal(selected.frame, undefined)
})
