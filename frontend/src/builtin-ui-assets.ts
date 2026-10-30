import { parsePluginManifest, type PluginBuiltin, type PluginManifest } from '@webnav/shared'

export interface PluginAsset {
  id: string
  name?: string
  commit: string
  capabilities: PluginManifest['capabilities']
  entry?: string
  builtin?: boolean
  contributes?: PluginManifest['contributes']
  icon?: string
  styles: string[]
  config: Record<string, unknown>
}

export type BuiltinUiManifest = Pick<PluginManifest, 'id' | 'apiVersion' | 'capabilities' | 'contributes'>

export function builtinUiManifest(input: unknown): BuiltinUiManifest {
  const { id, apiVersion, capabilities, contributes } = parsePluginManifest(input, true)
  if (!id.startsWith('builtin.')) throw new Error('Expected a bundled built-in UI manifest')
  return { id, apiVersion, capabilities, contributes }
}

// UI declarations travel with the code registering them. A long-running backend may
// still hold older declarations; its identity, capabilities and runtime stay authoritative.
export function mergeBuiltinUiAssets(
  assets: readonly PluginAsset[],
  builtins: readonly PluginBuiltin[],
  bundled: ReadonlyMap<string, BuiltinUiManifest>,
  hasFrontend: (id: string) => boolean,
): PluginAsset[] {
  const result = new Map(assets.map(asset => [asset.id, asset]))
  for (const builtin of builtins) {
    const ui = bundled.get(builtin.id), current = result.get(builtin.id)
    if (!ui || !hasFrontend(builtin.id) || (current && !current.builtin)) continue
    const runtime = builtin.manifest
    if (ui.apiVersion !== runtime.apiVersion || ui.capabilities.some(required => !runtime.capabilities.some(cap => cap.id === required.id && cap.version === required.version))) continue
    const base: PluginAsset = current ?? {
      id: builtin.id, name: builtin.name, commit: runtime.version, capabilities: runtime.capabilities,
      builtin: true, icon: builtin.iconDataUrl, styles: [], config: {},
    }
    result.set(builtin.id, { ...base, contributes: ui.contributes })
  }
  return [...result.values()]
}
