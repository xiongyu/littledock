export class AppError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_ARGUMENT', '参数格式不正确。')
  return value as Record<string, unknown>
}
export function string(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) throw new AppError('INVALID_ARGUMENT', '文本参数格式不正确。')
  return value
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AppError('INVALID_ARGUMENT', '数值超出范围。')
  return value
}
export function publicError(cause: unknown) {
  return cause instanceof AppError ? { code: cause.code, message: cause.message } : { code: 'INTERNAL', message: '本地服务处理失败，请检查配置或重试。' }
}
