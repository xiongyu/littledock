// Reads declarations only; never imports or executes plugin entries.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePluginContributions } from '../shared/dist/plugin-contributions.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const folders = process.argv.slice(2).filter(arg => arg !== '--check')
const sources = folders.length ? folders : ['backend/plugins', 'plugins', 'examples/plugins']
async function scan(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', '.cache'].includes(entry.name)) result.push(...await scan(resolve(directory, entry.name)))
    else if (entry.name === 'webnav.plugin.json') result.push(resolve(directory, entry.name))
  }
  return result
}
const points = []
for (const file of (await Promise.all(sources.map(path => scan(resolve(root, path))))).flat().sort()) {
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  if (!manifest.contributes) continue
  const c = parsePluginContributions(manifest.contributes, value => String(value), manifest.id.startsWith('builtin.'))
  for (const point of [...(c.menuPoints ?? []).map(p => ({ ...p, kind: 'menu' })), ...(c.uiPoints ?? [])]) {
    if (!point.public) continue
    points.push({ key: manifest.id + '/' + point.id, plugin: manifest.id, pluginName: manifest.name, pluginVersion: manifest.version, source: relative(root, file).replaceAll('\\', '/'), ...point })
  }
}
points.sort((a,b) => a.key.localeCompare(b.key))
if (new Set(points.map(p => p.key)).size !== points.length) throw Error('扩展点完整标识重复。')
const catalog = JSON.stringify({ schemaVersion: 1, generatedFrom: 'webnav.plugin.json contributes; no plugin code executed', points }, null, 2) + '\n'
if (folders.length) { process.stdout.write(catalog); process.exit(0) }
const esc = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ')
let md = '# 插件公开扩展点目录\n\n由 `pnpm plugins:catalog` 从清单生成；不要手工编辑本文件。机器可读版本：[plugin-ui-catalog.json](plugin-ui-catalog.json)。开发规则见 [plugin-ui-extensions.md](plugin-ui-extensions.md)。示例插件仅是开发参考，不自动安装。\n\n标识格式为 `插件 ID/控件局部 ID`；显示名称可更改，标识不得随显示名称变化。下表是静态契约；位置存在于清单不表示已安装、已启用或界面已挂载。\n\n| 完整标识 | 名称 / 来源 | 类型 | 版本 | 用途 |\n| --- | --- | --- | --- | --- |\n'
for (const p of points) md += `| \`${p.key}\` | ${esc(p.title)} / ${esc(p.pluginName)} | ${p.kind} | ${p.version} | ${esc(p.description)} |\n`
for (const p of points) {
  md += `\n## ${p.key}\n\n${p.description}\n\n[声明来源](../${p.source}) · 插件版本 ${p.pluginVersion} · 契约版本 ${p.version}\n\n| 字段 | 类型 | 必填 | 含义 |\n| --- | --- | --- | --- |\n`
  for (const [name, f] of Object.entries(p.fields)) md += `| \`${name}\` | ${f.type} | ${f.required ? '是' : '否'} | ${esc(f.description)} |\n`
}
for (const [file, content] of [['docs/plugin-ui-catalog.json',catalog],['docs/plugin-ui-catalog.md',md]]) {
  if (process.argv.includes('--check')) { if (await readFile(resolve(root,file),'utf8') !== content) throw Error(file+' 已过期，请运行 pnpm plugins:catalog') }
  else await writeFile(resolve(root,file),content)
}
console.log(`公开扩展点 ${points.length} 个，静态目录${process.argv.includes('--check') ? '一致' : '已生成'}。`)
