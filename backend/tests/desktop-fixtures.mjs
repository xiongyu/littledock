// Synthetic localhost desktop peers for protocol and browser tests. Never shipped into the catalog.
import { createServer } from 'node:net'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { Duplex } from 'node:stream'
import { GuacamoleDecoder, guacamoleInstruction as instruction } from '@webnav/shared'
import { DESECBCipher } from '../../frontend/node_modules/@novnc/novnc/core/crypto/des.js'

async function peer(handler) {
  const sockets = new Set(), server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); handler(socket)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { port: server.address().port, sockets, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
export async function mockVnc({ password, version = '008', unsupported = false } = {}) {
  const events = [], challenge = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const fixture = await peer(socket => {
    events.push(['connection']); let buffer = Buffer.alloc(0), phase = 'version', pixels = 32
    socket.write(`RFB 003.${version}\n`)
    const frame = () => {
      const width = 640, height = 360, bytesPerPixel = pixels / 8, image = Buffer.alloc(width * height * bytesPerPixel)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = (y * width + x) * bytesPerPixel, panel = x > 36 && x < 600 && y > 42 && y < 310
        const r = panel ? 66 : 26, g = panel ? 109 : 42, b = panel ? 92 : 38
        if (bytesPerPixel === 4) { image[index] = r; image[index + 1] = g; image[index + 2] = b }
        else image[index] = 0x6f
      }
      const header = Buffer.alloc(16); header[0] = 0; header.writeUInt16BE(1, 2); header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10)
      socket.write(Buffer.concat([header, image]))
    }
    function init() {
      const title = Buffer.from('Synthetic VNC desktop'), header = Buffer.alloc(24)
      header.writeUInt16BE(640, 0); header.writeUInt16BE(360, 2); header[4] = 32; header[5] = 24; header[7] = 1
      header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12); header[14] = 0; header[15] = 8; header[16] = 16
      header.writeUInt32BE(title.length, 20); socket.write(Buffer.concat([header, title]))
    }
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data])
      while (buffer.length) {
        if (phase === 'version') {
          if (buffer.length < 12) return
          events.push(['version', buffer.subarray(0, 12).toString()]); buffer = buffer.subarray(12)
          const type = unsupported ? 19 : password ? 2 : 1
          if (version === '003') { const security = Buffer.alloc(4); security.writeUInt32BE(type); socket.write(security); phase = password ? 'challenge' : 'init' }
          else { socket.write(Buffer.from([1, type])); phase = 'security' }
          if (phase === 'challenge') socket.write(challenge)
        } else if (phase === 'security') {
          events.push(['security', buffer[0]]); buffer = buffer.subarray(1); phase = password ? 'challenge' : 'init'
          if (password) socket.write(challenge)
          else if (version === '008') socket.write(Buffer.alloc(4))
        } else if (phase === 'challenge') {
          if (buffer.length < 16) return
          const key = Buffer.alloc(8); Buffer.from(password, 'latin1').copy(key, 0, 0, 8)
          const expected = Buffer.from(DESECBCipher.importKey(key).encrypt({}, challenge)), success = expected.equals(buffer.subarray(0, 16))
          events.push(['authentication', success]); buffer = buffer.subarray(16)
          const result = Buffer.alloc(4); result.writeUInt32BE(success ? 0 : 1); socket.write(result)
          if (!success) { socket.end(); return }
          phase = 'init'
        } else if (phase === 'init') { events.push(['init', buffer[0]]); buffer = buffer.subarray(1); phase = 'stream'; init() }
        else {
          const type = buffer[0]; let length
          if (type === 0) length = 20
          else if (type === 2) { if (buffer.length < 4) return; length = 4 + buffer.readUInt16BE(2) * 4 }
          else if (type === 3) length = 10
          else if (type === 4) length = 8
          else if (type === 5) length = 6
          else if (type === 6) { if (buffer.length < 8) return; length = 8 + buffer.readUInt32BE(4) }
          else if (type === 251) { if (buffer.length < 8) return; length = 8 + buffer[6] * 16 }
          else { events.push(['unknown', type]); socket.destroy(); return }
          if (buffer.length < length) return
          events.push(['input', type]); if (type === 0) pixels = buffer[4]
          if (type === 3 && buffer[1] === 0) frame()
          buffer = buffer.subarray(length)
        }
      }
    })
  })
  return { ...fixture, events }
}
export function mockRdp() {
  const events = [], connections = [], sockets = new Set()
  const launch = async options => {
    connections.push(options)
    const decoder = new StringDecoder('utf8'), parser = new GuacamoleDecoder()
    const socket = new Duplex({ read() {}, write(bytes, _, callback) { parser.push(decoder.write(bytes), values => events.push(values)); callback() } })
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.push(Buffer.from(instruction('size', 0, options.width, options.height) + instruction('rect', 0, 0, 0, options.width, options.height) + instruction('cfill', 12, 0, 30, 45, 61, 255) + instruction('sync', 1)))
    return socket
  }
  return { launch, events, connections, sockets, close() { for (const socket of sockets) socket.destroy() } }
}
