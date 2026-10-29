import { Service, type Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import { threadId } from 'node:worker_threads'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutomationTool, PluginManifest, ServiceCapability, InstalledPlugin, PluginState } from '@webnav/shared'
import * as shared from '@webnav/shared'
import { AppError } from '../core/errors.ts'
import { releaseFile } from './git.ts'
import { PluginManager } from './manager.ts'
import { PluginScope, ServiceBridge, bounded } from './lifecycle.ts'
import { PluginInteropRegistry, validateInteropDeclarations, type PluginInteropApi, type InteropUnit } from './interop.ts'
import { activateDedicated } from './worker-host.ts'

export interface PluginRpc { mutate: boolean; /** Permits read-only inspection or finishing existing work during maintenance. New resource leases remain blocked. */ maintenance?: 'read' | 'finish'; handler: (owner: string, params: Record<string, unknown>) => unknown }
export interface AutomationCall { clientId:string; signal:AbortSignal }
export type AutomationHandler = (params:Record<string,unknown>,call:AutomationCall)=>unknown
export interface PluginBackendApi {
  apiVersion: 1; manifest: PluginManifest; config: InstalledPlugin['config']; dataDirectory: string
  shared: typeof shared
  interop: PluginInteropApi
  registerService(name: ServiceCapability, implementation: object): void
  registerRpc(name: string, rpc: PluginRpc): void
  registerAutomationTool(id:string,handler:AutomationHandler):void
  registerConnector(type: string, handler: (owner: string, serverId: string, connectionId: string) => unknown): void
  onDispose(cleanup: () => void | Promise<void>): void
  beforeUnload(check: () => string | undefined | Promise<string | undefined>): void
  /** Asynchronous host access works in both shared and dedicated Workers. */
  host: {
    vaultStatus(): Promise<{ unlocked: boolean }>
    acquireResource(): Promise<() => void>
  }
}
type Unit = { plugin: InstalledPlugin; signature: string; scope: PluginScope; interop: InteropUnit; services: Map<ServiceCapability, object>; rpc: Map<string, PluginRpc>; automation:Map<string,AutomationHandler>; threadId: number }
type Slot = { builtin: (ctx: Context) => void; bridge: ServiceBridge; scope: PluginScope; owner: string }
const serviceName = (name: string) => name === 'rdp' ? 'rdpLocal' : name
const requiredMethods: Record<ServiceCapability, string[]> = {
  sessions: ['create', 'attach', 'owned', 'directory', 'control', 'input', 'hostKey', 'close', 'closeOwned', 'closeAttached', 'register'],
  desktops: ['register', 'create', 'attach', 'input', 'control', 'closeOwned', 'closeAttached'],
  freeRdp: [], rdp: [], terminalHistory: ['open', 'append', 'close', 'list', 'range', 'page'],
  terminalThemes: ['snapshot', 'subscribe', 'save'], webBookmarks: ['snapshot', 'subscribe', 'save', 'remove', 'refresh', 'thumbnail', 'reveal'],
  sshInspector: ['system', 'files'], sshFiles: ['directory', 'readText', 'saveText'], remoteEditor: ['prepare', 'status', 'install', 'stopOwned'],
  taskManager: ['start', 'status', 'install', 'hostKeyDecision', 'snapshot', 'details', 'prepareAction', 'applyAction', 'close', 'closeOwner', 'hasResources'],
  local: [], adb: [], wdb: [], configSync: ['status', 'subscribe', 'configure', 'check', 'unlock', 'lock', 'preview', 'apply', 'recover', 'history', 'rotate', 'confirmBinding'],
}
declare module 'cordis' { interface Context { plugins: PluginService } }
export class PluginService extends Service {
  static inject = ['connectors', 'storage', 'credentials', 'auth']
  readonly manager: PluginManager
  readonly rpc = new Map<string, PluginRpc>()
  readonly served = new Map<string, InstalledPlugin>()
  readonly interop = new PluginInteropRegistry()
  private slots = new Map<ServiceCapability, Slot>()
  private units = new Map<string, Unit>()
  get activity() { return [...this.slots.values()].some(slot => slot.bridge.pending > 0) }
  get resourceCount() { return [...new Set([...this.slots.values()].map(s => s.scope).concat([...this.units.values()].map(u => u.scope)))].reduce((n, scope) => n + scope.resources, 0) }
  private listeners = new Set<() => void>()
  private serial: Promise<void> = Promise.resolve()
  private failed = new Map<string, number>()
  private cleanupPending = new Set<string>()
  private stopping = false
  private closing?: Promise<void>
  constructor(ctx: Context, config: { manager: PluginManager }) {
    super(ctx, 'plugins', true); this.manager = config.manager
    ctx.on('dispose', () => this.close())
  }
  close() {
    return this.closing ??= (async () => {
      this.stopping = true; this.manager.onChange = undefined; await this.serial
      this.interop.commit(new Set(this.units.keys()), [])
      const scopes = new Set([...this.units.values()].map(unit => unit.scope).concat([...this.slots.values()].reverse().map(slot => slot.scope)))
      const failures: unknown[] = []
      for (const scope of scopes) { try { await scope.dispose() } catch (error) { failures.push(error) } }
      await this.manager.close(); this.listeners.clear()
      if (failures.length) throw new AppError('PLUGIN_CLEANUP', '部分插件未完成资源回收，停止结果需要核对。')
    })()
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  requireAvailable(name: ServiceCapability) {
    const slot = this.slots.get(name)
    const next = this.manager.registry.providers['service:' + name]
    for (const pending of this.manager.pending.values()) {
      if (pending.kind === 'waiting' && (pending.id === slot?.owner || pending.id === next)) throw new AppError('PLUGIN_WAITING', pending.reason)
    }
  }
  private publish() { for (const listener of this.listeners) listener() }
  notifyRuntime() { this.publish() }
  private signature(plugin: InstalledPlugin) { return JSON.stringify([plugin.commit, plugin.config, Object.entries(this.manager.registry.providers).filter(([, id]) => id === plugin.manifest.id).sort()]) }
  private async builtin(name: ServiceCapability, factory: (ctx: Context) => void) {
    const scope = new PluginScope(this.ctx), isolated = scope.ctx.isolate(serviceName(name))
    try {
      factory(isolated)
      const service: unknown = isolated.get(serviceName(name))
      if (!service || typeof service !== 'object') throw new Error(`内置 ${name} 未能启动。`)
      const ready: unknown = Reflect.get(service, 'ready')
      if (ready instanceof Promise) await bounded(ready, 15000, `内置 ${name} 启动超时。`)
      return { scope, service }
    } catch (error) { await scope.dispose(); throw error }
  }
  private recordRuntime(name: ServiceCapability, service: object) {
    const value: unknown = Reflect.get(service, 'runtime')
    if (value && typeof value === 'object' && 'backend' in value && (value.backend === 'dedicated' || value.backend === 'shared') && 'threadId' in value && Number.isSafeInteger(value.threadId)) {
      this.manager.runtimes.set('builtin.' + name, { backend: value.backend, threadId: Number(value.threadId) })
    }
  }
  async provide(name: ServiceCapability, factory: (ctx: Context) => void) {
    const created = await this.builtin(name, factory), bridge = new ServiceBridge()
    bridge.swap(created.service); created.scope.connect()
    this.ctx.set(serviceName(name), bridge.proxy)
    this.slots.set(name, { builtin: factory, bridge, scope: created.scope, owner: 'builtin.' + name })
    this.manager.runningProviders['service:' + name] = 'builtin.' + name
    this.recordRuntime(name, created.service)
  }
  async load() {
    await this.reconcile(true)
    this.manager.onChange = async () => { await this.reconcile(); this.publish() }
    const timer = setInterval(() => { if ([...this.manager.pending.values()].some(p => p.kind === 'waiting')) void this.reconcile() }, 1000)
    timer.unref(); this.ctx.on('dispose', () => clearInterval(timer))
  }
  private async stage(plugin: InstalledPlugin): Promise<Unit> {
    const scope = new PluginScope(this.ctx), id = plugin.manifest.id
    const unit: Unit = { plugin, signature: this.signature(plugin), scope, interop: this.interop.create(plugin.manifest, scope), services: new Map(), rpc: new Map(), automation:new Map(), threadId }, implementations = new Map<ServiceCapability, object>()
    let registering = true
    const requireRegistration = () => { scope.requireActive(); if (!registering) throw new Error('插件注册阶段已经结束。') }
    try {
      if (plugin.source === 'bundled' && this.manager.invalidBundledReleases.has(id + '/' + plugin.commit)) throw new Error('随附插件缓存校验失败，已停止加载，请修复安装文件。')
      const issues = await this.manager.compatibility(plugin.manifest)
      if (issues.length) throw new Error(issues.join('\n'))
      const dataDirectory = join(this.manager.root, 'data', id); await mkdir(dataDirectory, { recursive: true })
      if (plugin.manifest.backend) {
        const entry = plugin.manifest.backend
        await bounded((async () => {
        const api: PluginBackendApi = {
          apiVersion: 1, manifest: structuredClone(plugin.manifest), config: structuredClone(plugin.config), dataDirectory, shared, interop: this.interop.api(unit.interop),
          host: { vaultStatus: async () => ({ unlocked: scope.ctx.credentials.status().unlocked }), acquireResource: async () => { if (scope.resources >= 64) throw new AppError('LIMIT_EXCEEDED', '插件资源租约超限。'); return scope.acquire(true) } },
          registerService: (name, implementation) => {
            requireRegistration()
            if (!plugin.manifest.capabilities.some(c => c.id === 'service:' + name) || implementations.has(name) || !implementation || typeof implementation !== 'object' || Array.isArray(implementation)) throw new Error('服务注册需要当前接口的实现对象，且必须与能力声明一致。')
            implementations.set(name, implementation)
          },
          registerRpc: (name, definition) => {
            requireRegistration()
            if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(name) || unit.rpc.has(name) || typeof definition.mutate !== 'boolean' || typeof definition.handler !== 'function') throw new Error('RPC 注册无效。')
            if (definition.maintenance !== undefined && (!['read', 'finish'].includes(definition.maintenance) || (definition.maintenance === 'read' && definition.mutate))) throw new Error('RPC 维护期间行为声明无效。')
            unit.rpc.set(name, { ...definition, handler: (owner, params) => scope.track(() => this.interop.run(owner, () => definition.handler(owner, params))) })
          },
          registerAutomationTool:(name,handler)=>{
            requireRegistration()
            const tool=plugin.manifest.automation?.tools.find(t=>t.id===name)
            if(!tool||unit.automation.has(name)||typeof handler!=='function')throw new Error('自动化工具注册与声明不一致。')
            unit.automation.set(name,(params,call)=>scope.track(()=>handler(params,call)))
          },
          registerConnector: (type, handler) => {
            requireRegistration()
            if (!plugin.manifest.capabilities.some(c => c.id === 'connector:' + type) || typeof handler !== 'function') throw new Error('连接器与能力声明不一致。')
            scope.ctx.connectors.register(type, (owner, serverId, connectionId) => scope.track(() => handler(owner, serverId, connectionId)), id)
          },
          onDispose: cleanup => scope.onDispose(cleanup), beforeUnload: check => { scope.requireActive(); scope.beforeUnload = check },
        }
        const file = await releaseFile(this.manager.path(plugin), entry)
        if (plugin.manifest.execution?.backend === 'dedicated') {
          unit.threadId = await activateDedicated(file, api, scope, this.interop, error => {
            if (this.units.get(id) !== unit) return
            unit.scope.draining = true
            for (const name of this.rpc.keys()) if (name.startsWith(`plugin.${id}.`)) this.rpc.delete(name)
            this.interop.commit(new Set([id]), [])
            this.units.delete(id); this.manager.running.delete(id); this.manager.runtimes.delete(id)
            for (const [capability, provider] of Object.entries(this.manager.runningProviders)) if (provider === id) delete this.manager.runningProviders[capability]
            this.ctx.connectors.configure(this.manager.runningProviders)
            this.manager.errors.set(id, error.message)
            this.manager.pending.set(id, { id, kind: 'error', reason: error.message })
            this.failed.set(id, this.manager.registry.revision)
            void scope.dispose().catch(() => { this.cleanupPending.add(id) })
            this.manager.runtimeRevision++; this.publish()
          })
        } else {
          const module: unknown = await import(pathToFileURL(file).href)
          scope.requireActive()
          const activate = (module as { activate?: unknown }).activate
          if (typeof activate !== 'function') throw new Error('后端入口必须导出 activate(api)。')
          await activate(api)
        }
        })(), 15000, '插件导入或启动超时，原实现继续运行。')
      }
      for (const cap of plugin.manifest.capabilities) if (cap.id.startsWith('service:') && !implementations.has(cap.id.slice(8) as ServiceCapability)) throw new Error(`未注册已声明的 ${cap.id}。`)
      for (const [name, service] of implementations) if (this.manager.registry.providers['service:' + name] === id) {
        if (!service || requiredMethods[name].some(key => typeof Reflect.get(service, key) !== 'function')) throw new Error(`插件未完整实现 ${name} v1 服务。`)
        if ((name === 'sessions' || name === 'desktops') && (!Number.isSafeInteger(Reflect.get(service, 'size')) || Reflect.get(service, 'size') < 0)) throw new Error(`插件必须提供 ${name}.size 活动会话计数。`)
        if (name === 'taskManager' && ['size', 'sizeRemote'].some(key => !Number.isSafeInteger(Reflect.get(service, key)) || Reflect.get(service, key) < 0)) throw new Error('插件必须提供任务管理器活动数量。')
        unit.services.set(name, service)
      }
      return unit
    } catch (error) { await scope.dispose(); throw error }
    finally { registering = false; this.interop.seal(unit.interop) }
  }
  private async waiting(ids: Set<string>, names: ServiceCapability[]) {
    if(names.some(name=>this.slots.get(name)?.scope.resources))return 'AI 任务仍在使用相关能力，结束后自动切换。'
    for (const id of ids) { const scope = this.units.get(id)?.scope; if (scope?.resources) return '插件仍有任务或连接正在使用，结束后自动生效。'; const reason = await scope?.beforeUnload?.(); if (reason) return reason }
    if (names.some(name => this.slots.get(name)!.bridge.pending)) return '正在处理请求，完成后自动生效。'
    if (names.some(name => ['sessions', 'terminalHistory', 'sshInspector', 'sshFiles', 'remoteEditor', 'local'].includes(name)) && this.ctx.get('sessions')!.size) return 'SSH 或本地终端仍在使用，关闭相关连接后自动生效。'
    if (names.some(name => ['desktops', 'freeRdp'].includes(name)) && (this.ctx.get('desktops')!.size || this.ctx.get('deviceSessions')!.size)) return '桌面连接仍在使用，关闭后自动生效。'
    if (names.some(name => ['adb', 'wdb'].includes(name)) && this.ctx.get('deviceSessions')!.size) return '设备连接仍在使用，关闭后自动生效。'
    if (names.includes('webBookmarks') && this.ctx.get('webBookmarks')!.activity) return '网页截图仍在生成，完成后自动生效。'
    if (names.includes('taskManager') && this.ctx.get('taskManager')?.hasResources()) return '任务管理器仍在采集或安装，关闭对应视图后自动生效。'
    if (names.includes('configSync')) { const status = this.ctx.get('configSync')!.status(); if (status.busy || status.unlocked) return '配置同步正在使用，锁定同步后自动生效。' }
    if ([...ids].some(id => this.units.get(id)?.plugin.manifest.capabilities.some(cap => cap.id.startsWith('connector:'))) && (this.ctx.get('sessions')!.size || this.ctx.get('desktops')!.size || this.ctx.get('deviceSessions')!.size)) return '连接器仍可能被活动连接使用，连接结束后自动生效。'
  }
  reconcile(boot = false): Promise<void> {
    const next = this.serial.then(() => this.applyChanges(boot)).catch(error => { this.manager.pending.set('runtime', { id: 'runtime', kind: 'restart', reason: error instanceof Error ? error.message : '插件运行时异常，请重启。' }); this.publish() })
    this.serial = next; return next
  }
  private async applyChanges(boot: boolean) {
    if (this.stopping) return
    const manager = this.manager, before = JSON.stringify([...manager.pending.values()]), revision = manager.runtimeRevision
    const desired = new Map(manager.registry.installed.filter(p => p.enabled && !p.manifest.theme && !manager.safeMode).map(p => [p.manifest.id, p]))
    const changed = new Set([...desired.keys(), ...this.units.keys()].filter(id => !desired.has(id) || !this.units.has(id) || this.signature(desired.get(id)!) !== this.units.get(id)!.signature))
    const allIds = new Set([...desired.keys(), ...this.units.keys()])
    const manifests = (id: string) => [desired.get(id)?.manifest, this.units.get(id)?.plugin.manifest].filter((m): m is PluginManifest => !!m)
    const interopLinked = (a: PluginManifest, b: PluginManifest) => a.interop?.requires.some(r => b.interop?.provides.some(p => p.id === r.id && p.version === r.version && (!r.provider || r.provider === b.id)))
    const linked = (a: string, b: string) => manifests(a).some(x => manifests(b).some(y => x.dependencies?.[b] || y.dependencies?.[a] || interopLinked(x, y) || interopLinked(y, x) || x.capabilities.some(c => y.capabilities.some(d => c.id === d.id))))
    for (const id of [...manager.pending.keys()]) if (!changed.has(id) && !this.cleanupPending.has(id)) manager.pending.delete(id)
    while (changed.size) {
      const ids = new Set([changed.values().next().value!]); let grew = true
      while (grew) { grew = false; for (const id of allIds) if (!ids.has(id) && [...ids].some(other => linked(id, other))) { ids.add(id); grew = true } }
      for (const id of ids) changed.delete(id)
      const names = [...this.slots].filter(([name, slot]) => ids.has(slot.owner) || ids.has(manager.registry.providers['service:' + name] ?? '')).map(([name]) => name)
      const mark = (kind: PluginState['pending'][number]['kind'], reason: string) => { for (const id of ids) manager.pending.set(id, { id, kind, reason }) }
      const restart = [...ids].flatMap(manifests).find(manifest => manifest.reload === 'restart')
      if (!boot && restart) { mark('restart', restart.reloadReason ?? `${restart.name} 声明需要重启，已保存设置，当前实现继续运行。`); continue }
      if (!boot && [...ids].some(id => this.failed.get(id) === manager.registry.revision)) continue
      let waiting: string | undefined
      try { waiting = boot ? undefined : await this.waiting(ids, names) }
      catch (error) {
        const reason = error instanceof Error ? error.message : '插件收尾检查失败。'
        mark('error', reason)
        for (const id of ids) { manager.errors.set(id, reason); this.failed.set(id, manager.registry.revision) }
        continue
      }
      if (waiting) { mark('waiting', waiting); continue }
      const candidates = new Map<string, Unit>(), replacements = new Map<ServiceCapability, { service: object; scope: PluginScope; owner: string }>()
      const previous = new Map(names.map(name => { const slot = this.slots.get(name)!; return [name, { service: slot.bridge.current!, scope: slot.scope, owner: slot.owner }] }))
      const oldUnits = [...ids].map(id => this.units.get(id)).filter((unit): unit is Unit => !!unit)
      let switched = false
      try {
        const pending = [...ids].map(id => desired.get(id)).filter((p): p is InstalledPlugin => !!p)
        validateInteropDeclarations([...this.units].filter(([id]) => !ids.has(id)).map(([, unit]) => unit.plugin.manifest).concat(pending.map(p => p.manifest)))
        while (pending.length) {
          const index = pending.findIndex(p => Object.keys(p.manifest.dependencies ?? {}).every(id => !pending.some(other => other.manifest.id === id)))
          if (index < 0) throw new Error('插件依赖存在循环。')
          const plugin = pending.splice(index, 1)[0]!
          for (const dep of Object.keys(plugin.manifest.dependencies ?? {})) if (!candidates.has(dep) && !this.units.has(dep)) throw new Error(`依赖 ${dep} 尚未运行。`)
          candidates.set(plugin.manifest.id, await this.stage(plugin))
        }
        for (const name of names) {
          const owner = manager.registry.providers['service:' + name], unit = owner ? candidates.get(owner) : undefined
          if (owner && !unit?.services.has(name)) throw new Error(`未找到 ${name} 的新实现。`)
          if (unit) replacements.set(name, { service: unit.services.get(name)!, scope: unit.scope, owner: owner! })
          else { const created = await this.builtin(name, this.slots.get(name)!.builtin); replacements.set(name, { ...created, owner: 'builtin.' + name }) }
        }
        this.interop.validate(ids, [...candidates.values()].map(unit => unit.interop))
        const late = boot ? undefined : await this.waiting(ids, names)
        if (late) { mark('waiting', late); continue }
        for (const unit of oldUnits) unit.scope.disconnect()
        for (const old of previous.values()) if (old.owner.startsWith('builtin.')) old.scope.disconnect()
        switched = true
        for (const [name, replacement] of replacements) this.slots.get(name)!.bridge.swap(replacement.service)
        for (const scope of new Set([...candidates.values()].map(unit => unit.scope).concat([...replacements.values()].map(p => p.scope)))) scope.connect()
        for (const [name, replacement] of replacements) { const slot = this.slots.get(name)!; slot.scope = replacement.scope; slot.owner = replacement.owner; manager.runningProviders['service:' + name] = replacement.owner; if (replacement.owner.startsWith('builtin.')) this.recordRuntime(name, replacement.service) }
        for (const id of ids) {
          for (const method of this.rpc.keys()) if (method.startsWith(`plugin.${id}.`)) this.rpc.delete(method)
          this.units.delete(id); manager.running.delete(id); manager.runtimes.delete(id); manager.errors.delete(id); manager.pending.delete(id)
          for (const [cap, owner] of Object.entries(manager.runningProviders)) if (cap.startsWith('connector:') && owner === id) delete manager.runningProviders[cap]
        }
        for (const [id, unit] of candidates) {
          this.units.set(id, unit); manager.running.set(id, unit.plugin); this.served.set(id + '/' + unit.plugin.commit, unit.plugin)
          if (unit.plugin.manifest.backend) manager.runtimes.set(id, { backend: unit.plugin.manifest.execution?.backend ?? 'shared', threadId: unit.threadId })
          for (const [name, rpc] of unit.rpc) this.rpc.set(`plugin.${id}.${name}`, rpc)
          for (const cap of unit.plugin.manifest.capabilities) if (cap.id.startsWith('connector:') && manager.registry.providers[cap.id] === id) manager.runningProviders[cap.id] = id
        }
        this.interop.commit(ids, [...candidates.values()].map(unit => unit.interop))
        this.ctx.connectors.configure(manager.runningProviders); manager.runtimeRevision++
        for (const name of names) this.slots.get(name)!.bridge.notify()
        const oldScopes = new Set(oldUnits.map(unit => unit.scope).concat([...previous.values()].filter(p => p.owner.startsWith('builtin.')).map(p => p.scope)))
        for (const scope of oldScopes) { try { await scope.dispose() } catch { for(const id of ids)this.cleanupPending.add(id); mark('restart', '新版本已生效，但旧插件清理失败，请重启完成资源回收。') } }
        candidates.clear(); replacements.clear()
      } catch (error) {
        for (const unit of candidates.values()) unit.scope.disconnect()
        for (const next of replacements.values()) next.scope.disconnect()
        if (switched) {
          for (const [name, old] of previous) this.slots.get(name)!.bridge.swap(old.service)
          for (const unit of oldUnits) unit.scope.connect()
          for (const old of previous.values()) if (old.owner.startsWith('builtin.')) old.scope.connect()
        }
        const reason = error instanceof Error ? error.message : '热更新失败，已保留原实现。'
        mark('error', reason + ' 原实现保持运行，可重试或回退。')
        for (const id of ids) { manager.errors.set(id, reason); this.failed.set(id, manager.registry.revision) }
      } finally {
        await Promise.allSettled([...new Set([...candidates.values()].map(unit => unit.scope).concat([...replacements.values()].map(p => p.scope)))].map(scope => scope.dispose()))
      }
    }
    for (const id of this.cleanupPending) manager.pending.set(id, { id, kind: 'restart', reason: '旧插件资源未能完整回收，请稍后重启完成清理。' })
    const blocked: Record<string, string> = {}
    const serviceConnections: Record<string, string[]> = {
      sessions: ['ssh', 'local'], terminalHistory: ['ssh', 'local'], sshInspector: ['ssh'], sshFiles: ['ssh'], remoteEditor: ['ssh'], local: ['local'],
      desktops: ['rdp', 'vnc', 'adb', 'wdb'], freeRdp: ['rdp'], adb: ['adb'], wdb: ['wdb'],
    }
    for (const [id, unit] of this.units) {
      unit.scope.draining = manager.pending.get(id)?.kind === 'waiting'
      if (unit.scope.draining) blocked['provider:' + id] = manager.pending.get(id)!.reason
    }
    for (const pending of manager.pending.values()) if (pending.kind === 'waiting') {
      for (const manifest of manifests(pending.id)) for (const cap of manifest.capabilities) {
        for (const type of serviceConnections[cap.id.slice(8)] ?? []) blocked['type:' + type] = pending.reason
      }
    }
    this.ctx.connectors.setPluginWaits(blocked)
    if (revision !== manager.runtimeRevision || before !== JSON.stringify([...manager.pending.values()])) this.publish()
  }
  assets() {
    const external = [...this.units.values()].map(({ plugin: p }) => ({ id: p.manifest.id, name: p.manifest.name, commit: p.commit, capabilities: p.manifest.capabilities, contributes: p.manifest.contributes, icon: `/plugins/${p.manifest.id}/${p.commit}/${p.manifest.icon}`, ...(p.manifest.frontend ? { entry: `/plugins/${p.manifest.id}/${p.commit}/${p.manifest.frontend}` } : {}), styles: (p.manifest.styles ?? []).map(path => `/plugins/${p.manifest.id}/${p.commit}/${path}`), config: p.config }))
    const builtins = this.manager.builtinDetails.filter(p => p.manifest.contributes).map(p => ({ id: p.id, name: p.name, commit: p.manifest.version, capabilities: p.manifest.capabilities, contributes: p.manifest.contributes, icon: p.iconDataUrl, builtin: true, styles: [] as string[], config: {} }))
    return [...external, ...builtins]
  }
  automationEntries():{provider:string;revision:string;definition:AutomationTool;handler:AutomationHandler}[]{
    return [...this.units.values()].flatMap(unit=>[...unit.automation].flatMap(([id,handler])=>{
      const definition=unit.plugin.manifest.automation!.tools.find(t=>t.id===id)!
      if(unit.scope.draining||(definition.binding.capability&&this.manager.runningProviders[definition.binding.capability]!==unit.plugin.manifest.id))return []
      return [{provider:unit.plugin.manifest.id,revision:unit.plugin.commit,definition,handler}]
    }))
  }
  acquireAutomation(names:ServiceCapability[],provider?:string){
    const scopes=new Set(names.map(name=>{const slot=this.slots.get(name);if(!slot)throw new AppError('PLUGIN_UNAVAILABLE','能力尚未启动。');return slot.scope}))
    if(provider&&!provider.startsWith('builtin.')&&provider!=='host'){const unit=this.units.get(provider);if(!unit)throw new AppError('PLUGIN_UNAVAILABLE','插件已经停止。');scopes.add(unit.scope)}
    const releases:(()=>void)[]=[]
    try{for(const scope of scopes)releases.push(scope.acquire(true))}catch(e){for(const release of releases)release();throw e}
    return()=>{for(const release of releases)release()}
  }
  async dispatch(owner: string, method: string, params: Record<string, unknown>) {
    if (method === 'plugins.settings') {
      const id = String(params.id), installed = this.manager.registry.installed.find(p => p.manifest.id === id), running = this.manager.running.get(id)
      const builtin = this.manager.builtinDetails.find(p => p.id === id)
      if (!installed && !builtin) throw new AppError('NOT_FOUND', '插件尚未安装。')
      const plugin = running ?? installed, manifest = plugin?.manifest ?? builtin!.manifest
      const commit = plugin?.commit ?? manifest.version
      const entry = !this.manager.safeMode && !this.manager.invalidBundledReleases.has(id + '/' + commit) && manifest.contributes?.settings?.entry
      return { id, name: manifest.name, commit, installedCommit: installed?.commit ?? commit, revision: this.manager.registry.revision, builtin: !!builtin, running: !!running || !!builtin, enabled: installed?.enabled ?? true, safeMode: this.manager.safeMode,
        fields: manifest.configFields ?? [], fonts: manifest.contributes?.fonts ?? [], config: plugin?.config ?? {},
        ...(entry ? { entry: `/plugins/${id}/${commit}/${entry}` } : {}), styles: entry ? (manifest.contributes?.settings?.styles ?? []).map(path => `/plugins/${id}/${commit}/${path}`) : [], pending: this.manager.pending.get(id) }
    }
    if (method === 'plugins.state') return this.manager.state()
    if (method === 'plugins.assets') return { revision: this.manager.runtimeRevision, assets: this.assets(), providers: { ...this.manager.runningProviders } }
    if (method === 'plugins.themes') return this.manager.registry.installed.filter(p => p.manifest.theme).map(p => ({ id: 'plugin:' + p.manifest.id, name: p.manifest.name, description: p.manifest.description, theme: { ...p.manifest.theme!, backgrounds: Object.fromEntries(Object.entries(p.manifest.theme!.backgrounds ?? {}).map(([side,path]) => [side, `/plugins/${p.manifest.id}/${p.commit}/${path}`])) } }))
    if (method === 'plugins.market') return this.manager.market(params.refresh === true)
    if (method === 'plugins.details') return this.manager.details(String(params.repository), typeof params.ref === 'string' ? params.ref : 'HEAD', params.refresh === true)
    if (method === 'plugins.prepare') return this.manager.prepare(owner, params)
    if (method === 'plugins.install') return this.manager.install(owner, params)
    if (method === 'plugins.job') return this.manager.jobStatus(owner, params)
    if (method === 'plugins.change') return this.manager.change(params)
    const rpc = this.rpc.get(method)
    if (!rpc) throw new AppError('NOT_FOUND', '插件未提供此方法。')
    return rpc.handler(owner, params)
  }
}

