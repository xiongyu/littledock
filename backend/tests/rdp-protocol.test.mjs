import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeDecoder, nativeRecord, nativeErrorMessage, numbers, MAX_NATIVE_RECORD, jpegDimensions } from '../src/plugins/rdp/protocol.ts'
import { connectionRecord } from '../src/plugins/rdp/native-session.ts'

test('RDP failures distinguish missing credentials, certificate rejection and remote authentication errors', () => {
  assert.match(nativeErrorMessage(numbers(7, 0x2001b, 0)), /未保存完整账号密码/)
  assert.match(nativeErrorMessage(numbers(8, 0x20008, 0x800b0109)), /证书未受信任或已变化/)
  assert.match(nativeErrorMessage(numbers(5, 0x20008, 0)), /TLS 握手失败/)
  assert.match(nativeErrorMessage(numbers(5, 0x20015, 0)), /用户名、密码或域不正确/)
  assert.match(nativeErrorMessage(numbers(5, 0x20018, 0)), /账号已锁定/)
  assert.match(nativeErrorMessage(Buffer.alloc(0)), /连接失败/)
})

test('native RDP framing accepts split/coalesced records, empty records and rejects unbounded allocation', () => {
  const parser = new NativeDecoder(), results = []
  const data = Buffer.concat([nativeRecord(1, numbers(1280, 720)), nativeRecord(6), nativeRecord(7, numbers(123))])
  for (const byte of data) parser.push(Buffer.from([byte]), (type, payload) => results.push([type, [...payload]]))
  assert.deepEqual(results, [[1, [...numbers(1280, 720)]], [6, []], [7, [...numbers(123)]]])
  const combined = []; new NativeDecoder().push(data, (type, payload) => combined.push([type, [...payload]])); assert.deepEqual(combined, results)
  assert.throws(() => new NativeDecoder().push(numbers(2, MAX_NATIVE_RECORD + 1), () => {}), { code: 'RDP_PROTOCOL' })
  const large = Buffer.alloc(MAX_NATIVE_RECORD, 0xa5), record = nativeRecord(9, large), received = []
  const fragmented = new NativeDecoder()
  for (let i = 0; i < record.length; i += 4093) fragmented.push(record.subarray(i, i + 4093), (type, payload) => received.push([type, payload]))
  assert.equal(received.length, 1); assert.equal(received[0][0], 9); assert.deepEqual(received[0][1], large)
})

test('fast RDP images validate JPEG dimensions and reject malformed segments', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc00011080438078003011100021100031100ffd9', 'hex')
  assert.deepEqual(jpegDimensions(jpeg), { width: 1920, height: 1080 })
  for (const malformed of [Buffer.alloc(0), Buffer.from('ffd8ffe0ffff', 'hex'), Buffer.from('ffd8ffff', 'hex'), jpeg.subarray(0, 14)]) assert.throws(() => jpegDimensions(malformed))
})

test('native connection payload keeps credentials in stdin and preserves UTF-8 and saved display/security', () => {
  const connection = { id: 'rdp', type: 'rdp', name: 'RDP', port: 3390, username: '测试用户', rdpDisplay: { mode: 'windowed', width: 1440, height: 900 }, rdpOptions: { domain: 'LAB', security: 'nla', certificate: 'tofu' } }
  const record = connectionRecord({ host: '127.0.0.1', connection, password: 'synthetic-secret-😀', width: 1440, height: 900, directory: 'test-data', signal: new AbortController().signal })
  let at = 8; const number = () => { const n = record.readUInt32LE(at); at += 4; return n }
  const text = () => { const size = number(), value = record.subarray(at, at + size).toString(); at += size; return value }
  assert.equal(record.readUInt32LE(4), record.length - 8); assert.equal(number(), 1); assert.equal(text(), '127.0.0.1'); assert.equal(number(), 3390)
  assert.equal(text(), '测试用户'); assert.equal(text(), 'LAB'); assert.equal(text(), 'synthetic-secret-😀')
  assert.deepEqual([number(), number(), number(), number(), number()], [1440, 900, 1, 1, 1]); assert.match(text(), /rdp-certificates$/); assert.equal(at, record.length)
})
