export interface RdpCertificateChange { previousFingerprint: string; fingerprint: string }
export interface RdpCertificateChallenge extends RdpCertificateChange { requestId: string; host: string; port: number }

export function parseRdpCertificateChange(value: unknown): RdpCertificateChange {
  if (!value || typeof value !== 'object') throw new Error('Invalid RDP certificate')
  const data = value as Record<string, unknown>
  for (const field of ['previousFingerprint', 'fingerprint']) if (typeof data[field] !== 'string' || !/^[a-f\d:]{40,191}$/i.test(data[field])) throw new Error('Invalid RDP certificate fingerprint')
  return { previousFingerprint: data.previousFingerprint as string, fingerprint: data.fingerprint as string }
}
export function parseRdpCertificateChallenge(value: unknown): RdpCertificateChallenge {
  const certificate = parseRdpCertificateChange(value), data = value as Record<string, unknown>
  if (typeof data.requestId !== 'string' || !/^[a-z\d-]{1,64}$/i.test(data.requestId) || typeof data.host !== 'string' || !data.host.length || data.host.length > 253 || typeof data.port !== 'number' || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error('Invalid RDP certificate challenge')
  return { ...certificate, requestId: data.requestId, host: data.host, port: data.port }
}
