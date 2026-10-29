import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { GuacamoleDecoder, guacamoleInstruction as instruction, getRdpCertificatePolicy, parseRdpCertificateChange, type RdpCertificateChange, type Connection } from '@webnav/shared'
import { AppError } from '../../core/errors.ts'
import { NativeDecoder, NativeEvent, NativeInput, nativeRecord, nativeErrorMessage, numbers, textField, jpegDimensions } from './protocol.ts'
import { prepareRdpRuntime } from './runtime.ts'
import type { DesktopStream } from '../../core/desktop-stream.ts'

export interface RdpLaunchOptions { host: string; connection: Connection; password?: string; width: number; height: number; directory: string; signal: AbortSignal; confirmCertificate?: (certificate: RdpCertificateChange) => Promise<boolean> }
export type RdpLauncher = (options: RdpLaunchOptions) => Promise<Duplex>
export function connectionRecord(options: RdpLaunchOptions) {
  const { connection, host, password = '', width, height, directory } = options
  return nativeRecord(NativeInput.connect, Buffer.concat([
    numbers(1), textField(host), numbers(connection.port), textField(connection.username ?? ''), textField(connection.rdpOptions?.domain ?? ''), textField(password),
    numbers(width, height, ({ any: 0, nla: 1, tls: 2, rdp: 3 })[connection.rdpOptions?.security ?? 'any'], getRdpCertificatePolicy(connection) === 'tofu' ? 1 : 0, !connection.rdpDisplay || connection.rdpDisplay.mode === 'windowed' ? 1 : 0),
    textField(join(directory, 'rdp-certificates')),
  ]))
}
export const launchFreeRdp: RdpLauncher = async options => {
  options.signal.throwIfAborted()
  const nativeExecutable = await prepareRdpRuntime()
  await mkdir(join(options.directory, 'rdp-certificates'), { recursive: true })
  options.signal.throwIfAborted()
  return await new Promise<Duplex>((resolve, reject) => {
    const child = spawn(nativeExecutable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let ready = false, settled = false, certificatePending = false, streamId = 0, clipping: { id: string; chunks: Buffer[]; bytes: number } | undefined
    const parser = new NativeDecoder(), inputParser = new GuacamoleDecoder(), utf8 = new StringDecoder('utf8')
    let desktopWidth = options.width, desktopHeight = options.height, viewing = true, viewerGeneration = 0
    const pendingFrames = new Set<number>()
    const fail = (message: string) => { const error = new AppError('RDP_CONNECT_FAILED', message); if (!settled) { settled = true; reject(error) }; channel.destroy(error) }
    const abort = () => fail('RDP 连接已取消。')
    const send = (type: number, payload?: Buffer) => {
      if (child.stdin.destroyed || child.stdin.writableLength > 1024 * 1024) throw new AppError('FLOW_CONTROL', 'RDP 输入超过缓冲上限。')
      child.stdin.write(nativeRecord(type, payload))
    }
    const emit = (text: string) => { if (!channel.push(Buffer.from(text))) child.stdout.pause() }
    const stream = (stream: number, data: Buffer) => {
      for (let i = 0; i < data.length; i += 24 * 1024) emit(instruction('blob', stream, data.subarray(i, i + 24 * 1024).toString('base64')))
      emit(instruction('end', stream))
    }
    // Keep a PNG's instructions in one bounded stream chunk instead of scheduling
    // one WebSocket send per img/blob/end. Do not buffer a whole desktop in Node.
    const image = (id: number, layer: number, mask: number, x: number, y: number, data: Buffer, prefix = '', suffix = '', mime = 'image/png') => {
      const parts = [prefix, instruction('img', id, mask, layer, mime, x, y)]
      for (let i = 0; i < data.length; i += 24 * 1024) parts.push(instruction('blob', id, data.subarray(i, i + 24 * 1024).toString('base64')))
      parts.push(instruction('end', id), suffix); emit(parts.join(''))
    }
    const validateImage = (payload: Buffer, cursor = false, jpeg = false) => {
      if (payload.length < 40) throw new Error('Invalid PNG')
      const x = payload.readUInt32LE(0), y = payload.readUInt32LE(4), width = payload.readUInt32LE(8), height = payload.readUInt32LE(12)
      if (!width || !height || width > (jpeg ? 4096 : 256) || height > (jpeg ? 2160 : 256) || (cursor ? x >= width || y >= height : x + width > desktopWidth || y + height > desktopHeight)) throw new Error('Invalid image bounds')
      if (jpeg) { const size = jpegDimensions(payload.subarray(16)); if (size.width !== width || size.height !== height) throw new Error('Invalid JPEG dimensions') }
      else if (!payload.subarray(16, 24).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || payload.readUInt32BE(32) !== width || payload.readUInt32BE(36) !== height) throw new Error('Invalid PNG dimensions')
    }
    const number = (values: string[], index: number, min: number, max: number) => {
      const value = Number(values[index]); if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid RDP input'); return value
    }
    const channel = new Duplex({
      readableHighWaterMark: 512 * 1024, writableHighWaterMark: 64 * 1024,
      read() { child.stdout.resume() },
      write(chunk: Buffer, _encoding, callback) {
        try {
          inputParser.push(utf8.write(chunk), values => {
            const op = values[0]
            if (op === 'key' && values.length === 3) send(NativeInput.key, numbers(number(values, 1, 0, 0x1fffffff), number(values, 2, 0, 1)))
            else if (op === 'mouse' && values.length === 4) send(NativeInput.mouse, numbers(number(values, 1, 0, 4095), number(values, 2, 0, 2159), number(values, 3, 0, 255)))
            else if (op === 'size' && values.length === 3) send(NativeInput.size, numbers(number(values, 1, 200, 4096), number(values, 2, 200, 2160)))
            else if (op === 'sync' && values.length >= 2) { const sequence=number(values,1,0,0xffffffff);if(pendingFrames.has(sequence)){send(NativeInput.sync,numbers(sequence));for(const frame of pendingFrames){pendingFrames.delete(frame);if(frame===sequence)break}} }
            else if (op === 'clipboard' && values.length === 3 && values[2] === 'text/plain' && !clipping) {
              clipping = { id: values[1]!, chunks: [], bytes: 0 }; emit(instruction('ack', clipping.id, 'OK', 0))
            } else if (op === 'blob' && values.length === 3 && clipping && clipping.id === values[1]) {
              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(values[2]!)) throw new Error('Invalid clipboard')
              const data = Buffer.from(values[2]!, 'base64'); clipping.bytes += data.length
              if (clipping.bytes > 64 * 1024) throw new Error('Clipboard too large')
              clipping.chunks.push(data); emit(instruction('ack', clipping.id, 'OK', 0))
            } else if (op === 'end' && values.length === 2 && clipping && clipping.id === values[1]) {
              send(NativeInput.clipboard, Buffer.concat(clipping.chunks)); clipping = undefined
            } else if (op === 'disconnect') channel.destroy()
            else if (op !== 'nop' && op !== 'ack') throw new Error('Unsupported RDP input')
          }); callback()
        } catch { callback(new AppError('RDP_PROTOCOL', '网页 RDP 输入无效。')) }
      },
      destroy(error, callback) {
        clearTimeout(timer); options.signal.removeEventListener('abort', abort); clipping = undefined
        child.stdin.destroy(); child.stdout.destroy(); child.kill(); callback(error)
      },
    })
    const resumable = channel as DesktopStream
    resumable.viewerVersion = 1
    resumable.setViewer = attached => { viewing=false; clipping=undefined; pendingFrames.clear();while(channel.read()!==null){/* Discard the old viewer's queued display chunks. */}send(NativeInput.viewer,numbers(++viewerGeneration,attached?1:0)) }
    channel.on('error', () => {})
    options.signal.addEventListener('abort', abort, { once: true })
    let timer = setTimeout(() => fail('RDP 连接或认证超时。'), 25_000)
    const confirmCertificate = async (payload: Buffer) => {
      if (ready || certificatePending) throw new Error('Unexpected certificate challenge')
      let offset = 0
      const text = () => {
        if (offset + 4 > payload.length) throw new Error('Invalid certificate record')
        const length = payload.readUInt32LE(offset); offset += 4
        if (length > 1024 || offset + length > payload.length) throw new Error('Invalid certificate record')
        const value = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(offset, offset + length)); offset += length; return value
      }
      const certificate = parseRdpCertificateChange({ previousFingerprint: text(), fingerprint: text() })
      if (offset !== payload.length) throw new Error('Invalid certificate record')
      certificatePending = true; clearTimeout(timer)
      timer = setTimeout(() => fail('证书更新确认已超时，连接已停止。'), 120_000)
      const accepted = await options.confirmCertificate?.(certificate) ?? false
      if (channel.destroyed) return
      certificatePending = false; clearTimeout(timer)
      timer = setTimeout(() => fail('RDP 连接或认证超时。'), 25_000)
      send(NativeInput.certificateDecision, numbers(accepted ? 1 : 0))
    }
    child.on('error', () => fail('无法启动 RDP 本机组件。'))
    child.on('exit', () => { if (!channel.destroyed) fail(ready ? 'RDP 连接已结束。' : 'RDP 连接失败，请检查地址、账号密码和证书设置。') })
    child.stdin.on('error', () => { if (!channel.destroyed) fail('RDP 组件通信中断。') })
    child.stdout.on('data', (data: Buffer) => {
      try {
        parser.push(data, (type, payload) => {
          if (channel.destroyed) return
          if (type === NativeEvent.error) { fail(nativeErrorMessage(payload)); return }
          if (type === NativeEvent.certificate) { void confirmCertificate(payload).catch(() => { if (!channel.destroyed) fail('无法确认 RDP 证书更新。') }); return }
          if (type === NativeEvent.viewer) { if(payload.length!==8)throw new Error('Invalid viewer');if(payload.readUInt32LE(0)===viewerGeneration)viewing=payload.readUInt32LE(4)===1;return }
          if (type === NativeEvent.ready && !ready && payload.length === 8) {
            ready = true; settled = true; clearTimeout(timer); child.stdout.pause(); channel.pause(); resolve(channel)
          } else if (!ready) throw new Error('RDP helper not ready')
          if(!viewing)return
          if (type === NativeEvent.ready || type === NativeEvent.size) {
            if (payload.length !== 8 || payload.readUInt32LE(0) < 200 || payload.readUInt32LE(0) > 4096 || payload.readUInt32LE(4) < 200 || payload.readUInt32LE(4) > 2160) throw new Error('Invalid size')
            desktopWidth = payload.readUInt32LE(0); desktopHeight = payload.readUInt32LE(4)
            emit(instruction('size', 0, payload.readUInt32LE(0), payload.readUInt32LE(4)))
          } else if (type === NativeEvent.image || type === NativeEvent.jpeg) {
            validateImage(payload, false, type === NativeEvent.jpeg)
            const id = streamId++ % 1000000
            image(id, 0, 14, payload.readUInt32LE(0), payload.readUInt32LE(4), payload.subarray(16), '', '', type === NativeEvent.jpeg ? 'image/jpeg' : 'image/png')
          } else if (type === NativeEvent.sync && payload.length === 4) {pendingFrames.add(payload.readUInt32LE(0));emit(instruction('sync', payload.readUInt32LE(0)))}
          else if (type === NativeEvent.metrics && payload.length === 16) emit(instruction('webnav-frame', ...[0, 4, 8, 12].map(at => payload.readUInt32LE(at))))
          else if (type === NativeEvent.clipboard && payload.length <= 64 * 1024) {
            const id = streamId++ % 1000000; emit(instruction('clipboard', id, 'text/plain')); stream(id, payload)
          } else if (type === NativeEvent.cursor) {
            validateImage(payload, true)
            const id = streamId++ % 1000000, width = payload.readUInt32LE(8), height = payload.readUInt32LE(12)
            image(id, -1, 12, 0, 0, payload.subarray(16), instruction('size', -1, width, height), instruction('cursor', payload.readUInt32LE(0), payload.readUInt32LE(4), -1, 0, 0, width, height))
          } else if (type !== NativeEvent.ready && type !== NativeEvent.size) throw new Error('Unknown RDP output')
        })
      } catch { fail('RDP 组件返回了无效画面。') }
    })
    const config = connectionRecord(options)
    child.stdin.write(config, () => config.fill(0))
    if (options.signal.aborted) abort()
  })
}
