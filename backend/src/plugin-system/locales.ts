import { readFile, stat } from 'node:fs/promises'
import { parseLocaleBundle, type PluginManifest, type LocaleBundle } from '@webnav/shared'
import { releaseFile } from './git.ts'

/** Read only declared, bounded JSON resources. Never import a plugin to read its labels. */
export async function readPluginLocales(root: string, manifest: PluginManifest): Promise<LocaleBundle | undefined> {
  if (!manifest.i18n) return undefined
  const locales: Record<string, unknown> = Object.create(null)
  let bytes = 0
  for (const [locale, path] of Object.entries(manifest.i18n.locales)) {
    const file = await releaseFile(root, path), size = (await stat(file)).size
    bytes += size
    if (size > 512 * 1024 || bytes > 1024 * 1024) throw new Error('Plugin locale resources exceed limit')
    const content = await readFile(file, 'utf8')
    if (Buffer.byteLength(content) > 512 * 1024) throw new Error('Plugin locale resource exceeds limit')
    locales[locale] = JSON.parse(content)
  }
  return parseLocaleBundle({ defaultLocale: manifest.i18n.defaultLocale, locales })
}
