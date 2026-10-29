import test from 'node:test'
import assert from 'node:assert/strict'
import { GuacamoleDecoder, guacamoleInstruction } from '../../shared/src/guacamole.ts'

test('Guacamole formatter counts code points without character arrays for image traffic', () => {
  assert.equal(guacamoleInstruction('', '中文', 'a😀𠮷b', 42), '0.,2.中文,4.a😀𠮷b,2.42;')
  // Counting agrees with JS code-point iteration even for isolated surrogates;
  // malformed Unicode is subsequently rejected by the decoder boundary.
  assert.equal(guacamoleInstruction('\ud800x\udc00'), '3.\ud800x\udc00;')
  const image = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(512)
  const decoder = new GuacamoleDecoder()
  let decoded = 0
  for (let frame = 0; frame < 1024; frame++) {
    decoder.push(guacamoleInstruction('blob', frame, image), values => {
      assert.deepEqual(values, ['blob', String(frame), image]); decoded++
    })
  }
  assert.equal(decoded, 1024)
})

test('Guacamole stream preserves every split boundary, Unicode pair and empty field', () => {
  const expected = [['clipboard', '19', 'text/plain'], ['blob', '19', '中文😀𠮷,.\n'], ['empty', ''], ['sync', '9']]
  const wire = expected.map(values => guacamoleInstruction(...values)).join('')
  for (let boundary = 0; boundary <= wire.length; boundary++) {
    const decoder = new GuacamoleDecoder(), received = []
    decoder.push(wire.slice(0, boundary), values => received.push(values))
    decoder.push('', values => received.push(values))
    decoder.push(wire.slice(boundary), values => received.push(values))
    assert.deepEqual(received, expected, `split at UTF-16 offset ${boundary}`)
  }
  const decoder = new GuacamoleDecoder(), received = []
  for (let at = 0; at < wire.length; at++) decoder.push(wire[at], values => received.push(values))
  assert.deepEqual(received, expected)
})

test('Guacamole long image stream consumes completed instructions without a growing history buffer', () => {
  const decoder = new GuacamoleDecoder(), image = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(512)
  const blob = guacamoleInstruction('blob', 8, image)
  const frames = 1024
  let images = 0, syncs = 0
  const receive = values => {
    if (values[0] === 'blob') { assert.equal(values[1], '8'); assert.equal(values[2], image); images++ }
    else { assert.deepEqual(values, ['sync', String(syncs++)]) }
  }
  // Complete WS packets exposed the third-party parser's history retention.
  // Mix these with fragmented packets to exercise both incremental paths.
  for (let frame = 0; frame < frames; frame++) {
    if (frame % 2) {
      decoder.push(blob.slice(0, 19), receive)
      decoder.push(blob.slice(19, 16391), receive)
      decoder.push(blob.slice(16391), receive)
    } else decoder.push(blob, receive)
    decoder.push(guacamoleInstruction('sync', frame), receive)
  }
  assert.equal(images, frames); assert.equal(syncs, frames)
  // A fresh instruction still has its complete quota after 32 MiB of traffic.
  decoder.push(guacamoleInstruction('blob', 8, image), receive)
  assert.equal(images, frames + 1)
})

test('Guacamole limits are per instruction and reject invalid lengths, Unicode and unbounded arguments', () => {
  const exact = guacamoleInstruction('😀', 'abcdef'), points = Array.from(exact).length
  const values = []
  new GuacamoleDecoder(points).push(exact + exact, row => values.push(row))
  assert.deepEqual(values, [['😀', 'abcdef'], ['😀', 'abcdef']])
  assert.throws(() => new GuacamoleDecoder(points - 1).push(exact, () => {}), /too large/)
  for (const wire of ['999999999.', '-1.a;', '.;', '1.x!', '1.\ud800x;', '1.\udc00;', '1.😀x;']) {
    assert.throws(() => new GuacamoleDecoder().push(wire, () => {}), /Invalid Guacamole/)
  }
  const split = new GuacamoleDecoder()
  split.push('1.\ud800', () => {})
  assert.throws(() => split.push(';', () => {}), /Unicode/)
  assert.throws(() => split.push('1.x;', () => {}), /has failed/)
  assert.throws(() => new GuacamoleDecoder().push('0.,'.repeat(256) + '0.;', () => {}), /Too many/)
  assert.throws(() => new GuacamoleDecoder(16).push('17.', () => {}), /element too large/)
  for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new GuacamoleDecoder(limit), /Invalid/)
})
