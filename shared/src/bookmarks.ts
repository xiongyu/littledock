export interface WebBookmark {
  id: string
  name: string
  url: string
  version: number
  hasLogin: boolean
  previewState: 'pending' | 'capturing' | 'ready' | 'failed'
  capturedAt: number | null
}
export interface BookmarkSnapshot { revision: number; bookmarks: WebBookmark[] }
export interface WebsiteLogin { username: string; password: string }

export function validateBookmark(input: unknown): { id: string; name: string; url: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('网页收藏格式不正确。')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['id', 'name', 'url'].includes(key))) throw new Error('网页收藏包含未知字段。')
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) throw new Error('网页收藏 ID 不正确。')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60) throw new Error('网站名称需要 1 到 60 个字符。')
  if (typeof value.url !== 'string' || value.url.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.url)) throw new Error('请输入完整网址，不能包含空白或控制字符。')
  let url: URL
  try { url = new URL(value.url) } catch { throw new Error('请输入完整的 http:// 或 https:// 网址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网址仅支持 HTTP/HTTPS，账号密码请填在单独的输入框。')
  return { id: value.id, name: value.name.trim(), url: url.href }
}

export function parseBookmarkSnapshot(input: unknown): BookmarkSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('网页收藏快照不正确。')
  const value = input as Record<string, unknown>
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.bookmarks) || value.bookmarks.length > 200) throw new Error('网页收藏快照不正确。')
  const ids = new Set<string>()
  const bookmarks = value.bookmarks.map((input: unknown): WebBookmark => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('网页收藏记录不正确。')
    const row = input as Record<string, unknown>
    if (Object.keys(row).some(key => !['id', 'name', 'url', 'version', 'hasLogin', 'previewState', 'capturedAt'].includes(key))) throw new Error('网页收藏记录包含未知字段。')
    const entry = validateBookmark({ id: row.id, name: row.name, url: row.url })
    if (ids.has(entry.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 ||
      typeof row.hasLogin !== 'boolean' || !['pending', 'capturing', 'ready', 'failed'].includes(String(row.previewState)) ||
      (row.capturedAt !== null && (!Number.isSafeInteger(row.capturedAt) || Number(row.capturedAt) < 0))) throw new Error('网页收藏记录状态不正确。')
    ids.add(entry.id)
    return { ...entry, version: row.version as number, hasLogin: row.hasLogin, previewState: row.previewState as WebBookmark['previewState'], capturedAt: row.capturedAt as number | null }
  })
  return { revision: value.revision as number, bookmarks }
}
