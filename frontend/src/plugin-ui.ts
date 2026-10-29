import { markRaw, ref, type Component } from 'vue'
import { parsePluginMenuContext, type PluginContributions, type PluginMenuContext, type PluginUiContribution, type PluginUiPoint, type PluginMenuPoint } from '@webnav/shared'
import type { PluginUiInstanceInfo, PluginUiPointInfo, PluginUiQuery } from './plugin-menu-api'
interface UiEntry { declaration: PluginUiContribution; component: Component; when?: (context: PluginMenuContext) => boolean }
type Point = PluginMenuPoint & { kind: PluginUiPointInfo['kind'] }
export interface UiContributionView { key: string; title: string; plugin: string; pluginName: string; component: Component; scope: PluginUiScope }
export class PluginUiScope {
  readonly points = new Map<string, Point>()
  readonly entries = new Map<string, UiEntry>()
  registering = true
  disposed = false
  constructor(readonly plugin: string, readonly name: string, private declaration: PluginContributions | undefined, private changed: () => void) {}
  private requireRegistration() { if (!this.registering || this.disposed) throw new Error('界面扩展注册作用域已关闭。') }
  registerPoint(id: string, menu = false) {
    this.requireRegistration()
    const point = menu ? this.declaration?.menuPoints?.find(p => p.id === id) : this.declaration?.uiPoints?.find(p => p.id === id)
    if (!point || this.points.has(id)) throw new Error('界面扩展位置未声明或重复。')
    this.points.set(id, { ...structuredClone(point), kind: menu ? 'menu' : (point as PluginUiPoint).kind })
  }
  registerItem(id: string, definition: { component: Component; when?: (context: PluginMenuContext) => boolean }) {
    this.requireRegistration()
    const declaration = this.declaration?.uiItems?.find(item => item.id === id)
    if (!declaration || this.entries.has(id) || !definition.component || !['object', 'function'].includes(typeof definition.component) || (definition.when !== undefined && typeof definition.when !== 'function')) throw new Error('界面内容未声明、重复或无效。')
    this.entries.set(id, { declaration: structuredClone(declaration), component: markRaw(definition.component), when: definition.when })
  }
  seal() {
    if (this.declaration?.uiPoints?.some(p => !this.points.has(p.id)) || this.declaration?.uiItems?.some(m => !this.entries.has(m.id))) throw new Error('未注册全部声明的界面能力。')
    this.registering = false
  }
  dispose() { this.disposed = true; this.registering = false; this.changed() }
}
interface Instance {
  owner: PluginUiScope; point: Point; info: PluginUiInstanceInfo
  valid: () => boolean; activate: (key: string) => void
}
export class PluginUiRegistry {
  readonly revision = ref(0)
  private scopes = new Map<string, PluginUiScope>()
  private instances = new Map<string, Instance>()
  private nextId = 0
  constructor(private available: () => boolean = () => true) {}
  private changed = () => { this.revision.value++ }
  createScope(plugin: string, name: string, declaration?: PluginContributions) { return new PluginUiScope(plugin, name, declaration, this.changed) }
  publish(scopes: PluginUiScope[]) {
    const next = new Map(scopes.map(scope => [scope.plugin, scope]))
    if (next.size !== scopes.length || scopes.some(scope => scope.disposed || scope.registering)) throw new Error('界面扩展发布状态无效。')
    this.scopes = next
    for (const [id, instance] of this.instances) if (this.scopes.get(instance.owner.plugin) !== instance.owner) this.instances.delete(id)
    this.changed()
  }
  private info(scope: PluginUiScope, point: Point): PluginUiPointInfo { return { plugin: scope.plugin, pluginName: scope.name, point: point.id, title: point.title, description: point.description, fields: structuredClone(point.fields), version: point.version, kind: point.kind } }
  private matches(info: PluginUiPointInfo, query: PluginUiQuery) { return (!query.plugin || info.plugin === query.plugin) && (!query.point || info.point === query.point) && (!query.kind || info.kind === query.kind) }
  listPoints(query: PluginUiQuery = {}): readonly PluginUiPointInfo[] {
    this.revision.value
    return [...this.scopes.values()].filter(scope => !scope.disposed).flatMap(scope => [...scope.points.values()].filter(point => point.public).map(point => Object.freeze(this.info(scope, point)))).filter(point => this.matches(point, query))
  }
  find(query: PluginUiQuery = {}): readonly PluginUiInstanceInfo[] {
    this.revision.value
    return [...this.instances.values()].filter(instance => instance.point.public && instance.valid() && this.matches(instance.info, query)).map(instance => Object.freeze({ ...instance.info, fields: structuredClone(instance.info.fields), context: Object.freeze({ ...instance.info.context }) }))
  }
  mount(plugin: string, pointId: string, getContext: () => unknown, isCurrent: () => boolean, activate: (key: string) => void) {
    const owner = this.scopes.get(plugin), point = owner?.points.get(pointId)
    if (!owner || !point || owner.disposed) throw new Error('界面扩展位置未启用。')
    if (this.instances.size >= 128) throw new Error('公开界面实例数量超限。')
    const context = parsePluginMenuContext(point, getContext()), signature = JSON.stringify(context), id = plugin + '/' + pointId + '#' + ++this.nextId
    let disposed = false
    const valid = () => { try { return !disposed && this.available() && !owner.disposed && this.scopes.get(plugin) === owner && isCurrent() && JSON.stringify(parsePluginMenuContext(point, getContext())) === signature } catch { return false } }
    const instance: Instance = { owner, point, info: { ...this.info(owner, point), id, context }, valid, activate }
    this.instances.set(id, instance); this.changed()
    return { id, context, kind: point.kind, valid, items: () => this.items(instance), dispose: () => { if (disposed) return; disposed = true; this.instances.delete(id); this.changed() } }
  }
  private items(instance: Instance): UiContributionView[] {
    this.revision.value
    if (!instance.valid()) return []
    const items: { view: UiContributionView; order: number }[] = []
    for (const scope of this.scopes.values()) for (const entry of scope.entries.values()) {
      const d = entry.declaration
      if (!instance.point.public && scope !== instance.owner) continue
      if (scope.disposed || d.target.plugin !== instance.owner.plugin || d.target.point !== instance.point.id || d.target.version !== instance.point.version) continue
      try { if (entry.when && entry.when(Object.freeze({ ...instance.info.context })) !== true) continue } catch { continue }
      items.push({ order: d.order, view: { key: scope.plugin + '/' + d.id, title: d.title, plugin: scope.plugin, pluginName: scope.name, component: entry.component, scope } })
    }
    return items.sort((a, b) => a.order - b.order || a.view.key.localeCompare(b.view.key)).map(item => item.view)
  }
  activate(caller: PluginUiScope, instanceId: string, itemId: string) {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.point.kind !== 'tabs' || !instance.valid() || caller.disposed || this.scopes.get(caller.plugin) !== caller) return false
    if (!instance.point.public && caller !== instance.owner) return false
    const key = caller.plugin + '/' + itemId
    if (!this.items(instance).some(item => item.key === key)) return false
    instance.activate(key); return true
  }
}
let available = () => true
export function setUiAvailability(check: () => boolean) { available = check }
export const pluginUi = new PluginUiRegistry(() => available())
