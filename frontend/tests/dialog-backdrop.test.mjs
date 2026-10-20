import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackdropGuard } from '../src/dialog-backdrop.ts'

function dialogFixture() {
  let closes = 0
  const dialog = { getBoundingClientRect: () => ({ left: 600, right: 1040, top: 0, bottom: 800 }) }
  const input = {}
  const guard = createBackdropGuard(() => { closes++ })
  const event = (x, overrides = {}) => ({
    target: x < 600 ? dialog : input, currentTarget: dialog,
    clientX: x, clientY: 150, button: 0, pointerId: 1, isPrimary: true, ...overrides,
  })
  return { guard, event, dialog, get closes() { return closes } }
}

test('a stationary backdrop click closes once, including touch pointer events', () => {
  const f = dialogFixture()
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    f.guard.pointerdown(f.event(500, { pointerType }))
    f.guard.pointerup(f.event(502, { pointerType }))
    f.guard.click(f.event(502))
    f.guard.click(f.event(502))
  }
  assert.equal(f.closes, 3)
})

test('selecting text inside and releasing outside does not close even when click is retargeted to dialog', () => {
  const f = dialogFixture()
  f.guard.pointerdown(f.event(750))
  f.guard.pointerup(f.event(500))
  f.guard.click(f.event(500))
  assert.equal(f.closes, 0)
  // The next genuine click is not affected by the previous drag.
  f.guard.pointerdown(f.event(500))
  f.guard.pointerup(f.event(500))
  f.guard.click(f.event(500))
  assert.equal(f.closes, 1)
})

test('dragging into the panel, across the backdrop, or out and back never dismisses', () => {
  for (const positions of [[590, 650], [500, 400], [500, 400, 500]]) {
    const f = dialogFixture()
    f.guard.pointerdown(f.event(positions[0]))
    for (const x of positions.slice(1)) f.guard.pointermove(f.event(x))
    f.guard.pointerup(f.event(positions.at(-1)))
    f.guard.click(f.event(positions.at(-1), { target: f.dialog }))
    assert.equal(f.closes, 0)
  }
})

test('dialog padding and clicks without a completed pointer gesture never dismiss', () => {
  const f = dialogFixture()
  f.guard.pointerdown(f.event(700, { target: f.dialog }))
  f.guard.pointerup(f.event(700, { target: f.dialog }))
  f.guard.click(f.event(700, { target: f.dialog }))
  f.guard.click(f.event(500))
  assert.equal(f.closes, 0)
})

test('cancelled, secondary, right-button and mismatched gestures never dismiss', () => {
  for (const scenario of ['cancel', 'secondary', 'right', 'mismatch']) {
    const f = dialogFixture()
    const overrides = scenario === 'secondary' ? { isPrimary: false } : scenario === 'right' ? { button: 2 } : {}
    f.guard.pointerdown(f.event(500, overrides))
    if (scenario === 'cancel') f.guard.pointercancel()
    f.guard.pointerup(f.event(500, scenario === 'mismatch' ? { pointerId: 2 } : overrides))
    f.guard.click(f.event(500, overrides))
    assert.equal(f.closes, 0, scenario)
  }
})
