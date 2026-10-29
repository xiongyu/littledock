import type { RemoteEditorStatus } from '@webnav/shared'

const stages: Partial<Record<RemoteEditorStatus['state'], string>> = {
  checking: '检查远端环境失败',
  'needs-install': '准备安装失败',
  downloading: '读取或下载安装包失败',
  uploading: '上传安装包失败',
  installing: '安装远端编辑器失败',
  starting: '启动远端编辑器失败',
}

export function editorErrorMessage(error: unknown, state: RemoteEditorStatus['state']) {
  const prefix = stages[state] ?? '远程编辑器操作失败'
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
  return /[\u3400-\u9fff]/.test(message) ? `${prefix}：${message.slice(0,220)}` : `${prefix}，请重试；若仍失败，请检查连接与目录权限。`
}
