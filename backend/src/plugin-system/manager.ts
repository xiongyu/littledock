import { randomUUID, createHash } from 'node:crypto'
import { threadId } from 'node:worker_threads'
import type { PluginRuntime } from '@webnav/shared'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { release } from 'node:os'
import semver from 'semver'
import { PLUGIN_API_VERSION, PLUGIN_MARKET_REPOSITORY, WEBNAV_VERSION, parsePluginIndex, parsePluginManifest, pluginId, pluginRepository, serviceCapabilities, type InstalledPlugin, type PluginHost, type PluginManifest, type PluginPreview, type PluginMarket, type PluginState, type PluginCategory, type PluginBuiltin, type PluginDetails } from '@webnav/shared'
import { AppError, integer, record, string } from '../core/errors.ts'
import { fetchRepository, gitText, gitIcon, hasCommand, installStep, releaseFile, runFile, resumePluginCommands, stopPluginCommands } from './git.ts'
import { updatePreview } from './update-preview.ts'
import { loadBundledPlugins } from './bundled.ts'

interface Registry { revision: number; installed: InstalledPlugin[]; providers: Record<string, string>; retained?: InstalledPlugin[] }
interface Job { id: string; owner: string; state: 'running' | 'succeeded' | 'failed'; message: string; result?: unknown; error?: string; expires: number }
type Staged = PluginPreview & { owner: string; directory: string }
const builtinCategories: Record<string, PluginCategory> = { sessions: 'terminal', desktops: 'desktop', freeRdp: 'desktop', rdp: 'desktop', terminalHistory: 'terminal', terminalThemes: 'appearance', webBookmarks: 'bookmarks', sshInspector: 'monitoring', taskManager: 'monitoring', sshFiles: 'files', remoteEditor: 'development', local: 'terminal', adb: 'desktop', wdb: 'desktop', configSync: 'backup' }
export const builtins = [...Object.entries(serviceCapabilities).map(([id, name]) => ({ id: 'builtin.' + id, name, capability: 'service:' + id, category: builtinCategories[id]! })), { id: 'builtin.appearance', name: 'WebNav 默认主题', capability: 'theme:appearance', category: 'themes' as const }, {id:'builtin.mcp',name:'MCP 工作台接入',capability:'extension:mcp',category:'automation' as const}]
export class PluginManager {
  readonly root: string
  readonly host: PluginHost = { os: process.platform, arch: process.arch, release: release(), node: process.versions.node, webnav: WEBNAV_VERSION, apiVersion: PLUGIN_API_VERSION }
  registry: Registry = { revision: 0, installed: [], providers: {} }
  readonly running = new Map<string, InstalledPlugin>()
  readonly runtimes = new Map<string, PluginRuntime>()
  readonly errors = new Map<string, string>()
  readonly runningProviders: Record<string, string> = {}
  runtimeRevision = 0
  readonly pending = new Map<string, PluginState['pending'][number]>()
  onChange?: () => Promise<void>
  private busy = false
  get activity() { return this.busy || this.tasks.size > 0 }
  private previews = new Map<string, Staged>()
  private jobs = new Map<string, Job>()
  private cache?: PluginMarket
  readonly builtinDetails: PluginBuiltin[] = []
  readonly bundled: PluginDetails[] = []
  readonly bundledErrors: string[] = []
  readonly invalidBundledReleases = new Set<string>()
  private metadataReads = new Map<string, Promise<PluginDetails>>()
  private sourceLocks = new Map<string, Promise<string>>()
  private tasks = new Set<Promise<unknown>>()
  readonly safeMode: boolean
  readonly marketRepository: string
  private bundledDirectory?: string
  constructor(directory: string, marketRepository = PLUGIN_MARKET_REPOSITORY, safeMode = process.env.WEBNAV_DISABLE_PLUGINS === '1', bundledDirectory?: string) { this.root = join(directory, 'plugins'); this.marketRepository = marketRepository; this.safeMode = safeMode; this.bundledDirectory = bundledDirectory }
  async initialize() {
    resumePluginCommands(this.root)
    await mkdir(join(this.root, 'staging'), { recursive: true })
    await mkdir(join(this.root, 'metadata'), { recursive: true })
    for (const builtin of builtins) {
      const directory = fileURLToPath(new URL('../../plugins/' + builtin.id + '/', import.meta.url))
      const manifest = parsePluginManifest(JSON.parse(await readFile(join(directory, 'webnav.plugin.json'), 'utf8')), true)
      this.builtinDetails.push({ ...builtin, manifest, readme: await readFile(join(directory, 'README.md'), 'utf8'), iconDataUrl: 'data:image/svg+xml;base64,' + (await readFile(join(directory, manifest.icon))).toString('base64') })
    }
    try {
      const saved = record(JSON.parse(await readFile(join(this.root, 'registry.json'), 'utf8')))
      if (!Array.isArray(saved.installed)) throw new Error('registry')
      const parseInstalled = (v: unknown): InstalledPlugin => {
        const p = record(v), manifest = parsePluginManifest(p.manifest), commit = string(p.commit)
        if (!/^[a-f0-9]{40,64}$/.test(commit) || (p.previousCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(String(p.previousCommit)))) throw new Error('commit')
        if (p.source !== undefined && p.source !== 'bundled') throw new Error('source')
        const repository = p.source === 'bundled' ? 'bundled:' + manifest.id : pluginRepository(p.repository)
        if (p.source === 'bundled' && p.repository !== repository) throw new Error('bundled source')
        return { manifest, commit, repository, ...(p.source === 'bundled' ? { source: 'bundled' as const } : {}), ref: string(p.ref, 200), enabled: p.enabled === true, installedAt: integer(p.installedAt, 0, Number.MAX_SAFE_INTEGER), config: this.parseConfig(manifest, p.config ?? {}), ...(p.previousCommit ? { previousCommit: String(p.previousCommit) } : {}) }
      }
      if (saved.retained !== undefined && (!Array.isArray(saved.retained) || saved.retained.length > 1000)) throw new Error('retained')
      this.registry = { revision: integer(saved.revision, 0, Number.MAX_SAFE_INTEGER), providers: record(saved.providers) as Record<string, string>, installed: saved.installed.map(parseInstalled), retained: Array.isArray(saved.retained) ? saved.retained.map(parseInstalled) : [] }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('PLUGIN_REGISTRY_INVALID', '插件清单损坏。请保留 plugins/registry.json 备份后修复，勿删除插件数据。') }
    try { const cached = JSON.parse(await readFile(join(this.root, 'market.json'), 'utf8')) as PluginMarket; this.cache = { ...cached, index: parsePluginIndex(cached.index) } } catch { /* no valid cache */ }
    if (this.bundledDirectory) {
      const result = await loadBundledPlugins(this.bundledDirectory, join(this.root, 'releases'))
      this.bundled.push(...result.plugins); this.bundledErrors.push(...result.errors)
      for (const key of result.invalidReleases) this.invalidBundledReleases.add(key)
      const next = structuredClone(this.registry); let changed = false
      for (const bundle of this.bundled) {
        const old = next.installed.find(p => p.manifest.id === bundle.manifest.id)
        if (old && old.source !== 'bundled') continue
        if (!old && next.retained?.some(p => p.manifest.id === bundle.manifest.id)) continue
        if ((await this.compatibility(bundle.manifest, next.installed)).length) continue
        if (old?.commit === bundle.commit) continue
        if (old && old.manifest.dataVersion !== bundle.manifest.dataVersion) { this.bundledErrors.push(`${bundle.manifest.name} 数据版本改变，保留原运行包，请先完成迁移。`); continue }
        const plugin = this.bundledInstall(bundle, old)
        next.installed = [...next.installed.filter(p => p.manifest.id !== plugin.manifest.id), plugin]; changed = true
      }
      if (changed) { next.revision++; await this.save(next) }
    }
  }
  private bundledInstall(bundle: PluginDetails, previous?: InstalledPlugin): InstalledPlugin {
    const config = Object.fromEntries(Object.entries(previous?.config ?? {}).filter(([key, value]) => bundle.manifest.configFields?.some(field => field.key === key && field.type === typeof value)))
    return { manifest: bundle.manifest, repository: bundle.repository, commit: bundle.commit, ref: 'bundled', source: 'bundled', installedAt: Date.now(), enabled: previous?.enabled ?? !bundle.manifest.configFields?.some(field => field.required), config, ...(previous && previous.commit !== bundle.commit ? { previousCommit: previous.commit } : {}) }
  }
  async close() { await stopPluginCommands(this.root); await Promise.allSettled([...this.tasks, ...this.metadataReads.values(), ...this.sourceLocks.values()]) }
  path(plugin: Pick<InstalledPlugin, 'manifest' | 'commit'>) { return join(this.root, 'releases', plugin.manifest.id, plugin.commit) }
  async retainedTheme(id: string, commit: string): Promise<Pick<InstalledPlugin, 'manifest' | 'commit'> | undefined> {
    try {
      pluginId(id)
      if (!/^[a-f0-9]{40,64}$/.test(commit)) return
      const directory = join(this.root, 'releases', id, commit)
      const manifest = parsePluginManifest(JSON.parse(await readFile(await releaseFile(directory, 'webnav.plugin.json'), 'utf8')))
      if (manifest.id === id && manifest.theme) return { manifest, commit }
    } catch { /* Only a previously installed, valid static theme can supply retained assets. */ }
  }
  async compatibility(manifest: PluginManifest, installed = this.registry.installed): Promise<string[]> {
    const reasons: string[] = [], platform = manifest.platforms.find(p => p.os === this.host.os && p.arch === this.host.arch)
    if (!platform) reasons.push(`不支持当前宿主 ${this.host.os} / ${this.host.arch}。这是运行 WebNav 的电脑，与远程服务器系统无关。`)
    else if (platform.minRelease) { const current = semver.coerce(this.host.release), minimum = semver.coerce(platform.minRelease); if (!current || !minimum || semver.lt(current, minimum)) reasons.push(`需要系统版本 ${platform.minRelease} 或更新。`) }
    if (!semver.valid(manifest.version)) reasons.push('插件版本必须符合语义化版本规范。')
    if (!semver.validRange(manifest.webnav) || !semver.satisfies(this.host.webnav, manifest.webnav)) reasons.push(`需要 WebNav ${manifest.webnav}，当前 ${this.host.webnav}。`)
    if (!semver.validRange(manifest.node) || !semver.satisfies(this.host.node, manifest.node)) reasons.push(`需要 Node.js ${manifest.node}，当前 ${this.host.node}。`)
    for (const [id, range] of Object.entries(manifest.dependencies ?? {})) {
      const dependency = installed.find(p => p.manifest.id === id && p.enabled)
      if (!dependency || !semver.validRange(range) || !semver.satisfies(dependency.manifest.version, range)) reasons.push(`缺少已启用依赖 ${id} ${range}。`)
    }
    for (const command of new Set([...(manifest.commands ?? []), ...(manifest.install ?? []).map(s => s.command)])) if (!await hasCommand(command)) reasons.push(`缺少外部组件 ${command}。`)
    return reasons
  }
  async state(): Promise<PluginState> {
    const registry = this.registry
    const snapshot = { host: this.host, revision: registry.revision, runtimeRevision: this.runtimeRevision, pending: [...this.pending.values()], safeMode: this.safeMode, restartRequired: [...this.pending.values()].some(p => p.kind === 'restart'), providers: { ...registry.providers }, runningProviders: { ...this.runningProviders }, builtins: this.builtinDetails.map(builtin => ({ ...builtin, ...(!builtin.manifest.theme ? { runtime: this.runtimes.get(builtin.id) ?? (builtin.manifest.execution?.backend === 'dedicated' ? undefined : { backend: 'shared' as const, threadId }) } : {}) })) }
    const installed = await Promise.all(registry.installed.map(async p => {
      const active = this.running.get(p.manifest.id)
      const error = this.errors.get(p.manifest.id)
      return { ...p, running: active?.commit === p.commit, ...(active ? { activeRelease: { version: active.manifest.version, commit: active.commit }, runtime: this.runtimes.get(p.manifest.id) } : {}), reasons: await this.compatibility(p.manifest, registry.installed), ...(error ? { error } : {}) }
    }))
    return { ...snapshot, installed, bundled: await Promise.all(this.bundled.map(async p => ({ ...p, reasons: await this.compatibility(p.manifest) }))), bundledErrors: [...this.bundledErrors] }
  }
  private source(repository: string) { return join(this.root, 'repositories', createHash('sha256').update(repository).digest('hex')) }
  private fetch(repository: string, ref: string) {
    const previous = this.sourceLocks.get(repository) ?? Promise.resolve('')
    const promise = previous.catch(() => '').then(() => fetchRepository(repository, ref, this.source(repository)))
    this.sourceLocks.set(repository, promise)
    void promise.finally(() => { if (this.sourceLocks.get(repository) === promise) this.sourceLocks.delete(repository) }).catch(() => {})
    return promise
  }
  async details(repository: string, ref = 'HEAD', refresh = false): Promise<PluginDetails> {
    repository = pluginRepository(repository)
    const key = createHash('sha256').update(repository + '\n' + ref).digest('hex'), file = join(this.root, 'metadata', key + '.json')
    if (!refresh) {
      try { const cached = JSON.parse(await readFile(file, 'utf8')) as PluginDetails; return { ...cached, manifest: parsePluginManifest(cached.manifest), cached: true, reasons: await this.compatibility(cached.manifest) } } catch { /* first read */ }
    }
    const pending = this.metadataReads.get(key); if (pending) return pending
    const promise = (async () => {
      const commit = await this.fetch(repository, ref), directory = this.source(repository)
      const manifest = parsePluginManifest(JSON.parse(await gitText(directory, commit, 'webnav.plugin.json')))
      let readme = ''; try { readme = await gitText(directory, commit, manifest.readme ?? 'README.md') } catch { /* optional */ }
      const iconDataUrl = await gitIcon(directory, commit, manifest.icon)
      const details: PluginDetails = { manifest, repository, commit, readme, iconDataUrl, fetchedAt: Date.now(), cached: false, reasons: await this.compatibility(manifest) }
      const temp = file + '.tmp'; await writeFile(temp, JSON.stringify(details)); await rename(temp, file); return details
    })()
    this.metadataReads.set(key, promise)
    try { return await promise } finally { this.metadataReads.delete(key) }
  }
  private async save(next: Registry) {
    const target = join(this.root, 'registry.json'), temp = target + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(temp, target)
    this.registry = next
    await this.onChange?.()
  }
  private job(owner: string, message: string, run: (job: Job) => Promise<unknown>) {
    for (const [id, job] of this.jobs) if (job.expires < Date.now() && job.state !== 'running') this.jobs.delete(id)
    if (this.jobs.size >= 30 || this.busy) throw new AppError('BUSY', '正在处理插件操作，请稍后再试。')
    this.busy = true
    const job: Job = { id: randomUUID(), owner, state: 'running', message, expires: Date.now() + 3600_000 }
    this.jobs.set(job.id, job)
    const task = run(job).then(result => { job.result = result; job.state = 'succeeded'; job.message = '操作完成' }, error => { job.state = 'failed'; job.error = error instanceof Error ? error.message : '插件操作失败。' }).finally(() => { this.busy = false; this.tasks.delete(task) })
    this.tasks.add(task)
    return { jobId: job.id }
  }
  jobStatus(owner: string, params: Record<string, unknown>) { const job = this.jobs.get(string(params.jobId)); if (!job || job.owner !== owner) throw new AppError('NOT_FOUND', '插件任务不存在。'); const { owner: _owner, expires: _expires, ...publicJob } = job; return publicJob }
  prepare(owner: string, params: Record<string, unknown>) {
    const repository = pluginRepository(params.repository), ref = params.ref === undefined ? 'HEAD' : string(params.ref, 200)
    return this.job(owner, '正在读取仓库与插件说明，不执行插件代码…', async () => {
      for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id)
      if (this.previews.size >= 10) throw new AppError('BUSY', '待确认插件过多，请稍后再试。')
      const token = randomUUID(), directory = this.source(repository)
      try {
        const details = await this.details(repository, ref, true), { commit, manifest, readme, iconDataUrl } = details
        if (params.expectedId !== undefined && params.expectedId !== manifest.id) throw new AppError('PLUGIN_ID_MISMATCH', '仓库中的插件 ID 与索引不一致。')
        const old = this.registry.installed.find(p => p.manifest.id === manifest.id)
        const reasons = await this.compatibility(manifest)
        if (old && old.repository !== repository) reasons.push('此插件 ID 已由其他来源占用，请先卸载原插件。')
        if (old && old.manifest.dataVersion !== manifest.dataVersion) reasons.push('插件数据格式改变。请先由作者提供数据迁移工具、备份并迁移；当前版本不自动改写数据。')
        for (const [capability, provider] of Object.entries(this.registry.providers)) if (provider === manifest.id && !manifest.capabilities.some(c => c.id === capability)) reasons.push(`更新移除了正在使用的 ${capability}，请先恢复内置或选择其他提供者。`)
        const candidates = [...this.registry.installed.filter(p => p.manifest.id !== manifest.id), { manifest, enabled: old?.enabled ?? false } as InstalledPlugin]
        for (const dependent of candidates.filter(p => p.enabled && p.manifest.dependencies?.[manifest.id])) if (!semver.satisfies(manifest.version, dependent.manifest.dependencies![manifest.id]!)) reasons.push(`升级将破坏 ${dependent.manifest.name} 的依赖。`)
        const preview: Staged = { token, owner, directory, manifest, repository, commit, ref, compatible: !reasons.length, reasons, readme, iconDataUrl, expiresAt: Date.now() + 900_000, upgrading: !!old, registryRevision: this.registry.revision, ...updatePreview(manifest, commit, old) }
        this.previews.set(token, preview)
        const { owner: _owner, directory: _directory, ...result } = preview
        return result
      } catch (error) { throw error }
    })
  }
  install(owner: string, params: Record<string, unknown>) {
    const preview = this.previews.get(string(params.token)), revision = integer(params.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
    if (params.acceptRisk !== true) throw new AppError('RISK_NOT_ACCEPTED', '请先阅读并确认插件风险。')
    if (!preview || preview.owner !== owner || preview.expiresAt < Date.now() || params.commit !== preview.commit) throw new AppError('PREVIEW_EXPIRED', '插件预览已失效或提交不一致，请重新读取。')
    if (revision !== this.registry.revision || preview.registryRevision !== revision) throw new AppError('REVISION_CONFLICT', '插件配置已变化，请重新读取安装说明并确认。')
    return this.job(owner, '正在安装已确认的提交…', async job => {
      const reasons = [...preview.reasons, ...await this.compatibility(preview.manifest)]
      if (reasons.length) throw new AppError('PLUGIN_INCOMPATIBLE', [...new Set(reasons)].join('\n'))
      const old = this.registry.installed.find(p => p.manifest.id === preview.manifest.id)
      const retained = this.registry.retained?.find(p => p.manifest.id === preview.manifest.id && p.repository === preview.repository && p.manifest.dataVersion === preview.manifest.dataVersion)
      if (old?.commit === preview.commit) return this.state()
      const target = this.path(preview), temporary = target + '.' + randomUUID() + '.tmp'
      await mkdir(temporary, { recursive: true })
      try {
        // No checkout, filter or lifecycle code ran during preview. Consent pins this commit.
        await runFile('git', ['--git-dir=' + preview.directory, '--work-tree=' + temporary, '-c', 'core.hooksPath=', 'checkout', '--force', preview.commit, '--', '.'], preview.directory, 120_000, true)
        for (const step of preview.manifest.install ?? []) { job.message = '正在运行插件声明的安装步骤…'; await installStep(step.command, step.args, temporary) }
        const manifest = parsePluginManifest(JSON.parse(await readFile(await releaseFile(temporary, 'webnav.plugin.json'), 'utf8')))
        if (JSON.stringify(manifest) !== JSON.stringify(preview.manifest)) throw new AppError('PLUGIN_CHANGED', '安装步骤修改了插件声明，请作者修正后重新安装。')
        for (const path of [manifest.backend, manifest.frontend, manifest.contributes?.settings?.entry, manifest.icon, ...(manifest.styles ?? []), ...(manifest.contributes?.settings?.styles ?? []), ...(manifest.contributes?.tools.map(tool => tool.icon) ?? []), ...Object.values(manifest.theme?.backgrounds ?? {})].filter((p): p is string => !!p)) await releaseFile(temporary, path)
        // A previously installed immutable release can be reused (rollback / reinstall).
        try { await rename(temporary, target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; const existing = parsePluginManifest(JSON.parse(await readFile(join(target, 'webnav.plugin.json'), 'utf8'))); if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw error; await rm(temporary, { recursive: true, force: true }) }
        const reusable = Object.fromEntries(Object.entries(retained?.config ?? {}).filter(([key, value]) => manifest.configFields?.some(field => field.key === key && field.type === typeof value)))
        const plugin: InstalledPlugin = { manifest, repository: preview.repository, ref: preview.ref, commit: preview.commit, installedAt: Date.now(), enabled: old?.enabled ?? (!manifest.theme && !manifest.configFields?.some(field => field.required)), config: this.parseConfig(manifest, old?.config ?? reusable), ...(old ? { previousCommit: old.commit } : {}) }
        await this.save({ revision: revision + 1, providers: { ...this.registry.providers }, retained: this.registry.retained?.filter(p => p.manifest.id !== manifest.id), installed: [...this.registry.installed.filter(p => p.manifest.id !== manifest.id), plugin] })
        this.previews.delete(preview.token)
        return this.state()
      } finally { await rm(temporary, { recursive: true, force: true }) }
    })
  }
  private parseConfig(manifest: PluginManifest, input: unknown) {
    const values = record(input), fields = manifest.configFields ?? [], output: InstalledPlugin['config'] = {}
    for (const [key, value] of Object.entries(values)) {
      const field = fields.find(f => f.key === key)
      if (!field || typeof value !== field.type || (typeof value === 'string' && value.length > 4096) || (typeof value === 'number' && !Number.isFinite(value))) throw new AppError('INVALID_ARGUMENT', '插件配置不符合声明的字段。')
      output[key] = value as string | number | boolean
    }
    return output
  }
  async change(params: Record<string, unknown>) {
    if (this.busy) throw new AppError('BUSY', '插件任务尚未完成。')
    const revision = integer(params.expectedRevision, 0, Number.MAX_SAFE_INTEGER)
    if (revision !== this.registry.revision) throw new AppError('REVISION_CONFLICT', '插件配置已改变，请刷新。')
    this.busy = true
    try {
      const next = structuredClone(this.registry), id = string(params.id), action = string(params.action)
      const p = next.installed.find(p => p.manifest.id === id), builtin = builtins.find(b => b.id === id), bundle = this.bundled.find(p => p.manifest.id === id)
      if (p && params.expectedCommit !== undefined && params.expectedCommit !== p.commit) throw new AppError('REVISION_CONFLICT', '插件版本已改变，请重新核对配置。')
      if (!p && !(builtin && action === 'select') && !(bundle && action === 'restore-bundled')) throw new AppError('NOT_FOUND', '插件不存在。')
      const reset = (provider: string) => { for (const [cap, value] of Object.entries(next.providers)) if (value === provider) delete next.providers[cap] }
      if (action === 'restore-bundled') {
        if (!bundle || p) throw new AppError('INVALID_ARGUMENT', '此随附插件已安装或不可用。')
        const reasons = await this.compatibility(bundle.manifest, next.installed)
        if (reasons.length) throw new AppError('PLUGIN_INCOMPATIBLE', reasons.join('\n'))
        const previous = next.retained?.find(p => p.source === 'bundled' && p.manifest.id === id && p.manifest.dataVersion === bundle.manifest.dataVersion)
        const restored = this.bundledInstall(bundle, previous)
        restored.enabled = !restored.manifest.configFields?.some(field => field.required && (restored.config[field.key] === undefined || restored.config[field.key] === ''))
        next.installed.push(restored); next.retained = next.retained?.filter(p => p.manifest.id !== id)
      } else if (action === 'select') {
        const caps = builtin ? [builtin.capability] : p!.manifest.capabilities.map(c => c.id)
        for (const cap of caps) { const previous = next.providers[cap]; if (previous) reset(previous) }
        if (p) { p.enabled = true; for (const cap of caps) next.providers[cap] = id }
      } else if (action === 'enable') p!.enabled = true
      else if (action === 'disable' || action === 'uninstall') {
        p!.enabled = false; reset(id)
        if (action === 'uninstall') {
          const retained = (next.retained ?? []).filter(item => item.manifest.id !== id)
          if (retained.length >= 1000) throw new AppError('LIMIT_EXCEEDED', '保留的插件配置已达到上限，请先整理本地保留数据。')
          next.retained = [...retained, p!]; next.installed = next.installed.filter(item => item !== p)
        }
      }
      else if (action === 'configure') p!.config = this.parseConfig(p!.manifest, params.config)
      else if (action === 'rollback') {
        if (!p!.previousCommit) throw new AppError('NOT_FOUND', '没有可回退的版本。')
        const old = p!.commit, manifest = parsePluginManifest(JSON.parse(await readFile(join(this.root, 'releases', id, p!.previousCommit, 'webnav.plugin.json'), 'utf8')))
        if (manifest.dataVersion !== p!.manifest.dataVersion) throw new AppError('PLUGIN_INCOMPATIBLE', '数据格式不同，不能仅回退代码。')
        p!.manifest = manifest; p!.commit = p!.previousCommit; p!.previousCommit = old
      } else throw new AppError('INVALID_ARGUMENT', '不支持此插件操作。')
      for (const plugin of next.installed.filter(p => p.enabled)) {
        const reasons = await this.compatibility(plugin.manifest, next.installed)
        for (const field of plugin.manifest.configFields ?? []) if (field.required && (plugin.config[field.key] === undefined || plugin.config[field.key] === '')) reasons.push(`请填写 ${field.label}。`)
        if (reasons.length) throw new AppError('PLUGIN_INCOMPATIBLE', `${plugin.manifest.name}：${reasons.join('\n')}`)
      }
      for (const [capability, provider] of Object.entries(next.providers)) if (!next.installed.some(p => p.enabled && p.manifest.id === provider && p.manifest.capabilities.some(c => c.id === capability))) throw new AppError('PLUGIN_INCOMPATIBLE', '默认实现的能力声明已改变，请先恢复内置实现。')
      next.revision++; await this.save(next); return this.state()
    } finally { this.busy = false }
  }
  async market(refresh: boolean): Promise<PluginMarket> {
    if (!refresh && this.cache && Date.now() - (this.cache.fetchedAt ?? 0) < 300_000) return { ...this.cache, cached: true }
    const directory = this.source(this.marketRepository)
    try {
      const commit = await this.fetch(this.marketRepository, 'HEAD'), index = parsePluginIndex(JSON.parse(await gitText(directory, commit, 'index.json', 1024 * 1024)))
      const next = { repository: this.marketRepository, index, fetchedAt: Date.now(), cached: false }
      await writeFile(join(this.root, 'market.json'), JSON.stringify(next)); this.cache = next; return next
    } catch { return { ...(this.cache ?? { repository: this.marketRepository, index: { schemaVersion: 1, plugins: [] }, fetchedAt: null }), cached: true, error: '无法更新插件索引。请检查网络，或仓库是否已发布 index.json。已安装插件与 Git 地址安装仍可使用。' } }
  }
}
