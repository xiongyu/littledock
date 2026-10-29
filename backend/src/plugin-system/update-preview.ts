import semver from 'semver'
import type { InstalledPlugin, PluginManifest, PluginPreview } from '@webnav/shared'

/** Compare static declarations only; preview must never import candidate code. */
export function updatePreview(manifest: PluginManifest, commit: string, old?: InstalledPlugin): Pick<PluginPreview, 'change' | 'installedRelease' | 'changes'> {
  if (!old) return { change: 'install', changes: [] }
  const changes: string[] = []
  const previous = old.manifest
  for (const capability of manifest.capabilities) if (!previous.capabilities.some(c => c.id === capability.id)) changes.push(`新增能力：${capability.id}`)
  for (const capability of previous.capabilities) if (!manifest.capabilities.some(c => c.id === capability.id)) changes.push(`移除能力：${capability.id}`)
  for (const tool of manifest.automation?.tools ?? []) {
    const before = previous.automation?.tools.find(t => t.id === tool.id)
    if (!before) changes.push(`新增 AI 工具：${tool.title}（${tool.id}）`)
    else if (JSON.stringify(before) !== JSON.stringify(tool)) changes.push(`AI 工具声明变化：${tool.title}（${tool.id}）`)
    if (!before || before.access !== tool.access || JSON.stringify([...before.scopes].sort()) !== JSON.stringify([...tool.scopes].sort())) {
      const access = { read: '读取', write: '写入', execute: '执行命令', control: '控制会话' }
      changes.push(`AI 权限 ${tool.id}：${before ? `${access[before.access]} / ${before.scopes.join('、')}` : '未开放'} → ${access[tool.access]} / ${tool.scopes.join('、')}`)
    }
  }
  for (const tool of previous.automation?.tools ?? []) if (!manifest.automation?.tools.some(t => t.id === tool.id)) changes.push(`移除 AI 工具：${tool.title}（${tool.id}）`)
  if (JSON.stringify(previous.dependencies ?? {}) !== JSON.stringify(manifest.dependencies ?? {})) changes.push('插件依赖要求变化。')
  if (JSON.stringify(previous.commands ?? []) !== JSON.stringify(manifest.commands ?? [])) changes.push('外部组件要求变化。')
  if (JSON.stringify(previous.install ?? []) !== JSON.stringify(manifest.install ?? [])) changes.push('安装步骤变化，请展开核对。')
  if ((previous.execution?.backend ?? 'shared') !== (manifest.execution?.backend ?? 'shared')) changes.push(manifest.execution?.backend === 'dedicated' ? '后端改为独占插件线程。' : '后端改为共享插件线程，会与同组插件共享执行线程。')
  if ((previous.reload ?? 'hot') !== (manifest.reload ?? 'hot')) changes.push(manifest.reload === 'restart' ? '新版本需要重启后生效。' : '新版本支持热更新；实际切换仍取决于当前运行版本及关联插件。')
  const valid = semver.valid(manifest.version) && semver.valid(previous.version)
  const change = commit === old.commit ? 'current' : valid && semver.gt(manifest.version, previous.version) ? 'upgrade' : valid && semver.lt(manifest.version, previous.version) ? 'downgrade' : 'rebuild'
  return { change, installedRelease: { version: previous.version, commit: old.commit }, changes }
}
