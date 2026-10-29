import { parseExtensionPairing, websiteOrigin, type ExtensionPairing } from '@webnav/shared'
export interface ExtensionConfig { pairing: ExtensionPairing; automaticOrigins: string[] }
// IndexedDB belongs to the extension origin. Page/content-script storage cannot access this database.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('webnav-extension', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('settings') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('无法打开扩展本地设置。'))
  })
}
export async function readConfig(): Promise<ExtensionConfig | undefined> {
  const db = await database()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get('config')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('无法读取扩展设置。'))
    })
    if (!value) return undefined
    const row = value as Partial<ExtensionConfig>, pairing = parseExtensionPairing(row.pairing)
    if (!Array.isArray(row.automaticOrigins) || row.automaticOrigins.length > 200 || row.automaticOrigins.some(v => typeof v !== 'string' || websiteOrigin(v) !== v)) throw new Error('扩展设置损坏，请重新配对。')
    return { pairing, automaticOrigins: row.automaticOrigins }
  } finally { db.close() }
}
export async function writeConfig(value?: ExtensionConfig): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite'), store = tx.objectStore('settings')
      if (value) store.put(value, 'config'); else store.delete('config')
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('无法保存扩展设置。')); tx.onabort = tx.onerror
    })
  } finally { db.close() }
}
