import type { RemoteEditorStatus } from '@webnav/shared'

const stages: Partial<Record<RemoteEditorStatus['state'], string>> = {
  checking: '检查远端环境失败',
  'needs-install': '准备安装失败',
  downloading: '读取或下载安装包失败',
  uploading: '上传安装包失败',
  installing: '安装远端编辑器失败',
  starting: '启动远端编辑器失败',
}

function packageFailureReason(error: unknown): string | undefined {
  // fetch wraps network errors in cause; only expose known codes, never raw URLs
  // or proxy credentials. Bound traversal even for malformed/circular causes.
  const reasons: Record<string, string> = {
    ENOTFOUND: '本机无法解析下载服务器地址，请检查网络或代理。',
    EAI_AGAIN: '本机无法解析下载服务器地址，请检查网络或代理。',
    ECONNREFUSED: '本机无法连接下载服务器或代理，请检查代理是否运行。',
    ECONNRESET: '本机下载连接已中断，请检查网络或代理后重试。',
    EPIPE: '本机下载连接已中断，请检查网络或代理后重试。',
    UND_ERR_SOCKET: '本机下载连接已中断，请检查网络或代理后重试。',
    ETIMEDOUT: '本机下载超时，请检查网络或代理后重试。',
    UND_ERR_CONNECT_TIMEOUT: '本机下载超时，请检查网络或代理后重试。',
    UND_ERR_HEADERS_TIMEOUT: '本机下载超时，请检查网络或代理后重试。',
    UND_ERR_BODY_TIMEOUT: '本机下载超时，请检查网络或代理后重试。',
    EACCES: '本机安装包缓存目录无法读写，请检查目录权限。',
    EPERM: '本机安装包缓存目录无法读写，请检查目录权限。',
    ENOTDIR: '本机安装包缓存路径不是目录，请检查缓存位置。',
    EISDIR: '本机安装包路径是目录，请检查缓存文件。',
    ENOSPC: '本机安装包缓存所在磁盘空间不足。',
    CERT_HAS_EXPIRED: '下载服务器或代理的证书已过期，请检查网络证书。',
    DEPTH_ZERO_SELF_SIGNED_CERT: '无法验证下载服务器或代理的证书，请检查网络证书。',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证下载服务器或代理的证书，请检查网络证书。',
  }
  let cause = error
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? cause.code : undefined
    if (typeof code === 'string' && reasons[code]) return reasons[code]
    if ('name' in cause && cause.name === 'TimeoutError') return reasons.ETIMEDOUT
    cause = 'cause' in cause ? cause.cause : undefined
  }
}

export function editorErrorMessage(error: unknown, state: RemoteEditorStatus['state']) {
  const prefix = stages[state] ?? '远程编辑器操作失败'
  if (state === 'downloading') {
    const reason = packageFailureReason(error)
    if (reason) return `${prefix}：${reason}`
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const sftpReasons: Record<number, string> = {
    2: '远端文件或目录不存在。',
    3: '当前 SSH 用户没有读写目标目录的权限。',
    4: '远端 SFTP 拒绝了文件操作（状态码 4）。',
    6: 'SSH 连接尚未建立。',
    7: 'SSH 连接已中断。',
    8: '远端 SFTP 不支持此文件操作。',
  }
  if (typeof code === 'number' && sftpReasons[code]) return `${prefix}：${sftpReasons[code]}`
  if (code === 'ENOSPC') return `${prefix}：磁盘空间不足。`
  if (code === 'ECONNRESET' || code === 'EPIPE') return `${prefix}：连接已中断。`
  // Keep our actionable messages, but never show a raw English "Failure" alone.
  const message = error instanceof Error ? error.message : ''
  if (state === 'downloading' && !/[\u3400-\u9fff]/.test(message)) return `${prefix}：请检查本机网络、代理及安装包缓存；此阶段尚未上传到 SSH 服务器。`
  return /[\u3400-\u9fff]/.test(message) ? `${prefix}：${message.slice(0,220)}` : `${prefix}，请重试；若仍失败，请检查连接与目录权限。`
}
