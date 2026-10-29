import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parsePluginManifest, type PluginDetails } from '@webnav/shared'
import { releaseFile } from './git.ts'
import { readPluginLocales } from './locales.ts'

// Only the host-supplied installation directory is searched. Git packages cannot claim this source.
export async function loadBundledPlugins(directory: string, releases: string) {
  const plugins: PluginDetails[] = [], errors: string[] = [], invalidReleases: string[] = []
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { plugins, errors, invalidReleases }; throw cause }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    let verifyingRelease: string | undefined
    try {
      const files = new Map<string, Buffer>(); let bytes = 0
      async function collect(root: string, prefix = '') {
        for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (['.git', 'node_modules'].includes(item.name)) continue
          const name = prefix ? prefix + '/' + item.name : item.name, path = join(root, name), info = await lstat(path)
          if (info.isSymbolicLink()) throw new Error('随附包不允许链接文件。')
          if (info.isDirectory()) { if (name.split('/').length > 16) throw new Error('随附包目录过深。'); await collect(root, name) }
          else {
            if (!info.isFile() || info.size > 64 * 1024 * 1024 || files.size >= 2000 || (bytes += info.size) > 128 * 1024 * 1024) throw new Error('随附包文件超限。')
            files.set(name, await readFile(path))
          }
        }
      }
      await collect(join(directory, entry.name))
      const manifest = parsePluginManifest(JSON.parse(files.get('webnav.plugin.json')?.toString('utf8') ?? 'null'))
      if (plugins.some(plugin => plugin.manifest.id === manifest.id) || manifest.install?.length) throw new Error('随附包重复或包含安装脚本。')
      for (const path of [manifest.backend, manifest.frontend, manifest.icon, manifest.contributes?.settings?.entry, ...(manifest.styles ?? []), ...(manifest.contributes?.settings?.styles ?? []), ...(manifest.contributes?.tools.map(tool => tool.icon) ?? [])].filter((p): p is string => !!p)) if (!files.has(path)) throw new Error('随附包缺少声明的资源。')
      const hash = createHash('sha256'); for (const [name, data] of files) hash.update(name).update('\0').update(data).update('\0')
      const commit = hash.digest('hex'), target = resolve(releases, manifest.id, commit)
      if (!target.startsWith(resolve(releases) + sep)) throw new Error('随附包缓存路径无效。')
      const temporary = target + '.' + randomUUID() + '.tmp'
      try {
        const existing = await lstat(target).catch(cause => { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause })
        if (existing) {
          verifyingRelease = manifest.id + '/' + commit
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('随附包缓存无效。')
          for (const [name, expected] of files) if (!(await readFile(await releaseFile(target, name))).equals(expected)) throw new Error('随附包缓存校验失败，请保留原文件后修复。')
          verifyingRelease = undefined
        } else {
          for (const [name, data] of files) { const path = join(temporary, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data) }
          await rename(temporary, target)
        }
      } finally { if (!temporary.startsWith(resolve(releases) + sep)) throw new Error('清理路径无效。'); await rm(temporary, { recursive: true, force: true }) }
      const mime = manifest.icon.endsWith('.svg') ? 'image/svg+xml' : manifest.icon.endsWith('.png') ? 'image/png' : manifest.icon.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      await readPluginLocales(target, manifest)
      plugins.push({ manifest, repository: 'bundled:' + manifest.id, commit, readme: files.get(manifest.readme ?? 'README.md')?.toString('utf8') ?? '', iconDataUrl: `data:${mime};base64,${files.get(manifest.icon)!.toString('base64')}`, fetchedAt: Date.now(), cached: true, reasons: [] })
    } catch (cause) { if (verifyingRelease) invalidReleases.push(verifyingRelease); errors.push(`${entry.name}：${cause instanceof Error ? cause.message : '随附插件读取失败。'}`) }
  }
  return { plugins, errors, invalidReleases }
}
