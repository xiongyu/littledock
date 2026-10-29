
import { pluginI18n, pluginText } from './i18n.ts'
const { t: i18nT } = pluginI18n('core')
import { ref } from 'vue'
import { parsePluginMenuContext, type PluginContributions, type PluginMenuContext, type PluginMenuContribution, type PluginMenuPoint } from '@webnav/shared'
import type { PluginMenuItemHandler, PluginMenuLocalItem } from './plugin-menu-api'

interface Entry { declaration: PluginMenuContribution; handler: PluginMenuItemHandler }
export interface PluginMenuBinding { plugin: string; point: string; context: () => unknown; isCurrent: () => boolean }
export interface MenuVisualItem extends PluginMenuLocalItem { source?: string; sourceId?: string }
export class PluginMenuScope {
  readonly points = new Map<string, PluginMenuPoint>()
  readonly entries = new Map<string, Entry>()
  readonly pending = new Map<AbortController, Promise<unknown>>()
  readonly busy = new Set<string>()
  registering = true
  disposed = false
  constructor(readonly plugin: string, readonly name: string, private declaration: PluginContributions | undefined, private changed: () => void) {}
  private requireRegistration() { if (!this.registering || this.disposed) throw new Error(i18nT('m65bbb422bb9e')) }
  registerPoint(id: string) {
    this.requireRegistration()
    const point = this.declaration?.menuPoints?.find(point => point.id === id)
    if (!point || this.points.has(id)) throw new Error(i18nT('mb0a809ec868d'))
    this.points.set(id, structuredClone(point))
  }
  registerItem(id: string, handler: PluginMenuItemHandler) {
    this.requireRegistration()
    const declaration = this.declaration?.menuItems?.find(item => item.id === id)
    if (!declaration || this.entries.has(id) || typeof handler?.run !== 'function' || (handler.when !== undefined && typeof handler.when !== 'function') || (handler.enabled !== undefined && typeof handler.enabled !== 'function')) throw new Error(i18nT('m44d88653c1d5'))
    this.entries.set(id, { declaration: structuredClone(declaration), handler: { ...handler } })
  }
  seal() {
    if (this.declaration?.menuPoints?.some(p => !this.points.has(p.id)) || this.declaration?.menuItems?.some(m => !this.entries.has(m.id))) throw new Error(i18nT('m7a86e7322644'))
    this.registering = false
  }
  cancel() { for (const controller of this.pending.keys()) controller.abort() }
  async dispose() { this.disposed = true; this.registering = false; this.cancel(); this.changed(); await Promise.allSettled([...this.pending.values()]) }
}
interface Receipt { scope: PluginMenuScope; key: string; entry?: Entry; item: MenuVisualItem; current?: () => boolean; run: PluginMenuItemHandler['run'] }
export class PluginMenuRegistry {
  readonly revision = ref(0)
  private scopes = new Map<string, PluginMenuScope>()
  private invocations = new Map<AbortController, PluginMenuScope>()
  constructor(private available: () => boolean = () => true, private report: (message: string) => void = () => {}) {}
  private changed = () => { this.revision.value++ }
  createScope(plugin: string, name: string, declaration?: PluginContributions) { return new PluginMenuScope(plugin, name, declaration, this.changed) }
  publish(scopes: PluginMenuScope[]) {
    const next = new Map(scopes.map(scope => [scope.plugin, scope]))
    if (next.size !== scopes.length || scopes.some(scope => scope.disposed || scope.registering)) throw new Error(i18nT('mcff63fa721e1'))
    for (const [id, scope] of this.scopes) if (next.get(id) !== scope) scope.cancel()
    for (const [controller, owner] of this.invocations) if (next.get(owner.plugin) !== owner) controller.abort()
    this.scopes = next; this.changed()
  }
  cancelPending() { for (const scope of this.scopes.values()) scope.cancel() }
  session(binding: PluginMenuBinding) {
    const owner = this.scopes.get(binding.plugin), point = owner?.points.get(binding.point)
    if (!owner || !point) throw new Error(i18nT('m137d2bc56306'))
    const context = parsePluginMenuContext(point, binding.context()), identity = JSON.stringify(context)
    let receipts = new Map<string, Receipt>()
    const valid = () => {
      this.revision.value
      try { return this.available() && this.scopes.get(owner.plugin) === owner && !owner.disposed && binding.isCurrent() && JSON.stringify(parsePluginMenuContext(point, binding.context())) === identity } catch { return false }
    }
    const copy = () => Object.freeze({ ...context })
    const allowed = (entry: Entry) => { try { return (!entry.handler.when || entry.handler.when(copy()) === true) && (!entry.handler.enabled || entry.handler.enabled(copy()) === true) } catch { return false } }
    return {
      valid,
      items: (getLocal: () => readonly PluginMenuLocalItem[], run: (id: string) => unknown): MenuVisualItem[] => {
        if (!valid()) { receipts.clear(); return [] }
        const local = getLocal()
        if (local.length > 64 || new Set(local.map(item => item.id)).size !== local.length) throw new Error(i18nT('mbc38155a80ba'))
        const candidates: { receipt: Receipt; order: number; group: string }[] = []
        let group = 0
        for (const [index, item] of local.entries()) {
          if (!/^[a-zA-Z][a-zA-Z0-9.-]{0,79}$/.test(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > 100) throw new Error(i18nT('m80038f9139b0'))
          if (item.separator) group++
          const key = owner.plugin + '/local/' + item.id
          candidates.push({ receipt: { scope: owner, key, current: () => getLocal().some(current => current.id === item.id && !current.disabled), item: { ...item, id: key, disabled: item.disabled || owner.busy.has(key) }, run: () => run(item.id) }, order: item.order ?? index * 10, group: item.group ?? 'local-' + group })
        }
        for (const scope of this.scopes.values()) for (const entry of scope.entries.values()) {
          const item = entry.declaration
          if (!point.public && scope !== owner) continue
          if (scope.disposed || item.target.plugin !== owner.plugin || item.target.point !== point.id || item.target.version !== point.version) continue
          try { if (entry.handler.when && entry.handler.when(copy()) !== true) continue } catch { continue }
          const key = scope.plugin + '/item/' + item.id
          candidates.push({ receipt: { scope, entry, key, item: { id: key, label: pluginText(scope.plugin, `menuItems.${item.id}.title`, item.title), danger: item.danger, disabled: !allowed(entry) || scope.busy.has(key), source: pluginText(scope.plugin, 'metadata.name', scope.name), sourceId: scope.plugin }, run: entry.handler.run }, order: item.order, group: scope.plugin + '/' + item.group })
        }
        candidates.sort((a, b) => a.order - b.order || a.group.localeCompare(b.group) || a.receipt.key.localeCompare(b.receipt.key))
        receipts = new Map(candidates.map(({ receipt }) => [receipt.key, receipt]))
        return candidates.map(({ receipt, group }, index) => ({ ...receipt.item, separator: index > 0 && candidates[index - 1]!.group !== group }))
      },
      execute: (id: string): Promise<void> => {
        const receipt = receipts.get(id)
        if (!valid() || !receipt || receipt.item.disabled || (receipt.current && !receipt.current()) || receipt.scope.disposed || this.scopes.get(receipt.scope.plugin) !== receipt.scope || receipt.scope.busy.has(receipt.key) || receipt.scope.pending.size >= 8 || (receipt.entry && (receipt.scope.entries.get(receipt.entry.declaration.id) !== receipt.entry || !allowed(receipt.entry)))) return Promise.resolve()
        const controller = new AbortController(), scope = receipt.scope
        this.invocations.set(controller, owner)
        scope.busy.add(receipt.key); this.changed()
        // Invoke synchronously to preserve clipboard/window-open user activation.
        let result: unknown
        try { result = receipt.run(copy(), { signal: controller.signal }) } catch (cause) { result = Promise.reject(cause) }
        const timer = setTimeout(() => { controller.abort(); this.report(i18nT('m55043d31cf41', { p0: (scope.name) })) }, 15000)
        const operation = Promise.resolve(result).then(() => {}, () => { if (!controller.signal.aborted) this.report(i18nT('mde28514f3085', { p0: (scope.name) })) }).finally(() => { clearTimeout(timer); this.invocations.delete(controller); scope.pending.delete(controller); scope.busy.delete(receipt.key); this.changed() })
        scope.pending.set(controller, operation)
        if (scope.disposed || this.scopes.get(scope.plugin) !== scope || !this.available()) controller.abort()
        return operation
      },
    }
  }
}
export const pluginMenuNotice = ref<{ message: string; sequence: number }>()
let available = () => true
export function setMenuAvailability(check: () => boolean) { available = check }
export const pluginMenus = new PluginMenuRegistry(() => available(), message => { pluginMenuNotice.value = { message, sequence: (pluginMenuNotice.value?.sequence ?? 0) + 1 } })
export function menuBinding(plugin: string, point: string, context: () => unknown, isCurrent: () => boolean): PluginMenuBinding { return { plugin, point, context, isCurrent } }
