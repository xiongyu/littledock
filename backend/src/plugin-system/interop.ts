import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Ajv, type ValidateFunction } from 'ajv'
import type { PluginManifest, PluginServiceContract } from '@webnav/shared'
import { AppError } from '../core/errors.ts'
import type { PluginScope } from './lifecycle.ts'

export interface PluginCallContext { caller: string; owner?: string; signal: AbortSignal }
export type PluginMethodHandler = (input: Record<string, unknown>, context: PluginCallContext) => unknown | Promise<unknown>
export interface PluginEventSnapshot { available: boolean; provider?: string; epoch?: string; revision: number; value?: Record<string, unknown> }
export interface PluginInteropApi {
  register(id: string, version: number, methods: Record<string, PluginMethodHandler>, initialState?: Record<string, Record<string, unknown>>): void
  call<T = Record<string, unknown>>(id: string, version: number, method: string, input: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>
  subscribe(id: string, version: number, event: string, listener: (snapshot: PluginEventSnapshot) => void): () => void
  publish(id: string, version: number, event: string, value: Record<string, unknown>): void
}
type Method = { handle: PluginMethodHandler; input: ValidateFunction; output: ValidateFunction; access: 'read' | 'write' | 'finish' }
type Endpoint = { declaration: PluginServiceContract; epoch: string; methods: Map<string, Method>; events: Map<string, { validate: ValidateFunction; revision: number; value: Record<string, unknown> }> }
export type InteropUnit = { id: string; manifest: PluginManifest; scope: PluginScope; endpoints: Map<string, Endpoint>; sealed: boolean; committed: boolean; publicationWindow: number; publications: number }
type Subscription = { unit: InteropUnit; id: string; version: number; event: string; listener: (snapshot: PluginEventSnapshot) => void; queued: boolean; active: boolean }
const key = (id: string, version: number) => `${id}@${version}`
export function validateInteropDeclarations(manifests: PluginManifest[]) {
  const edges = new Map<string, string[]>()
  for (const manifest of manifests) {
    const dependencies: string[] = []
    for (const requirement of manifest.interop?.requires ?? []) {
      const providers = manifests.filter(p => (!requirement.provider || requirement.provider === p.id) && p.interop?.provides.some(c => c.id === requirement.id && c.version === requirement.version))
      if (providers.length > 1) throw new AppError('PLUGIN_AMBIGUOUS', `${manifest.name} 的 ${requirement.id} 存在多个提供者，请明确指定。`)
      if (!requirement.optional) { if (!providers.length) throw new AppError('PLUGIN_DEPENDENCY', `${manifest.name} 缺少 ${requirement.id} v${requirement.version}。`); dependencies.push(providers[0]!.id) }
    }
    edges.set(manifest.id, dependencies)
  }
  const visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string) => { if (visiting.has(id)) throw new AppError('PLUGIN_DEPENDENCY', '必需服务依赖存在循环。'); if (visited.has(id)) return; visiting.add(id); for (const dep of edges.get(id) ?? []) visit(dep); visiting.delete(id); visited.add(id) }
  for (const id of edges.keys()) visit(id)
}
/** Structured JSON only, with independent finite payload and schema limits. */
function json(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_PARAMS', '插件通信需要对象。')
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { throw new AppError('INVALID_PARAMS', '插件通信数据必须可序列化。') }
  if (Buffer.byteLength(encoded) > 262144) throw new AppError('LIMIT_EXCEEDED', '插件通信数据超过 256 KiB。')
  return JSON.parse(encoded) as Record<string, unknown>
}
export class PluginInteropRegistry {
  private units = new Map<string, InteropUnit>()
  private subscriptions = new Set<Subscription>()
  private context = new AsyncLocalStorage<{ owner?: string; depth: number; signal?: AbortSignal }>()
  private ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false })
  run<T>(owner: string, callback: () => T) { return this.context.run({ owner, depth: 0 }, callback) }
  capture() { return this.context.getStore() }
  withContext<T>(context: ReturnType<PluginInteropRegistry['capture']>, callback: () => T) { return this.context.run(context ?? { depth: 0 }, callback) }
  create(manifest: PluginManifest, scope: PluginScope): InteropUnit { return { id: manifest.id, manifest, scope, endpoints: new Map(), sealed: false, committed: false, publicationWindow: 0, publications: 0 } }
  seal(unit: InteropUnit) { unit.sealed = true }
  api(unit: InteropUnit): PluginInteropApi {
    return {
      register: (id, version, handlers, initial = {}) => {
        unit.scope.requireActive()
        const declaration = unit.manifest.interop?.provides.find(c => c.id === id && c.version === version)
        if (unit.sealed || unit.committed || !declaration || unit.endpoints.has(key(id, version))) throw new Error('服务注册未声明、重复或已经结束。')
        if (Object.keys(handlers).length !== declaration.methods.length || declaration.methods.some(m => typeof handlers[m.id] !== 'function')) throw new Error('服务方法与契约不一致。')
        const methods = new Map(declaration.methods.map(m => [m.id, { handle: handlers[m.id]!, input: this.ajv.compile(m.inputSchema), output: this.ajv.compile(m.outputSchema), access: m.access }]))
        const events: Endpoint['events'] = new Map()
        for (const event of declaration.events) { const validate = this.ajv.compile(event.schema), value = json(initial[event.id]); if (!validate(value)) throw new Error('事件初始快照不符合契约。'); events.set(event.id, { validate, revision: 0, value }) }
        unit.endpoints.set(key(id, version), { declaration, epoch: randomUUID(), methods, events })
      },
      call: (id, version, method, input, options) => this.call(unit, id, version, method, input, options),
      subscribe: (id, version, event, listener) => {
        unit.scope.requireActive(); this.requirement(unit, id, version)
        if (typeof listener !== 'function' || [...this.subscriptions].filter(s => s.unit === unit).length >= 128) throw new Error('订阅无效或数量超限。')
        const subscription: Subscription = { unit, id, version, event, listener, active: true, queued: false }
        this.subscriptions.add(subscription)
        const remove = () => { subscription.active = false; this.subscriptions.delete(subscription) }
        unit.scope.onDispose(remove); this.notify(subscription); return remove
      },
      publish: (id, version, event, input) => {
        unit.scope.requireActive(); if (!unit.committed || this.units.get(unit.id) !== unit) throw new Error('服务尚未发布。')
        if (Date.now() - unit.publicationWindow >= 1000) { unit.publicationWindow = Date.now(); unit.publications = 0 }
        if (++unit.publications > 256) throw new AppError('LIMIT_EXCEEDED', '插件状态发布过于频繁。')
        const state = unit.endpoints.get(key(id, version))?.events.get(event), value = json(input)
        if (!state || !state.validate(value)) throw new AppError('INVALID_PARAMS', '事件快照不符合契约。')
        state.value = value; state.revision++
        for (const subscription of this.subscriptions) if (subscription.id === id && subscription.version === version && subscription.event === event) this.notify(subscription)
      },
    }
  }
  private requirement(unit: InteropUnit, id: string, version: number) {
    const declaration = unit.manifest.interop?.requires.find(r => r.id === id && r.version === version)
    if (!declaration) throw new AppError('PLUGIN_UNDECLARED', '插件未声明此服务依赖。')
    return declaration
  }
  private resolve(unit: InteropUnit, id: string, version: number, units = this.units) {
    const requirement = this.requirement(unit, id, version)
    const providers = [...units.values()].filter(p => (!requirement.provider || p.id === requirement.provider) && p.endpoints.has(key(id, version)))
    if (providers.length > 1) throw new AppError('PLUGIN_AMBIGUOUS', '存在多个服务提供者，请在依赖声明中指定提供者。')
    return providers[0]
  }
  validate(remove: Set<string>, add: Iterable<InteropUnit>) {
    const proposed = new Map([...this.units].filter(([id]) => !remove.has(id)))
    for (const unit of add) {
      for (const contract of unit.manifest.interop?.provides ?? []) if (!unit.endpoints.has(key(contract.id, contract.version))) throw new Error('未注册已声明的服务契约。')
      proposed.set(unit.id, unit)
    }
    for (const unit of proposed.values()) for (const dep of unit.manifest.interop?.requires ?? []) {
      if (!this.resolve(unit, dep.id, dep.version, proposed) && !dep.optional) throw new AppError('PLUGIN_DEPENDENCY', `${unit.manifest.name} 需要 ${dep.id} v${dep.version}。请先停用依赖插件，或恢复提供者。`)
    }
    const visited = new Set<string>(), visiting = new Set<string>()
    const visit = (unit: InteropUnit) => {
      if (visiting.has(unit.id)) throw new AppError('PLUGIN_DEPENDENCY', '必需服务依赖存在循环。')
      if (visited.has(unit.id)) return
      visiting.add(unit.id)
      for (const dep of unit.manifest.interop?.requires ?? []) if (!dep.optional) { const provider = this.resolve(unit, dep.id, dep.version, proposed); if (provider) visit(provider) }
      visiting.delete(unit.id); visited.add(unit.id)
    }
    for (const unit of proposed.values()) visit(unit)
  }
  commit(remove: Set<string>, add: Iterable<InteropUnit>) {
    for (const id of remove) { const old = this.units.get(id); if (old) old.committed = false; this.units.delete(id) }
    for (const unit of add) { unit.committed = true; this.units.set(unit.id, unit) }
    for (const subscription of this.subscriptions) this.notify(subscription)
  }
  private notify(subscription: Subscription) {
    if (subscription.queued || !subscription.active) return
    subscription.queued = true
    queueMicrotask(() => {
      subscription.queued = false
      if (!subscription.active || !subscription.unit.committed) return
      let snapshot: PluginEventSnapshot = { available: false, revision: 0 }
      try {
        const provider = this.resolve(subscription.unit, subscription.id, subscription.version), endpoint = provider?.endpoints.get(key(subscription.id, subscription.version)), state = endpoint?.events.get(subscription.event)
        if (provider && endpoint && state) snapshot = { available: true, provider: provider.id, epoch: endpoint.epoch, revision: state.revision, value: structuredClone(state.value) }
      } catch { /* Removal/ambiguity is represented as unavailable; callback exceptions stay local. */ }
      try { void Promise.resolve(subscription.listener(snapshot)).catch(() => {}) } catch { /* Consumer cannot break publication. */ }
    })
  }
  private async call<T>(caller: InteropUnit, id: string, version: number, name: string, input: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    caller.scope.requireActive()
    if (!caller.committed || this.units.get(caller.id) !== caller) throw new AppError('PLUGIN_UNAVAILABLE', '调用插件尚未运行。')
    const provider = this.resolve(caller, id, version), method = provider?.endpoints.get(key(id, version))?.methods.get(name)
    if (!provider || !method) throw new AppError('CAPABILITY_UNAVAILABLE', '所需服务或方法不可用。')
    const parent = this.context.getStore(), timeoutMs = options.timeoutMs ?? 15000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || (parent?.depth ?? 0) >= 8 || provider.scope.resources >= 64) throw new AppError('LIMIT_EXCEEDED', '插件调用期限、深度或并发超限。')
    const data = json(input); if (!method.input(data)) throw new AppError('INVALID_PARAMS', '插件调用参数不符合契约。')
    const controller = new AbortController(), signals = [options.signal, parent?.signal].filter((signal): signal is AbortSignal => !!signal), signal = signals.length ? AbortSignal.any(signals) : undefined
    if (signal?.aborted) throw new AppError('CANCELLED', '插件调用已取消。')
    const releaseCaller = caller.scope.acquire(method.access === 'write')
    let releaseProvider: () => void
    try { releaseProvider = provider.scope.acquire(method.access === 'write') } catch (error) { releaseCaller(); throw error }
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const task = Promise.resolve().then(() => this.context.run({ owner: parent?.owner, depth: (parent?.depth ?? 0) + 1, signal: controller.signal }, () => method.handle(data, { caller: caller.id, owner: parent?.owner, signal: controller.signal }))).then(result => {
      const output = json(result); if (!method.output(output)) throw new AppError('PLUGIN_CONTRACT', '插件返回值不符合契约。'); return output as T
    }).finally(() => { releaseProvider(); releaseCaller() })
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new AppError('CANCELLED', '调用已取消；写入结果需要核对。')), { once: true })
        timer = setTimeout(() => { reject(new AppError('TIMEOUT', '调用超时；写入结果未知，不会自动重试。')); controller.abort() }, timeoutMs)
      })])
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
}
