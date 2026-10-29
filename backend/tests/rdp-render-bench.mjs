// Manual native render benchmark: synthetic loopback only, no saved servers/credentials.
// node --experimental-strip-types backend/tests/rdp-render-bench.mjs [helper.exe]
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { prepareRdpRuntime } from '../src/plugins/rdp/runtime.ts'
import { connectionRecord } from '../src/plugins/rdp/native-session.ts'
import { NativeDecoder, nativeRecord, numbers } from '../src/plugins/rdp/protocol.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'webnav-rdp-bench-'))
const motion = process.argv.includes('--motion')
const executable = process.argv.slice(2).find(arg => arg !== '--motion') ?? await prepareRdpRuntime()
const openssl = process.env.WEBNAV_TEST_OPENSSL ?? join(root, '.native-deps/openssl-install/bin/openssl.exe')
let server
try {
  await mkdir(join(directory, 'rdp-certificates'))
  execFileSync(openssl, ['req', '-config', 'NUL', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'peer.key'), '-out', join(directory, 'peer.crt'), '-days', '1', '-subj', '/CN=localhost'], { windowsHide: true, stdio: 'ignore' })
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  server = spawn(join(root, 'backend/native/rdp/build/Release/webnav-rdp-test-peer.exe'), [String(port), join(directory, 'peer.crt'), join(directory, 'peer.key')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await once(server.stdout, 'data'); server.stdout.resume()
  for (const [width, height] of (motion ? [[1920, 1080], [2560, 1440], [3840, 2160]] : [[960, 540], [1920, 1080], [4096, 2160]])) {
    const runs = []
    for (let run = 0; run < (motion ? 1 : 3); run++) runs.push(await new Promise((resolve, reject) => {
      const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      const parser = new NativeDecoder(), coverage = new Uint8Array(width * height), timers = new Set()
      let started = 0, images = 0, frames = 0, bytes = 0, complete = false, measured = false
      const bridgeTimes = [], presented = []
      let idle
      const finish = error => {
        if (complete) return; complete = true; clearTimeout(timeout); clearTimeout(idle)
        for (const timer of timers) clearTimeout(timer)
        child.stdin.end(); child.kill()
        if (error) reject(error)
        else {
          const milliseconds = performance.now() - started, sorted = bridgeTimes.sort((a, b) => a - b)
          resolve({ frames, images, bytes, milliseconds: +milliseconds.toFixed(1), ...(motion ? { fps: +(frames * 1000 / milliseconds).toFixed(1), bridgeP95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0, maxFrameGapMs: Math.max(0, ...presented.slice(1).map((time, index) => time - presented[index])) } : {}) })
        }
      }
      const timeout = setTimeout(() => finish(new Error('Render timeout')), 15000)
      child.on('error', finish); child.on('exit', code => { if (!complete) finish(new Error(`Helper exited before full frame: ${code}`)) })
      child.stdin.on('error', error => { if (!complete) finish(error) })
      child.stdout.on('data', chunk => parser.push(chunk, (type, payload) => {
        if (complete) return
        if (type === 6) return finish(new Error(`Helper error ${payload.readUInt32LE(0)}`))
        if (type === 10 && measured) bridgeTimes.push(payload.readUInt32LE(4) / 1000)
        if ((type === 2 || type === 9) && measured) {
          images++; bytes += payload.length
          const [x, y, w, h] = [0, 4, 8, 12].map(at => payload.readUInt32LE(at))
          for (let row = y; row < y + h; row++) coverage.fill(1, row * width + x, row * width + x + w)
        }
        if (type === 7) {
          if (measured) { frames++; presented.push(performance.now()) }
          if (!motion && measured && coverage.every(value => value === 1)) return finish()
          const timer = setTimeout(() => { timers.delete(timer); if (!complete) child.stdin.write(nativeRecord(6, payload)) }, 16)
          timers.add(timer)
        }
        if (!measured) {
          clearTimeout(idle)
          idle = setTimeout(() => {
            measured = true; started = performance.now()
            // F6 repaints once; F8 runs a 60Hz moving scene across the full desktop.
            child.stdin.write(nativeRecord(2, numbers(motion ? 0xffc5 : 0xffc3, 1)))
            if (motion) { const timer = setTimeout(() => finish(), 5000); timers.add(timer) }
          }, 500)
        }
      }))
      child.stdin.write(connectionRecord({ host: '127.0.0.1', directory, width, height, password: 'synthetic-only', signal: new AbortController().signal,
        connection: { id: 'bench', name: 'Test', type: 'rdp', port, username: 'test', rdpOptions: { security: 'tls' } } }))
    }))
    console.log(JSON.stringify({ width, height, scenario: motion ? 'moving-cells-60hz' : 'single-solid-repaint', ackDelayMs: 16, runs, ...(!motion ? { medianMs: runs.map(row => row.milliseconds).sort((a, b) => a - b)[1] } : {}) }))
  }
} finally {
  if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill(); await exit }
  await rm(directory, { recursive: true, force: true })
}
