import { AppError } from '../../core/errors.ts'

export const MAX_NATIVE_RECORD = 1024 * 1024
export const NativeEvent = { ready: 1, image: 2, size: 3, clipboard: 4, cursor: 5, error: 6, sync: 7, certificate: 8, jpeg: 9, metrics: 10, viewer: 11 } as const

/** Inspect JPEG SOF dimensions without decoding or accepting a second unbounded payload. */
export function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error('Invalid JPEG')
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at++] !== 0xff) throw new Error('Invalid JPEG marker')
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]!
    if (marker === 0xda || marker === 0xd9) break
    const length = bytes.readUInt16BE(at)
    if (length < 2 || at + length > bytes.length) throw new Error('Invalid JPEG segment')
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[at + 2] !== 8) throw new Error('Unsupported JPEG')
      return { height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) }
    }
    at += length
  }
  throw new Error('Missing JPEG dimensions')
}
export const NativeInput = { connect: 1, key: 2, mouse: 3, size: 4, clipboard: 5, sync: 6, close: 7, certificateDecision: 8, viewer: 9 } as const
export function nativeErrorMessage(payload: Buffer): string {
  if (payload.length !== 12) return 'RDP 连接失败，请检查服务和连接设置。'
  const stage = payload.readUInt32LE(0), code = payload.readUInt32LE(4)
  if (stage === 9) return '已取消更新证书，RDP 连接已停止。'
  if (stage === 7 || code === 0x2001b) return '此 RDP 入口未保存完整账号密码。请编辑服务器，在 RDP 入口保存登录用户名和密码。'
  if (stage === 8) return 'RDP 服务器证书未受信任或已变化。请核对服务器证书，在此 RDP 入口选择合适的证书验证方式。'
  if ([0x20009, 0x20014, 0x20015].includes(code)) return 'RDP 登录失败：用户名、密码或域不正确，请编辑此 RDP 入口检查。'
  if (code === 0x20018) return 'RDP 账号已锁定，请先解除锁定后再连接。'
  if (code === 0x20008) return 'RDP TLS 握手失败，请检查远端 TLS 和证书配置。'
  return `RDP 连接失败，请检查服务和连接设置。（${stage} / 0x${code.toString(16)}）`
}
export function numbers(...values: number[]): Buffer {
  const data = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => data.writeUInt32LE(value >>> 0, index * 4))
  return data
}
export function textField(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([numbers(bytes.length), bytes])
}
export function nativeRecord(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_NATIVE_RECORD) throw new AppError('RDP_PROTOCOL', 'RDP 数据超出大小限制。')
  return Buffer.concat([numbers(type, payload.length), payload])
}
/** The helper has bounded binary records. Never decode a partial PNG or concatenate an unlimited stream. */
export class NativeDecoder {
  private header = Buffer.alloc(8)
  private headerLength = 0
  private payload?: Buffer
  private payloadLength = 0
  push(bytes: Buffer, receive: (type: number, data: Buffer) => void) {
    let offset = 0
    while (offset < bytes.length) {
      if (this.headerLength < 8) {
        const count = Math.min(8 - this.headerLength, bytes.length - offset)
        bytes.copy(this.header, this.headerLength, offset, offset + count); this.headerLength += count; offset += count
        if (this.headerLength < 8) continue
        const length = this.header.readUInt32LE(4)
        if (length > MAX_NATIVE_RECORD) throw new AppError('RDP_PROTOCOL', 'RDP 辅助程序数据超出限制。')
        // Allocate once per validated record; copying the entire partial image on
        // every pipe fragment is quadratic for large high-frame-rate JPEGs.
        this.payload = Buffer.allocUnsafe(length); this.payloadLength = 0
      }
      const payload = this.payload!
      const count = Math.min(payload.length - this.payloadLength, bytes.length - offset)
      bytes.copy(payload, this.payloadLength, offset, offset + count); this.payloadLength += count; offset += count
      if (this.payloadLength === payload.length) {
        const type = this.header.readUInt32LE(0); this.headerLength = 0; this.payload = undefined; this.payloadLength = 0
        receive(type, payload)
      }
    }
  }
}
