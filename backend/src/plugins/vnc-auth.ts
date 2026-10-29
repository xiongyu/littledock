import { createCipheriv } from 'node:crypto'
import type { Socket } from 'node:net'
import { AppError } from '../core/errors.ts'
import { DesktopSocketReader } from './desktop-socket.ts'

/** Classic VNC authentication (RFC 6143): reverse key bits and DES-encrypt the challenge. */
export function vncChallengeResponse(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== 16) throw new Error('Invalid VNC challenge')
  const key = Buffer.alloc(8), bytes = Buffer.from(password, 'latin1')
  for (let index = 0; index < Math.min(8, bytes.length); index++) {
    let value = bytes[index]!, reversed = 0
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1 }
    key[index] = reversed
  }
  // EDE with the same three keys is DES, available without OpenSSL's legacy provider.
  const triple = Buffer.concat([key, key, key])
  try { const cipher = createCipheriv('des-ede3', triple, null); cipher.setAutoPadding(false); return Buffer.concat([cipher.update(challenge), cipher.final()]) }
  finally { bytes.fill(0); key.fill(0); triple.fill(0) }
}

/** Authenticate on the backend. Saved VNC passwords are never sent to the browser. */
export async function authenticateVnc(socket: Socket, password?: string) {
  const reader = new DesktopSocketReader(socket)
  try {
    const greeting = (await reader.read(12)).toString('ascii')
    const version = /^RFB 003\.(003|007|008)\n$/.exec(greeting)?.[1]
    if (!version) throw new AppError('VNC_VERSION', '此 VNC 服务的协议版本暂不支持。')
    socket.write(`RFB 003.${version}\n`)
    let security: number
    if (version === '003') security = (await reader.read(4)).readUInt32BE()
    else {
      const count = (await reader.read(1))[0]!
      if (!count) throw new AppError('VNC_AUTH_FAILED', 'VNC 服务拒绝连接。')
      const types = await reader.read(count)
      security = types.includes(2) ? 2 : types.includes(1) ? 1 : 0
      if (security) socket.write(Buffer.from([security]))
    }
    if (security !== 1 && security !== 2) throw new AppError('VNC_AUTH_UNSUPPORTED', '当前支持标准 VNC 密码或无密码认证，请在 VNC 服务端选择对应方式。')
    if (security === 2) {
      if (!password) throw new AppError('CREDENTIAL_REQUIRED', '请在服务器编辑中保存 VNC 密码。')
      const challenge = await reader.read(16), response = vncChallengeResponse(password, challenge)
      socket.write(response, () => response.fill(0))
    }
    if (security === 2 || version === '008') {
      if ((await reader.read(4)).readUInt32BE() !== 0) throw new AppError('VNC_AUTH_FAILED', 'VNC 密码认证失败。')
    }
  } finally { reader.release() }
}
