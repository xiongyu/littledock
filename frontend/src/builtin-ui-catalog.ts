import { builtinUiManifest } from './builtin-ui-assets'

// Static public JSON only, like the bundled locale catalogs. No backend implementation.
const manifests = import.meta.glob('../../backend/plugins/*/webnav.plugin.json', { eager: true, import: 'default' })
export const builtinUiCatalog = new Map(Object.values(manifests).map(input => {
  const manifest = builtinUiManifest(input)
  return [manifest.id, manifest]
}))
