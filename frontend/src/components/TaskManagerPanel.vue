<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PhActivity, PhArrowClockwise, PhCaretDown, PhCaretRight, PhCheckCircle, PhClockCounterClockwise, PhCpu, PhDownloadSimple, PhHardDrives, PhList, PhMagnifyingGlass, PhPause, PhPlay, PhPlug, PhShieldCheck, PhTreeStructure, PhWarningCircle, PhX } from '@phosphor-icons/vue'
import { parseTaskManagerDetails, parseTaskManagerSnapshot, type TaskManagerActionPlan, type TaskManagerActionResult, type TaskManagerDetails, type TaskManagerProcess, type TaskManagerSnapshot, type TaskManagerState, type TaskManagerTarget } from '@webnav/shared'
import { connectionState, groups, rpc, servers } from '../backend'
import { pluginState } from '../plugins'
const recordingSupported = ref(false)
watch(() => [connectionState.value, pluginState.value?.runtimeRevision], async () => { recordingSupported.value = false; if (connectionState.value === 'ready') try { recordingSupported.value = (await rpc<{ recording: boolean }>('taskManager.capabilities')).recording } catch { /* Base monitoring remains available. */ } }, { immediate: true })
import { vResizableColumns } from '../table-columns'
import TaskManagerPerformance from './TaskManagerPerformance.vue'
import TaskManagerHistory from './TaskManagerHistory.vue'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import PluginUiSlot from './PluginUiSlot.vue'
import { menuBinding } from '../plugin-menus'
import type { PluginMenuContext } from '@webnav/shared'
import { parseTaskManagerCommandLine, type TaskManagerCommandLine } from '@webnav/shared'
import { addWatchedProcess, updateWatchedProcesses, MAX_WATCHED_PROCESSES, type WatchedProcess } from '../task-manager-watch'
import TaskManagerWatch from './TaskManagerWatch.vue'
import TaskManagerBatchAction from './TaskManagerBatchAction.vue'
import { appendMetric, formatMemory, formatPercent, formatRate, memoryShare, metricPath, processKey, processRows, targetKey, updatePinnedProcessRows, usageHeat, type MetricPoint, type ProcessRow, type ProcessSort } from '../task-manager'

const props = defineProps<{ active: boolean }>()
const emit = defineEmits<{ status: [message: string] }>()
const target = ref('local'), state = shallowRef<TaskManagerState>(), snapshot = shallowRef<TaskManagerSnapshot>()
const error = ref(''), notice = ref(''), busy = ref(false), refreshing = ref(false), paused = ref(false), interval = ref(2_000)
const hidden = ref(document.hidden), connectionLost = ref(false), started = ref(false)
const query = ref(''), tree = ref(true), sort = ref<ProcessSort>('cpuPercent'), descending = ref(true), collapsed = ref(new Set<string>())
const selection = ref(''), details = shallowRef<TaskManagerDetails>(), detailError = ref(''), detailBusy = ref(false)
const pinnedRows = shallowRef<ProcessRow[]>([])
const watched = shallowRef<WatchedProcess[]>([]), onlyWatched = ref(false)
const commandLine = shallowRef<TaskManagerCommandLine>(), commandBusy = ref(false), commandError = ref('')
let commandGeneration = 0
const processMenu = shallowRef<{ x: number; y: number; identity: string; monitorId: string; name: string; pid: number }>()
const detailTab = ref('overview'), resourceQuery = ref('')
const history = shallowRef<MetricPoint[]>([]), page = ref(0), pageSize = 150
const view = ref<'processes' | 'performance' | 'history'>('processes'), performanceCategory = ref<'cpu' | 'memory' | 'disks' | 'gpus'>('cpu')
function openPerformance(category: typeof performanceCategory.value) { performanceCategory.value = category; view.value = 'performance' }
const firstDisk = computed(() => snapshot.value?.performance?.disks[0]), firstGpu = computed(() => snapshot.value?.performance?.gpus[0])
const actionPlan = shallowRef<TaskManagerActionPlan>(), actionDialog = ref<HTMLDialogElement>(), actionBusy = ref(false)
let generation = 0, detailGeneration = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false
const available = computed(() => !!pluginState.value?.runningProviders['service:taskManager'])
const targets = computed(() => [
  { id: 'local', get name() { return i18nT('m722d5cef2bf1') }, get group() { return i18nT('m8a94c4a1cdbd') }, target: { kind: 'local' } as TaskManagerTarget },
  ...servers.value.flatMap(server => server.connections.filter(connection => connection.type === 'ssh').map(connection => {
    const item: TaskManagerTarget = { kind: 'ssh', serverId: server.id, connectionId: connection.id }
    return { id: targetKey(item), name: `${server.name} · ${connection.name} · ${server.host}`, group: groups.value.find(group => group.id === server.groupId)?.name ?? i18nT('me86ea3f280d9'), target: item }
  })),
])
const targetGroups = computed(() => [...new Set(targets.value.map(item => item.group))])
const currentTarget = computed(() => targets.value.find(item => item.id === target.value))
const ready = computed(() => state.value?.phase === 'ready' && connectionState.value === 'ready')
const platformName = computed(() => ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' })[state.value?.platform?.os ?? snapshot.value?.platform ?? 'linux'])
const phaseLabel = computed(() => !available.value ? i18nT('m189f19b8d826') : connectionState.value === 'locked' ? i18nT('mb7cea97fd2d5') : connectionState.value !== 'ready' ? i18nT('md3aeaecd7be4') : state.value ? ({ get connecting() { return i18nT('m694186911ae3') }, get 'host-key'() { return i18nT('m627075e138c2') }, get 'not-installed'() { return i18nT('m10ba6eb9a06a') }, get installing() { return i18nT('m9727caac995d') }, get starting() { return i18nT('m682b1af6a253') }, ready: paused.value ? i18nT('madf5ab270407') : hidden.value || !props.active ? i18nT('m76f7aa763ebf') : i18nT('m310624c8b37e'), get error() { return i18nT('m89c4766afc85') }, get closed() { return i18nT('m223ccd4b29b5') } })[state.value.phase] : connectionLost.value ? i18nT('mdda206707b80') : i18nT('m0a94786738c2'))
const sortedRows = computed(() => processRows(snapshot.value?.processes ?? [], { query: query.value, tree: tree.value, sort: sort.value, descending: descending.value, collapsed: collapsed.value }))
const rows = computed<ProcessRow[]>(() => onlyWatched.value ? watched.value.filter(item => [item.process.name, item.process.pid, item.process.executable ?? ''].join(' ').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())).map(item => ({ process: item.latest ?? item.process, depth: 0, children: false, missing: !item.latest })) : selection.value ? updatePinnedProcessRows(pinnedRows.value, snapshot.value?.processes ?? []) : sortedRows.value)
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize)))
const visibleRows = computed(() => rows.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
const checkedKeys = computed(() => new Set(watched.value.map(item => item.key)))
const checkablePage = computed(() => visibleRows.value.filter(row => !row.missing && row.process.startedAt > 0))
const pageChecked = computed(() => checkablePage.value.length > 0 && checkablePage.value.every(row => checkedKeys.value.has(processKey(row.process))))
const pageMixed = computed(() => !pageChecked.value && checkablePage.value.some(row => checkedKeys.value.has(processKey(row.process))))
const checkedLive = computed(() => watched.value.flatMap(item => item.latest ? [item.latest] : []))
const selected = computed(() => snapshot.value?.processes.find(process => processKey(process) === selection.value))
const processContext = computed<PluginMenuContext>(() => {
  const process = selected.value, sample = snapshot.value, monitor = state.value
  if (!process || !sample || !monitor) return {}
  return { monitorId: monitor.id, bootId: sample.bootId, targetKind: monitor.target.kind, ...(monitor.target.kind === 'ssh' ? { serverId: monitor.target.serverId, connectionId: monitor.target.connectionId } : {}), platform: sample.platform, arch: sample.arch, pid: process.pid, startedAt: process.startedAt, name: process.name, ...(process.executable ? { executable: process.executable } : {}) }
})
function processCurrent() { return !disposed && props.active && view.value === 'processes' && ready.value && !!selected.value }
const processMenuBinding = menuBinding('builtin.taskManager', 'process', () => processContext.value, () => processCurrent() && !!processMenu.value && !actionBusy.value && processMenu.value.monitorId === state.value?.id && processMenu.value.identity === selection.value)
const searchValue = computed(() => selected.value?.name ?? query.value)
const memoryPercent = computed(() => snapshot.value?.memory.total ? snapshot.value.memory.used / snapshot.value.memory.total * 100 : null)
const detailTabs = [{ id: 'overview', get name() { return i18nT('mfea405f9b01d') } }, { id: 'files', get name() { return i18nT('m39932f24fe11') } }, { id: 'connections', get name() { return i18nT('m97b31b5d63f5') } }, { id: 'modules', get name() { return i18nT('mb07e5088eafa') } }, { id: 'threads', get name() { return i18nT('m606f00b167ff') } }] as const
const filteredFiles = computed(() => details.value?.files.filter(item => `${item.path} ${item.type} ${item.fd}`.toLocaleLowerCase().includes(resourceQuery.value.toLocaleLowerCase())) ?? [])
const filteredModules = computed(() => details.value?.modules.filter(item => item.toLocaleLowerCase().includes(resourceQuery.value.toLocaleLowerCase())) ?? [])
const filteredConnections = computed(() => details.value?.connections.filter(item => `${item.localAddress}:${item.localPort} ${item.remoteAddress}:${item.remotePort} ${item.state}`.toLocaleLowerCase().includes(resourceQuery.value.toLocaleLowerCase())) ?? [])
const filteredThreads = computed(() => details.value?.threads.filter(item => `${item.id} ${item.state ?? ''}`.toLocaleLowerCase().includes(resourceQuery.value.toLocaleLowerCase())) ?? [])
const unavailableDetails = computed(() => details.value?.unavailable.filter(reason => reason.split(':')[0] === detailTab.value) ?? [])
const canTerminate = computed(() => view.value === 'processes' && ready.value && !!selected.value && selected.value.startedAt > 0 && !!snapshot.value?.capabilities.some(capability => capability === 'terminate-graceful' || capability === 'terminate-force'))
const canTerminateGracefully = computed(() => !!snapshot.value?.capabilities.includes('terminate-graceful'))
const processMenuItems = computed<MenuItem[]>(() => {
  const process = selected.value, canInspect = ready.value && !actionBusy.value
  const items: MenuItem[] = [
    { id: 'overview', get label() { return i18nT('m99826d3a0138') }, disabled: !canInspect },
    { id: 'connections', get label() { return i18nT('mad6d72c2e17c') }, disabled: !canInspect },
    { id: 'files', get label() { return i18nT('ma842c0f1540d') }, disabled: !canInspect },
    { id: 'copy-name', get label() { return i18nT('m383d2515fa5c') }, separator: true },
    { id: 'copy-pid', get label() { return i18nT('m37b62eee5d2a') } },
    { id: 'copy-path', get label() { return i18nT('m3e11925eb6cf') }, disabled: !process?.executable },
    { id: 'search-online', get label() { return i18nT('m79fa6b39461f') } },
  ]
  if (canTerminateGracefully.value) items.push({ id: 'terminate', get label() { return i18nT('mf6c777162a54') }, separator: true, danger: true, disabled: !canTerminate.value || actionBusy.value })
  if (snapshot.value?.capabilities.includes('terminate-force')) items.push({ id: 'terminate-force', get label() { return i18nT('mdae848fbafae') }, separator: !canTerminateGracefully.value, danger: true, disabled: !canTerminate.value || actionBusy.value })
  items.push({ id: 'clear', get label() { return i18nT('m02d1152b3568') }, separator: true, disabled: actionBusy.value })
  return items
})
function capabilityMessage(reason: string) {
  const [category, condition] = reason.split(':')
  const name = ({ get files() { return i18nT('m3cb8f515df37') }, get modules() { return i18nT('mb07e5088eafa') }, get threads() { return i18nT('m606f00b167ff') }, get connections() { return i18nT('mc6c6c1a78bfe') } } as Record<string, string>)[category ?? ''] ?? i18nT('mf616b4ae7f4b')
  return condition === 'truncated' ? i18nT('m2f9875629bdb', { p0: (name) }) : i18nT('m96a3799d1594', { p0: (name) })
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : i18nT('ma3c33e9e9262') }
function current(token: number) { return !disposed && token === generation }
function stopTimer() { clearTimeout(timer); timer = undefined }
function closeMonitor(id: string) { return rpc('taskManager.close', { monitorId: id }, true).catch(() => {}) }
function clearSelection() { selection.value = ''; pinnedRows.value = []; processMenu.value = undefined; details.value = undefined; detailError.value = ''; resourceQuery.value = ''; detailGeneration++; detailBusy.value = false; commandGeneration++; commandLine.value = undefined; commandBusy.value = false; commandError.value = ''; actionPlan.value = undefined; actionDialog.value?.close() }
function clearSearch() { if (actionBusy.value) return; clearSelection(); query.value = '' }
function inputSearch(event: Event) { const value = (event.target as HTMLInputElement).value; clearSelection(); query.value = value }
function clearData() { snapshot.value = undefined; history.value = []; watched.value = []; onlyWatched.value = false; clearSelection(); query.value = ''; actionBusy.value = false; collapsed.value = new Set(); page.value = 0 }
function checkProcess(process: TaskManagerProcess) {
  if (actionBusy.value || !snapshot.value) return
  const key = processKey(process)
  if (checkedKeys.value.has(key)) { watched.value = watched.value.filter(item => item.key !== key); if (onlyWatched.value && selection.value === key) clearSelection() }
  else if (watched.value.length >= MAX_WATCHED_PROCESSES) notice.value = i18nT('m61fdd8e043c4', { p0: (MAX_WATCHED_PROCESSES) })
  else watched.value = addWatchedProcess(watched.value, process, snapshot.value)
  if (!watched.value.length) onlyWatched.value = false
}
function checkPage() {
  if (actionBusy.value || !snapshot.value) return
  if (pageChecked.value) { const keys = new Set(checkablePage.value.map(row => processKey(row.process))); watched.value = watched.value.filter(item => !keys.has(item.key)); if (onlyWatched.value && keys.has(selection.value)) clearSelection() }
  else { for (const row of checkablePage.value) watched.value = addWatchedProcess(watched.value, row.process, snapshot.value); if (checkablePage.value.some(row => !checkedKeys.value.has(processKey(row.process)))) notice.value = i18nT('m61fdd8e043c4', { p0: (MAX_WATCHED_PROCESSES) }) }
  if (!watched.value.length) onlyWatched.value = false
}
function toggleWatch() { clearSelection(); query.value = ''; onlyWatched.value = !onlyWatched.value; page.value = 0 }
function clearChecked() { if (onlyWatched.value) clearSelection(); watched.value = []; onlyWatched.value = false; page.value = 0 }
async function copyChecked(ids: boolean) {
  const text = ids ? watched.value.map(item => item.process.pid).join('\n') : [i18nT('m45485302bcd4'), ...watched.value.map(item => `${item.process.name}\t${item.process.pid}\t${item.latest?.cpuPercent ?? i18nT('m4d8c1c5b4283')}\t${item.latest?.memoryBytes ?? i18nT('m6bf6938963a2')}`)].join('\n')
  try { await navigator.clipboard.writeText(text); emit('status', i18nT('mb691b3c0db71')) } catch { notice.value = i18nT('m0427f5fc3ee5') }
}
async function loadCommandLine() {
  const process = selected.value, id = state.value?.id, token = generation, request = ++commandGeneration
  commandLine.value = undefined; commandError.value = ''; commandBusy.value = false
  if (!process || !id || !ready.value) return
  if (process.startedAt <= 0) { commandError.value = i18nT('m2225f619c2a0'); return }
  commandBusy.value = true
  try { const result = parseTaskManagerCommandLine(await rpc('taskManager.commandLine', { monitorId: id, pid: process.pid, startedAt: process.startedAt })); if (current(token) && request === commandGeneration && processKey(result) === selection.value) commandLine.value = result }
  catch (cause) { if (current(token) && request === commandGeneration) commandError.value = message(cause) }
  finally { if (current(token) && request === commandGeneration) commandBusy.value = false }
}
async function copyCommandLine() { if (commandLine.value?.commandLine == null) return; try { await navigator.clipboard.writeText(commandLine.value.commandLine); emit('status', i18nT('mfbcce8cc239e')) } catch { commandError.value = i18nT('m0427f5fc3ee5') } }
async function disconnect(showNotice = true) {
  generation++; stopTimer(); const id = state.value?.id; state.value = undefined; clearData(); busy.value = false; refreshing.value = false; detailBusy.value = false; error.value = ''; connectionLost.value = true
  if (showNotice) notice.value = i18nT('mbe377d526846')
  if (id) await closeMonitor(id)
}
async function connect() {
  if (busy.value || !currentTarget.value || connectionState.value !== 'ready' || !available.value) return
  const selectedTarget = currentTarget.value.target, previous = state.value?.id, token = ++generation
  stopTimer(); state.value = undefined; clearData(); refreshing.value = false; error.value = ''; notice.value = ''; busy.value = true; started.value = true; connectionLost.value = false
  if (previous) await closeMonitor(previous)
  if (!current(token)) return
  try {
    const result = await rpc<TaskManagerState>('taskManager.start', { target: selectedTarget }, true)
    if (!current(token)) { await closeMonitor(result.id); return }
    state.value = result
  } catch (cause) { if (current(token)) { error.value = message(cause); connectionLost.value = true } }
  finally { if (current(token)) { busy.value = false; schedule(0) } }
}
function schedule(delay = interval.value) {
  stopTimer()
  if (!state.value || disposed || !props.active || hidden.value || connectionState.value !== 'ready' || state.value.phase === 'closed' || state.value.phase === 'error') return
  if (state.value.phase === 'ready' && snapshot.value && paused.value && view.value !== 'history') return
  if (state.value.phase === 'ready' && snapshot.value && view.value === 'history') delay = Math.max(5000, delay)
  timer = setTimeout(() => void refresh(), delay)
}
async function refresh() {
  if (refreshing.value || busy.value || !state.value || connectionState.value !== 'ready') return
  const token = generation, id = state.value.id
  refreshing.value = true
  try {
    if (state.value.phase !== 'ready' || view.value === 'history') {
      const result = await rpc<TaskManagerState>('taskManager.status', { monitorId: id })
      if (!current(token)) return
      state.value = result
      if (result.phase !== 'ready') clearData()
    }
    if (!current(token)) return
    if (state.value?.phase === 'ready' && (!paused.value || !snapshot.value) && props.active && !hidden.value && (view.value !== 'history' || !snapshot.value)) {
      const result = parseTaskManagerSnapshot(await rpc('taskManager.snapshot', { monitorId: id }))
      if (!current(token)) return
      if (snapshot.value && result.bootId !== snapshot.value.bootId) clearData()
      if (!snapshot.value || result.sequence > snapshot.value.sequence) {
        snapshot.value = result
        watched.value = updateWatchedProcesses(watched.value, result, interval.value)
        const identities = new Set(result.processes.map(processKey))
        collapsed.value = new Set([...collapsed.value].filter(identity => identities.has(identity)))
        history.value = appendMetric(history.value, { at: result.sampledAt, cpu: result.cpuPercent, memory: result.memory.total ? result.memory.used / result.memory.total * 100 : 0 })
        if (selection.value && !selected.value) { clearSelection(); query.value = ''; if (!actionBusy.value) notice.value = i18nT('m8f677a41640f') }
      }
    }
    error.value = ''
  } catch (cause) {
    if (current(token)) {
      error.value = message(cause)
      // A collector may fail after becoming ready. Reconcile its lifecycle before retrying reads.
      try {
        const result = await rpc<TaskManagerState>('taskManager.status', { monitorId: id })
        if (current(token)) { state.value = result; if (result.phase !== 'ready') clearData() }
      } catch { /* Preserve the original read error; reconnect/lock cleanup belongs to its watcher. */ }
    }
  }
  finally { if (current(token)) { refreshing.value = false; schedule(state.value?.phase === 'ready' ? interval.value : 1000) } }
}
async function stateAction(method: 'install' | 'hostKeyDecision', extra: Record<string, unknown> = {}) {
  if (!state.value || busy.value) return
  const token = generation, id = state.value.id
  busy.value = true; error.value = ''; notice.value = ''; stopTimer()
  try { const result = await rpc<TaskManagerState>(`taskManager.${method}`, { monitorId: id, ...extra }, true); if (current(token)) state.value = result }
  catch (cause) { if (current(token)) { error.value = message(cause); notice.value = i18nT('m0d089d17c9e2') } }
  finally { if (current(token)) { busy.value = false; schedule(0) } }
}
async function loadDetails() {
  if (!ready.value || !state.value || !selected.value || detailBusy.value) return
  const process = selected.value, token = generation, detailToken = ++detailGeneration, id = state.value.id
  details.value = undefined; detailError.value = ''; detailBusy.value = true
  try {
    const result = parseTaskManagerDetails(await rpc('taskManager.details', { monitorId: id, pid: process.pid, startedAt: process.startedAt }))
    if (current(token) && detailToken === detailGeneration && processKey(result.process) === selection.value) details.value = result
  } catch (cause) { if (current(token) && detailToken === detailGeneration) detailError.value = message(cause) }
  finally { if (current(token) && detailToken === detailGeneration) detailBusy.value = false }
}
function choose(process: TaskManagerProcess) {
  if (actionBusy.value || !snapshot.value?.processes.some(item => processKey(item) === processKey(process))) return
  if (selection.value === processKey(process)) return
  if (!selection.value) pinnedRows.value = [...rows.value]
  closeAction(); notice.value = ''; processMenu.value = undefined; selection.value = processKey(process); details.value = undefined; detailError.value = ''; resourceQuery.value = ''; detailGeneration++; detailBusy.value = false
  void loadCommandLine()
  if (detailTabs.some(tab => tab.id === detailTab.value && tab.id !== 'overview')) void loadDetails()
}
function toggleBranch(process: TaskManagerProcess) { const key = processKey(process); if (collapsed.value.has(key)) collapsed.value.delete(key); else collapsed.value.add(key); if (selection.value) pinnedRows.value = [...sortedRows.value] }
function openProcessMenu(event: MouseEvent | KeyboardEvent, row: ProcessRow) {
  if (event instanceof KeyboardEvent && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  event.preventDefault(); event.stopPropagation()
  if (row.missing || !ready.value || actionBusy.value || !state.value) return
  choose(row.process)
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  processMenu.value = { x: event instanceof MouseEvent ? event.clientX : rect.left + 12, y: event instanceof MouseEvent ? event.clientY : rect.bottom, identity: processKey(row.process), monitorId: state.value.id, name: row.process.name, pid: row.process.pid }
}
async function processMenuAction(id: string) {
  const menu = processMenu.value, process = selected.value, token = generation
  processMenu.value = undefined
  if (!menu || !process || !ready.value || actionBusy.value || menu.monitorId !== state.value?.id || menu.identity !== processKey(process)) return
  if (id === 'clear') { clearSearch(); return }
  if (id === 'overview' || id === 'connections' || id === 'files') { detailTab.value = id; return }
  if (id === 'terminate' || id === 'terminate-force') { await prepareAction(id === 'terminate-force'); return }
  if (id === 'search-online') { window.open('https://www.bing.com/search?q=' + encodeURIComponent(process.name), '_blank', 'noopener,noreferrer'); return }
  const text = id === 'copy-name' ? process.name : id === 'copy-pid' ? String(process.pid) : id === 'copy-path' ? process.executable : undefined
  if (!text) return
  try { await navigator.clipboard.writeText(text); if (current(token)) emit('status', i18nT('m8f6f8d979c98')) }
  catch { if (current(token)) notice.value = i18nT('m850ab8a439fe') }
}
function changeSort(key: ProcessSort) { if (sort.value === key) descending.value = !descending.value; else { sort.value = key; descending.value = key === 'cpuPercent' || key === 'memoryBytes' } }
function sortDescription(key: ProcessSort) { return sort.value === key ? descending.value ? 'descending' : 'ascending' : 'none' }
function formatStarted(value: number) { return value > 0 ? new Date(value).toLocaleString(displayLocale()) : i18nT('m460b3574e4bd') }
async function prepareAction(force = !canTerminateGracefully.value) {
  if (!canTerminate.value || !selected.value || !state.value || actionBusy.value) return
  const process = selected.value, token = generation
  actionBusy.value = true; error.value = ''
  try {
    const plan = await rpc<TaskManagerActionPlan>('taskManager.prepareAction', { monitorId: state.value.id, pid: process.pid, startedAt: process.startedAt, force }, true)
    if (!current(token) || selection.value !== processKey(process)) return
    actionPlan.value = plan; await nextTick(); actionDialog.value?.showModal()
  } catch (cause) { if (current(token)) error.value = message(cause) }
  finally { if (current(token)) actionBusy.value = false }
}
async function applyAction() {
  const plan = actionPlan.value, token = generation
  if (!plan || actionBusy.value || !ready.value || state.value?.id !== plan.monitorId) return
  if (plan.expiresAt <= Date.now()) { actionPlan.value = undefined; actionDialog.value?.close(); error.value = i18nT('m4cdbcf1169db'); return }
  actionBusy.value = true
  try {
    const result = await rpc<TaskManagerActionResult>('taskManager.applyAction', { monitorId: plan.monitorId, planId: plan.id }, true)
    if (current(token)) { notice.value = result.message ?? (result.status === 'pending' ? i18nT('m6c00a81fd1dd') : result.status === 'already-exited' ? i18nT('mbe17bd18ed78') : i18nT('ma43d2c613bc9')); await refresh() }
  } catch (cause) { if (current(token)) { error.value = message(cause); notice.value = i18nT('m8ff0213bed46') } }
  finally { if (current(token)) { actionBusy.value = false; actionPlan.value = undefined; actionDialog.value?.close() } }
}
function closeAction() { if (!actionBusy.value) { actionPlan.value = undefined; actionDialog.value?.close() } }
function visibility() { hidden.value = document.hidden; schedule(0) }
watch([query, sort, descending, tree], () => { page.value = 0 })
watch([sort, descending, tree], () => { if (selection.value) pinnedRows.value = [...sortedRows.value]; processMenu.value = undefined })
watch(pages, value => { page.value = Math.min(page.value, value - 1) })
watch(detailTab, value => { resourceQuery.value = ''; if (detailTabs.some(tab => tab.id === value && tab.id !== 'overview') && !details.value) void loadDetails() })
watch([() => props.active, paused, interval], () => { if (!props.active) processMenu.value = undefined; schedule(0) })
watch(view, value => { processMenu.value = undefined; if (value !== 'processes') closeAction(); schedule(0) })
watch(target, () => { busy.value = false; void connect() })
watch(currentTarget, value => { if (!value) void disconnect() })
watch([connectionState, available], ([connection, enabled]) => {
  if (connection !== 'ready' || !enabled) { if (state.value || busy.value) void disconnect(false); if (started.value) connectionLost.value = true }
  else if (!started.value && props.active) void connect()
}, { immediate: true })
watch(phaseLabel, value => emit('status', value), { immediate: true })
onMounted(() => document.addEventListener('visibilitychange', visibility))
onBeforeUnmount(() => { disposed = true; generation++; stopTimer(); detailGeneration++; document.removeEventListener('visibilitychange', visibility); actionDialog.value?.close(); if (state.value) void closeMonitor(state.value.id) })
</script>

<template>
  <section class="task-manager" :aria-label="i18nT('m62fdb5304cf5')">
    <header class="tm-heading">
      <div class="tm-title"><PhActivity :size="27" /><h1>{{ i18nT('m62fdb5304cf5') }}</h1><span class="tm-pill">{{ state?.target.kind === 'ssh' ? 'SSH' : i18nT('m8a94c4a1cdbd') }}</span></div>
      <label class="tm-target"><span class="visually-hidden">{{ i18nT('m12eeb7ca4534') }}</span><PhHardDrives :size="19" /><select v-model="target" :aria-label="i18nT('m12eeb7ca4534')" :disabled="actionBusy"><optgroup v-for="group in targetGroups" :key="group" :label="group"><option v-for="item in targets.filter(item => item.group === group)" :key="item.id" :value="item.id">{{ item.name }}</option></optgroup></select></label>
      <button v-if="state" class="icon-button" :disabled="actionBusy" :aria-label="i18nT('m16bb93466df4')" :title="i18nT('m16bb93466df4')" @click="disconnect()"><PhPlug :size="20" /></button>
      <button class="button tm-recording-entry" :disabled="actionBusy || !recordingSupported" :title="recordingSupported ? i18nT('m6eccd34fa482') : i18nT('m532f632d7c53')" @click="view = 'history'"><PhClockCounterClockwise :size="16"/>{{ i18nT('m6eccd34fa482') }}</button>
      <p class="tm-subtitle"><template v-if="state?.platform">{{ platformName }} · {{ state.platform.arch }} · {{ state.platform.username }}@{{ state.platform.hostname }}<span class="tm-separator">·</span></template>{{ phaseLabel }}</p>
    </header>
    <p v-if="error" class="tm-message tm-error" role="alert"><PhWarningCircle :size="18" />{{ error }}<button v-if="state && !busy" class="button" @click="refresh">{{ i18nT('maba2334fda5b') }}</button></p>
    <p v-if="notice" class="tm-message" role="status">{{ notice }}</p>
    <div class="tm-viewbar"><div role="tablist" :aria-label="i18nT('m4457b5030f2e')" class="tm-main-tabs"><button role="tab" :disabled="actionBusy" :aria-selected="view === 'processes'" :class="{ active: view === 'processes' }" @click="view = 'processes'">{{ i18nT('m9bfb43ada1f9') }}</button><button role="tab" :disabled="actionBusy" :aria-selected="view === 'performance'" :class="{ active: view === 'performance' }" @click="view = 'performance'">{{ i18nT('m3b1ef565e609') }}</button><button role="tab" :disabled="actionBusy || !recordingSupported" :title="recordingSupported ? i18nT('mb0385cfe4b42') : i18nT('mbed10570ac25')" :aria-selected="view === 'history'" :class="{ active: view === 'history' }" @click="view = 'history'">{{ i18nT('mb0385cfe4b42') }}</button></div><span class="tm-view-spacer"></span><template v-if="ready && view !== 'history'"><button class="icon-button" :aria-pressed="paused" :aria-label="paused ? i18nT('ma80cca1a7645') : i18nT('m8c78e736df18')" :title="paused ? i18nT('mda9a6f455105') : i18nT('md70635089538')" @click="paused = !paused"><PhPlay v-if="paused" :size="19" /><PhPause v-else :size="19" /></button><label class="tm-interval"><span>{{ i18nT('m3055a035f0eb') }}</span><select v-model="interval" :aria-label="i18nT('m293adff7b46c')"><option :value="1000">{{ i18nT('m495bd39763c2') }}</option><option :value="2000">{{ i18nT('ma20b6f795a49') }}</option><option :value="5000">{{ i18nT('m03510755ab30') }}</option></select></label><button class="icon-button" :disabled="refreshing || paused" :aria-label="i18nT('mca811c30ed6c')" :title="i18nT('mdf0fc0d56d76')" @click="refresh"><PhArrowClockwise :size="19" :class="{ 'tm-spinning': refreshing }" /></button></template></div>

    <div v-if="!ready" class="tm-state" :class="{ 'tm-history-connection': view === 'history' }" role="status">
      <div class="tm-state-icon"><PhDownloadSimple v-if="state?.phase === 'not-installed'" :size="40" /><PhShieldCheck v-else-if="state?.phase === 'host-key'" :size="40" /><PhActivity v-else :size="40" /></div>
      <h2>{{ busy && !state ? i18nT('m190fe18e18a5') : phaseLabel }}</h2>
      <template v-if="state?.phase === 'not-installed'">
        <p>{{ i18nT('mf5045ac5ef4b') }}</p>
        <div class="tm-install-facts"><span>{{ i18nT('m3eb9bc4af774') }}</span><code>{{ state.installPath || '~/.webnav/tools' }}</code><span>{{ i18nT('m3e5c3ba2c6a7') }}</span><strong>{{ state.target.kind === 'ssh' ? i18nT('ma765e911c880') : i18nT('meb09544926ed') }}</strong><span>{{ i18nT('m978cbca6265d') }}</span><strong>{{ i18nT('m1030dd3e0c0a') }}</strong></div>
        <button class="button primary" :disabled="busy" @click="stateAction('install')"><PhDownloadSimple :size="18" />{{ i18nT('ma5812a402aff') }}</button>
      </template>
      <template v-else-if="state?.phase === 'host-key' && state.hostKey">
        <p>{{ state.hostKey.changed ? i18nT('md401c506c858') : i18nT('mcf7337db149e') }}</p>
        <div class="tm-fingerprint"><strong>{{ state.hostKey.host }}:{{ state.hostKey.port }}</strong><code>{{ state.hostKey.fingerprint }}</code><small v-if="state.hostKey.changed">{{ i18nT('mea34686438db', { p0: (state.hostKey.previous) }) }}</small></div>
        <div class="tm-state-actions"><button class="button" :disabled="busy" @click="disconnect()">{{ i18nT('m3687f953cfe8') }}</button><button class="button primary" :disabled="busy" @click="stateAction('hostKeyDecision', { accept: true })">{{ state.hostKey.changed ? i18nT('m1d1fbf09b4b0') : i18nT('me82d394511ac') }}</button></div>
      </template>
      <template v-else-if="busy || state?.phase === 'connecting' || state?.phase === 'installing' || state?.phase === 'starting'">
        <p>{{ state?.progress || state?.message || i18nT('m1ed19b6174ee') }}</p><progress :aria-label="i18nT('me06493c46327')"></progress><button class="button" @click="disconnect()">{{ i18nT('m2cd0f3be8738') }}</button>
      </template>
      <template v-else>
        <p>{{ state?.message || (connectionState === 'locked' ? i18nT('m606add8dd087') : !available ? i18nT('m859af42f2f49') : connectionState !== 'ready' ? i18nT('m3abffd05e407') : i18nT('m9fdebaee7020')) }}</p>
        <button class="button primary" :disabled="connectionState !== 'ready' || !available || !currentTarget" @click="connect"><PhPlug :size="18" />{{ started ? i18nT('m68891ab35cab') : i18nT('mca9c06cbf87c') }}</button>
      </template>
    </div>
    <TaskManagerHistory v-if="currentTarget && recordingSupported" v-show="view === 'history'" :key="currentTarget.id" :active="props.active && !hidden && view === 'history'" :target-key="currentTarget.id" :target-label="state?.label || currentTarget.name" :monitor-id="state?.id" :connected="ready" :capabilities="snapshot?.capabilities"/>

    <template v-if="ready">
      <TaskManagerPerformance v-if="snapshot" v-show="view === 'performance'" :snapshot="snapshot" :history="history" :category="performanceCategory"/>
      <div v-show="view === 'processes'" class="tm-process-view">
      <div class="tm-overview">
        <button class="tm-summary-card" :aria-label="i18nT('m4225bff8f82e')" @click="openPerformance('cpu')"><header><span>CPU</span><small>{{ i18nT('m4e0753161d36') }}</small></header><strong>{{ formatPercent(snapshot?.cpuPercent) }}</strong><svg viewBox="0 0 240 52" preserveAspectRatio="none" role="img" :aria-label="i18nT('m0669df85d9aa')"><path class="tm-chart-grid" d="M0,48H240 M0,26H240 M0,4H240 M60,4V48 M120,4V48 M180,4V48"/><path :d="metricPath(history, 'cpu')" class="tm-chart-line"/></svg><footer>{{ i18nT('mfb47f95e9879', { p0: (snapshot?.cpuCount ?? '—'), p1: (snapshot?.processes.length ?? '—') }) }}</footer></button>
        <button class="tm-summary-card tm-memory" :aria-label="i18nT('mae7c379dbb39')" @click="openPerformance('memory')"><header><span>{{ i18nT('m7d8f8c37ec78') }}</span><small>{{ formatPercent(memoryPercent) }} ›</small></header><strong>{{ snapshot ? formatMemory(snapshot.memory.used) : '—' }}<small> / {{ snapshot ? formatMemory(snapshot.memory.total) : '—' }}</small></strong><svg viewBox="0 0 240 52" preserveAspectRatio="none" role="img" :aria-label="i18nT('mf78ba99d6bc7')"><path class="tm-chart-grid" d="M0,48H240 M0,26H240 M0,4H240 M60,4V48 M120,4V48 M180,4V48"/><path :d="metricPath(history, 'memory')" class="tm-chart-line"/></svg><footer>{{ i18nT('mb29ad560fdab') }}</footer></button>
        <button class="tm-summary-card" :aria-label="i18nT('mc9b6e0def5c1')" @click="openPerformance('disks')"><header><span>{{ i18nT('mde7b72a3f852') }}</span><small>{{ snapshot?.performance?.disks.length ? snapshot.performance.disks.length + i18nT('m503c005f63f3') : i18nT('m756762e293f2') }} ›</small></header><strong>{{ firstDisk ? formatPercent(firstDisk.activePercent) : i18nT('m460b3574e4bd') }}<small>{{ i18nT('mcaaf682ff0b1') }}</small></strong><div class="tm-summary-rates"><span>{{ i18nT('m534cb3fa8fbf') }}<b>{{ formatRate(firstDisk?.readBytesPerSecond) }}</b></span><span>{{ i18nT('m5c783c467965') }}<b>{{ formatRate(firstDisk?.writeBytesPerSecond) }}</b></span></div><footer>{{ firstDisk?.name ?? i18nT('mc634cb8f2636') }}</footer></button>
        <button class="tm-summary-card" :aria-label="i18nT('mafa52acbbff1')" @click="openPerformance('gpus')"><header><span>GPU</span><small>{{ snapshot?.performance?.gpus.length ? snapshot.performance.gpus.length + i18nT('mf44a21eae2af') : i18nT('m756762e293f2') }} ›</small></header><strong>{{ firstGpu ? formatPercent(firstGpu.utilizationPercent) : i18nT('m460b3574e4bd') }}</strong><div class="tm-summary-rates"><span>{{ i18nT('m09e8be461598') }}<b>{{ firstGpu?.memoryUsedBytes == null ? i18nT('m460b3574e4bd') : formatMemory(firstGpu.memoryUsedBytes) }} / {{ firstGpu?.memoryTotalBytes == null ? '—' : formatMemory(firstGpu.memoryTotalBytes) }}</b></span><span v-if="firstGpu?.sharedMemoryUsedBytes !== undefined || firstGpu?.sharedMemoryTotalBytes !== undefined">{{ i18nT('m5c50b75f20dc') }}<b>{{ firstGpu?.sharedMemoryUsedBytes == null ? i18nT('m460b3574e4bd') : formatMemory(firstGpu.sharedMemoryUsedBytes) }} / {{ firstGpu?.sharedMemoryTotalBytes == null ? '—' : formatMemory(firstGpu.sharedMemoryTotalBytes) }}</b></span></div><footer><template v-if="firstGpu?.utilizationScope === 'visible-clients'">{{ i18nT('m76b3aebfa7b6') }}</template>{{ firstGpu?.name ?? i18nT('mc634cb8f2636') }}</footer></button>
      </div>
      <div class="tm-toolbar">
        <label class="tm-search" :class="{ 'tm-search-selected': !!selected }"><PhCheckCircle v-if="selected" :size="18" /><PhMagnifyingGlass v-else :size="18" /><span v-if="selected || query" class="tm-search-mode" :title="selected ? i18nT('ma8e46a6a823a') : i18nT('m090fde1ccb83')">{{ selected ? i18nT('ma737fd72b016') : i18nT('mb5f15473fdc0') }}</span><input :value="searchValue" :disabled="actionBusy" :aria-label="i18nT('m8dcb785691d4')" :placeholder="i18nT('m8dcb785691d4')" @input="inputSearch" @keydown.esc.prevent="clearSearch" /><button v-if="searchValue" :disabled="actionBusy" :aria-label="selected ? i18nT('m84d59f5b9fce') : i18nT('m6ec9a8f8626c')" :title="selected ? i18nT('me5445e2073f0') : i18nT('md62e64a05006')" @click="clearSearch"><PhX :size="16" /></button></label>
        <div class="segmented"><button :class="{ active: tree }" :aria-pressed="tree" :title="i18nT('mc240c5ac468c')" :aria-label="i18nT('mc240c5ac468c')" @click="tree = true"><PhTreeStructure :size="18" /></button><button :class="{ active: !tree }" :aria-pressed="!tree" :title="i18nT('m104c25598e4b')" :aria-label="i18nT('m104c25598e4b')" @click="tree = false"><PhList :size="18" /></button></div>
      </div>
      <div class="tm-heat-legend" :aria-label="i18nT('mea8614e3ed25')"><span>{{ i18nT('m95cb725eeb0c') }}</span><span class="heat-low">{{ i18nT('ma155afc76139') }}</span><span class="heat-medium">{{ i18nT('m1fc97f8afe1e') }}</span><span class="heat-high">{{ i18nT('m229ad24bfb59') }}</span><span class="heat-critical">{{ i18nT('m1eaf2fed345f') }}</span><small>{{ i18nT('m580356bf362a') }}</small></div>
      <div v-if="watched.length" class="tm-multiselect" :aria-label="i18nT('md76ef414f2db')"><strong>{{ i18nT('m7ff70b8e741c', { p0: (watched.length) }) }}</strong><button class="button" :class="{ primary: onlyWatched }" :aria-pressed="onlyWatched" :disabled="actionBusy" @click="toggleWatch">{{ onlyWatched ? i18nT('m50bc8ab1d020') : i18nT('m4f741723bbfb') }}</button><button class="button" @click="copyChecked(true)">{{ i18nT('m37b62eee5d2a') }}</button><button class="button" @click="copyChecked(false)">{{ i18nT('m96bbb8bcae70') }}</button><TaskManagerBatchAction v-if="state && snapshot?.capabilities.some(cap => cap === 'terminate-force' || cap === 'terminate-graceful')" :key="state.id" :monitor-id="state.id" :processes="checkedLive" :force="!canTerminateGracefully" :active="ready && active" @busy="actionBusy = $event" @changed="refresh" /><button class="button" :disabled="actionBusy" @click="clearChecked">{{ i18nT('md79018168daf') }}</button></div>
      <TaskManagerWatch v-if="onlyWatched && watched.length" :items="watched" :paused="paused" :inactive="!active || hidden" />
      <div class="tm-body" :class="{ 'has-selection': !!selected }">
        <div class="tm-processes">
          <div class="tm-table-scroll"><table v-resizable-columns="{ id: 'task-manager.processes', widths: [246, 56, 64, 164, 220, 110], minimums: [120, 52, 56, 120, 90, 64], fill: 4 }" class="tm-table"><thead><tr><th :aria-sort="sortDescription('name')"><input class="tm-process-check" type="checkbox" :aria-label="i18nT('md3a5ccfba7a4')" :checked="pageChecked" :indeterminate="pageMixed" :disabled="actionBusy || !checkablePage.length" @change="checkPage" /><button @click="changeSort('name')">{{ i18nT('md44e9b3d3b31') }}</button></th><th :aria-sort="sortDescription('pid')"><button @click="changeSort('pid')">PID</button></th><th :aria-sort="sortDescription('cpuPercent')"><button @click="changeSort('cpuPercent')">CPU {{ sort === 'cpuPercent' ? descending ? '↓' : '↑' : '' }}</button></th><th :aria-sort="sortDescription('memoryBytes')"><button @click="changeSort('memoryBytes')">{{ i18nT('m7d8f8c37ec78') }}</button></th><th :aria-sort="sortDescription('username')"><button @click="changeSort('username')">{{ i18nT('m0d0e1a86b3aa') }}</button></th><th>{{ i18nT('m6320b4a8722a') }}</th></tr></thead><tbody>
            <tr v-for="row in visibleRows" :key="processKey(row.process)" :class="{ selected: selection === processKey(row.process), 'tm-row-missing': row.missing }" :aria-selected="selection === processKey(row.process)" :aria-disabled="row.missing || actionBusy" @click="!row.missing && choose(row.process)" @contextmenu.prevent.stop="openProcessMenu($event, row)" @keydown="openProcessMenu($event, row)">
              <td><div class="tm-process-entry"><input class="tm-process-check" type="checkbox" :aria-label="i18nT('m9424f67c8b08') + row.process.name + ' PID ' + row.process.pid" :checked="checkedKeys.has(processKey(row.process))" :disabled="actionBusy || (!checkedKeys.has(processKey(row.process)) && (row.missing || row.process.startedAt <= 0))" @click.stop @keydown.stop @change="checkProcess(row.process)" /><div class="tm-process-name" :style="{ paddingLeft: Math.min(row.depth, 8) * 14 + 'px' }"><button v-if="row.children" class="tm-branch" :disabled="row.missing || actionBusy" :aria-label="(collapsed.has(processKey(row.process)) ? i18nT('m5e43128cd7e5') : i18nT('ma7c0e172a790')) + row.process.name" :aria-expanded="!collapsed.has(processKey(row.process))" @click.stop="toggleBranch(row.process)"><PhCaretRight v-if="collapsed.has(processKey(row.process))" :size="13" /><PhCaretDown v-else :size="13" /></button><span v-else class="tm-branch"></span><PhCheckCircle v-if="selection === processKey(row.process)" class="tm-selected-icon" :size="16" /><PhCpu v-else :size="16" /><button class="tm-name-select" :disabled="row.missing || actionBusy" :title="row.process.executable || row.process.name" @click.stop="choose(row.process)">{{ row.process.name }}</button></div></div></td>
              <td :title="String(row.process.pid)">{{ row.process.pid }}</td><td class="tm-heat-cell" :class="'heat-' + usageHeat(row.missing ? null : row.process.cpuPercent)" :data-heat="usageHeat(row.missing ? null : row.process.cpuPercent)" :title="i18nT('mb70463dfadd6') + formatPercent(row.missing ? null : row.process.cpuPercent)">{{ formatPercent(row.missing ? null : row.process.cpuPercent) }}</td><td class="tm-heat-cell" :class="'heat-' + usageHeat(row.missing ? null : memoryShare(row.process.memoryBytes, snapshot?.memory.total))" :data-heat="usageHeat(row.missing ? null : memoryShare(row.process.memoryBytes, snapshot?.memory.total))" :title="row.missing ? i18nT('mf80859cb16b7') : i18nT('m92ab60a11f8c') + formatPercent(memoryShare(row.process.memoryBytes, snapshot?.memory.total))"><span>{{ row.missing ? '—' : formatMemory(row.process.memoryBytes) }}</span><small v-if="!row.missing">{{ formatPercent(memoryShare(row.process.memoryBytes, snapshot?.memory.total)) }}</small></td><td :title="row.process.username">{{ row.process.username || '—' }}</td><td :title="row.missing ? i18nT('m089fab0811c0') : row.process.status">{{ row.missing ? i18nT('mf80859cb16b7') : row.process.status || '—' }}</td>
            </tr>
          </tbody></table><div v-if="!visibleRows.length" class="tm-table-empty">{{ !snapshot ? i18nT('m1ca9c8ce38b9') : query ? i18nT('m52e61f1eed62') : i18nT('m1bc1e379914d') }}</div></div>
          <footer class="tm-table-footer"><span>{{ i18nT('m980fda45d8ef', { p0: (rows.length) }) }}<template v-if="query">{{ i18nT('mfd047ccb2020') }}</template><template v-if="selected">{{ i18nT('m8321cd7a5c20') }}</template><template v-if="snapshot?.truncated">{{ i18nT('m8a30055c5e2b') }}</template><template v-if="tree && query">{{ i18nT('mc7bd9ab332a1') }}</template></span><span class="tm-pages"><button class="icon-button" :disabled="page === 0" :aria-label="i18nT('m9cb28ef8ef18')" @click="page--">‹</button>{{ page + 1 }} / {{ pages }}<button class="icon-button" :disabled="page + 1 >= pages" :aria-label="i18nT('m7eac2a6ccf4d')" @click="page++">›</button></span></footer>
        </div>
        <aside v-if="selected" class="tm-inspector" :aria-label="i18nT('m71ffe4648d18')"><header><span>{{ i18nT('mca8c8f71675b') }}</span><button class="icon-button" :aria-label="i18nT('mb92a0ea07862')" :disabled="actionBusy" @click="clearSearch"><PhX :size="17" /></button></header><div class="tm-selected-name"><PhCpu :size="32" /><div><h2>{{ selected.name }}</h2><span>PID {{ selected.pid }}</span></div></div><dl><dt>{{ i18nT('m417caec06de9') }}</dt><dd>{{ selected.ppid }}</dd><dt>{{ i18nT('m0d0e1a86b3aa') }}</dt><dd>{{ selected.username || i18nT('m460b3574e4bd') }}</dd><dt>{{ i18nT('m6320b4a8722a') }}</dt><dd>{{ selected.status || i18nT('m460b3574e4bd') }}</dd><dt>{{ i18nT('m14aedaac76f0') }}</dt><dd>{{ formatStarted(selected.startedAt) }}</dd><dt>{{ i18nT('m8db734884f7f') }}</dt><dd class="tm-path">{{ selected.executable || i18nT('m460b3574e4bd') }}</dd><dt>CPU</dt><dd>{{ formatPercent(selected.cpuPercent) }}</dd><dt>{{ i18nT('m7d8f8c37ec78') }}</dt><dd>{{ formatMemory(selected.memoryBytes) }}</dd><dt>{{ i18nT('m606f00b167ff') }}</dt><dd>{{ selected.threads ?? i18nT('m460b3574e4bd') }}</dd></dl><button class="button" @click="detailTab = 'overview'">{{ i18nT('mdfd7c5b5667a') }}</button><button class="button tm-end" :disabled="!canTerminate || actionBusy" @click="prepareAction()">{{ canTerminateGracefully ? i18nT('mc83695c23631') : i18nT('mdae848fbafae') }}</button><button v-if="canTerminateGracefully && snapshot?.capabilities.includes('terminate-force')" class="button" :disabled="!canTerminate || actionBusy" @click="prepareAction(true)">{{ i18nT('mdae848fbafae') }}</button><small v-if="!canTerminate">{{ i18nT('m9635ce35a2f6') }}</small></aside>
        <section v-if="selected" class="tm-details" :aria-label="i18nT('m9140378734a8')"><PluginUiSlot :key="selection" plugin="builtin.taskManager" point="process-details" :context="processContext" :is-current="processCurrent" :items="detailTabs.map(tab => ({ id: tab.id, label: tab.name }))" v-model:active="detailTab"><template #actions><button v-if="detailTabs.some(tab => tab.id === detailTab)" class="icon-button" :disabled="detailBusy" :aria-label="i18nT('m26220e1fa097')" :title="i18nT('m26220e1fa097')" @click="loadDetails"><PhArrowClockwise :size="16" /></button></template><div id="tm-detail-content" class="tm-detail-content">
          <template v-if="detailTab === 'overview'"><section class="tm-command-line" :aria-label="i18nT('me94cb4a7d825')"><header><strong>{{ i18nT('mfcde9d2b09cf') }}<small>{{ i18nT('me89db7c7c78e') }}</small></strong><div><button class="icon-button" :aria-label="i18nT('mb0a6dc62cfd9')" :title="i18nT('mb0a6dc62cfd9')" :disabled="commandBusy" @click="loadCommandLine"><PhArrowClockwise :size="16" /></button><button class="button" :disabled="commandLine?.commandLine == null" @click="copyCommandLine">{{ i18nT('m31910c82fcac') }}</button></div></header><p v-if="commandBusy" role="status">{{ i18nT('m6fda4af914ec') }}</p><p v-else-if="commandError" role="alert">{{ commandError }}</p><p v-else-if="commandLine?.commandLine === null">{{ commandLine.unavailable === 'permission' ? i18nT('mf039a17eb170') : i18nT('mb7093e353c8e') }}</p><pre v-else-if="commandLine?.commandLine">{{ commandLine.commandLine }}</pre><p v-else>{{ i18nT('mfc8e86e6b219') }}</p><small v-if="commandLine?.truncated">{{ i18nT('m12ccd80ba93d') }}</small></section><p>{{ i18nT('m45c21a9e1fe2') }}<strong>{{ selected.name }}</strong>{{ i18nT('md55e586f405b', { p0: (selected.pid) }) }}</p><p class="tm-muted">{{ i18nT('m4e832f9ab8d2') }}</p></template>
          <template v-else><label class="tm-search tm-resource-search"><PhMagnifyingGlass :size="16" /><input v-model="resourceQuery" :aria-label="i18nT('m5ff16a35817f')" :placeholder="i18nT('m5ff16a35817f')" /></label><p v-if="detailBusy" role="status">{{ i18nT('m6f160ba76bd9') }}</p><p v-else-if="detailError" class="tm-error" role="alert">{{ detailError }}</p><template v-else-if="details"><p v-for="reason in unavailableDetails" :key="reason" class="tm-detail-unavailable">{{ capabilityMessage(reason) }}</p>
            <table v-if="detailTab === 'files' && filteredFiles.length" v-resizable-columns="{ id: 'task-manager.files', widths: [100, 460, 120], fill: 1 }" class="tm-table"><thead><tr><th>{{ i18nT('mba40014ff496') }}</th><th>{{ i18nT('m77e1ea5c5688') }}</th><th>{{ i18nT('m3b4fb83c2c75') }}</th></tr></thead><tbody><tr v-for="(item, index) in filteredFiles" :key="index"><td>{{ item.type }}</td><td class="tm-path">{{ item.path }}</td><td>{{ item.fd }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'connections' && filteredConnections.length" v-resizable-columns="{ id: 'task-manager.connections', widths: [90, 220, 220, 120], fill: 2 }" class="tm-table"><thead><tr><th>{{ i18nT('mab2f31f30acf') }}</th><th>{{ i18nT('m65b90995c6fc') }}</th><th>{{ i18nT('m2b694f3fb1bd') }}</th><th>{{ i18nT('m6320b4a8722a') }}</th></tr></thead><tbody><tr v-for="(item, index) in filteredConnections" :key="index"><td>{{ item.protocol }}</td><td>{{ item.localAddress }}:{{ item.localPort }}</td><td>{{ item.remoteAddress }}:{{ item.remotePort }}</td><td>{{ item.state }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'modules' && filteredModules.length" v-resizable-columns="{ id: 'task-manager.modules', widths: [600], fill: 0 }" class="tm-table"><thead><tr><th>{{ i18nT('m3f3ac3e4140c') }}</th></tr></thead><tbody><tr v-for="(item, index) in filteredModules" :key="index"><td class="tm-path">{{ item }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'threads' && filteredThreads.length" v-resizable-columns="{ id: 'task-manager.threads', widths: [110, 180, 130], fill: 2 }" class="tm-table"><thead><tr><th>{{ i18nT('mfc0e96d894b6') }}</th><th>{{ i18nT('m2b67d284d8d4') }}</th><th>{{ i18nT('m6320b4a8722a') }}</th></tr></thead><tbody><tr v-for="item in filteredThreads" :key="item.id"><td>{{ item.id }}</td><td>{{ item.cpuTime == null ? '—' : item.cpuTime.toFixed(2) + i18nT('m00fe8dda1fd7') }}</td><td>{{ item.state || '—' }}</td></tr></tbody></table>
            <p v-else class="tm-table-empty">{{ resourceQuery ? i18nT('m5f6ec5fe0078') : i18nT('md1f443ca3daf') }}</p><p class="tm-muted">{{ i18nT('mc8343bf39630') }}</p>
          </template></template>
        </div></PluginUiSlot></section>
      </div>
      </div>
      <footer v-show="view !== 'history'" class="tm-status"><span><PhCheckCircle :size="14" />{{ phaseLabel }}</span><span v-if="snapshot">{{ i18nT('m4f694595b224', { p0: (new Date(snapshot.sampledAt).toLocaleTimeString(displayLocale())) }) }}<template v-if="memoryPercent !== null">{{ i18nT('m6fbc513d13eb', { p0: (formatPercent(memoryPercent)) }) }}</template></span><span>{{ i18nT('m89d642fce75f') }}</span></footer>
    </template>
    <ContextMenu v-if="processMenu" :key="processMenu.identity" :x="processMenu.x" :y="processMenu.y" :items="processMenuItems" :label="processMenu.name + ' · PID ' + processMenu.pid + i18nT('m66058626287d')" :extension="processMenuBinding" :execute="processMenuAction" @close="processMenu = undefined" />
    <dialog ref="actionDialog" class="tm-action-dialog" aria-labelledby="tm-action-title" @cancel.prevent="closeAction"><template v-if="actionPlan"><h2 id="tm-action-title">{{ actionPlan.force ? i18nT('m8a6b32aa7b26') : i18nT('mc83695c23631') }}</h2><p>{{ i18nT('m4d2d25a2888d') }}<strong>{{ actionPlan.label }}</strong></p><p>{{ i18nT('meafef337b3e2') }}<strong>{{ actionPlan.process.name }}</strong> · PID {{ actionPlan.process.pid }}</p><p>{{ i18nT('m644f82d84486', { p0: (formatStarted(actionPlan.process.startedAt)) }) }}</p><p v-if="state?.platform">{{ i18nT('mcb856a85d718', { p0: (state.platform.username) }) }}</p><p>{{ actionPlan.force ? i18nT('m66d532f98208') : i18nT('md957312713e1') }}</p><footer><button class="button" :disabled="actionBusy" @click="closeAction">{{ i18nT('m2cd0f3be8738') }}</button><button class="button tm-end" :disabled="actionBusy" @click="applyAction">{{ actionBusy ? i18nT('mcc94570401e7') : actionPlan.force ? i18nT('m1501a6194cae') : i18nT('m65a1e36a1baf') }}</button></footer></template></dialog>
  </section>
</template>

<style scoped>
.task-manager{display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;padding:24px 26px 12px;color:var(--ink)}.tm-heading{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.tm-title{display:flex;align-items:center;gap:9px;white-space:nowrap}.tm-title>svg{color:var(--accent)}.tm-title h1{font-size:var(--tm-font-metric, var(--font-body));font-weight:650;letter-spacing:-.04em}.tm-pill{font-size:var(--tm-font-caption, var(--font-body));border:1px solid var(--border);background:var(--surface-soft);border-radius:4px;padding:2px 5px}.tm-target{display:flex;align-items:center;gap:8px;border:1px solid var(--accent);background:var(--surface);border-radius:var(--control-radius);padding:0 10px;max-width:460px;min-width:180px;flex:1}.tm-target select{border:0;background:transparent;padding:9px 0;min-width:0;width:100%;outline-offset:0}.tm-target option,.tm-target optgroup{background:var(--surface);color:var(--ink)}.tm-subtitle{flex-basis:100%;color:var(--muted);font-size:var(--tm-font-caption, var(--font-body))}.tm-separator{padding:0 8px}.tm-message{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:10px 13px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft);font-size:var(--tm-font-caption, var(--font-body));overflow-wrap:anywhere}.tm-error{color:light-dark(#9a3434,#f0a6a6)}.tm-message .button{margin-left:auto;font-size:var(--tm-font-caption, var(--font-body));min-height:30px}.tm-state{display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;padding:60px 20px;flex:1}.tm-state-icon{display:grid;place-items:center;width:80px;height:80px;background:var(--surface-soft);border:1px solid var(--border);border-radius:22px;color:var(--accent)}.tm-state h2{font-size:var(--tm-font-metric, var(--font-body));font-weight:600}.tm-state>p{max-width:570px;color:var(--muted);line-height:1.9}.tm-install-facts{display:grid;grid-template-columns:auto minmax(0,1fr);text-align:left;gap:14px 24px;border:1px solid var(--border);background:var(--surface);padding:22px;border-radius:12px;font-size:var(--tm-font-process-table, var(--font-body));max-width:680px;width:100%}.tm-install-facts span{color:var(--muted)}.tm-install-facts strong{font-weight:500}.tm-install-facts code{overflow-wrap:anywhere}.tm-state-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.tm-fingerprint{display:flex;flex-direction:column;gap:10px;max-width:100%;overflow-wrap:anywhere;padding:18px;border:1px solid var(--border);background:var(--surface)}.tm-fingerprint code{word-break:break-all}.tm-state progress{max-width:360px;width:100%;accent-color:var(--accent);height:7px}.tm-metrics{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 145px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}.tm-metric{display:flex;gap:15px;align-items:center;padding:14px 18px;min-width:0;border-right:1px solid var(--border)}.tm-metric>div{flex-shrink:0}.tm-metric span,.tm-count>span{display:block;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-metric strong{display:block;font-size:var(--tm-font-heading, var(--font-body));font-weight:600;margin-top:2px}.tm-metric small{font-weight:400;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-metric svg{flex:1;min-width:50px;height:52px}.tm-chart-grid{stroke:var(--border);stroke-width:.5;fill:none}.tm-chart-line{fill:none;stroke:var(--accent);stroke-width:1.7;stroke-linejoin:round}.tm-memory .tm-chart-line{stroke:var(--metric-memory)}.tm-count{padding:14px 18px}.tm-count strong{font-size:var(--tm-font-heading, var(--font-body));line-height:1.2;display:inline-block;margin:4px 0}.tm-count small{display:block;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.tm-search{display:flex;align-items:center;gap:8px;min-width:190px;flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--control-radius);padding:0 11px;color:var(--muted)}.tm-search input{width:100%;border:0;background:transparent;padding:9px 0;min-width:0;outline-offset:0;font-size:var(--tm-font-caption, var(--font-body))}.tm-search button{padding:0}.tm-toolbar .segmented button{padding:8px 10px}.tm-interval{font-size:var(--tm-font-caption, var(--font-body));display:flex;align-items:center;gap:6px;color:var(--muted)}.tm-interval select{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px}.tm-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-height:0}.tm-body.has-selection{grid-template-columns:minmax(0,1fr) 260px}.tm-processes{min-width:0;border:1px solid var(--border);border-radius:9px;background:var(--surface);overflow:hidden;align-self:start}.tm-table-scroll{overflow:auto;max-height:clamp(270px,48dvh,650px)}.tm-table{width:100%;border-collapse:collapse;font-size:var(--tm-font-caption, var(--font-body));text-align:left;white-space:nowrap}.tm-table th{position:sticky;top:0;z-index:1;background:var(--surface-soft);font-size:var(--tm-font-caption, var(--font-body));font-weight:500;color:var(--muted);height:34px;border-bottom:1px solid var(--border)}.tm-table th,.tm-table td{padding:6px 10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent)}.tm-table th button{font:inherit;color:inherit;padding:0;width:100%;text-align:left}.tm-table tr.selected{background:color-mix(in srgb,var(--accent) 14%,var(--surface))}.tm-processes tbody tr:hover{background:var(--hover)}.tm-processes tbody tr{cursor:pointer}.tm-table td.tm-number{background:linear-gradient(to right,color-mix(in srgb,var(--accent) 12%,transparent) var(--usage),transparent var(--usage));font-variant-numeric:tabular-nums}.tm-process-name{display:flex;align-items:center;gap:7px;min-width:180px}.tm-process-name>svg{color:var(--accent)}.tm-branch{width:14px;height:18px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}.tm-name-select{padding:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm-table-footer{display:flex;align-items:center;justify-content:space-between;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);padding:6px 12px;gap:12px;border-top:1px solid var(--border)}.tm-pages{display:flex;gap:4px;align-items:center;white-space:nowrap}.tm-pages .icon-button{height:24px;width:24px}.tm-table-empty{padding:30px 18px;color:var(--muted);text-align:center;font-size:var(--tm-font-caption, var(--font-body))}.tm-inspector{grid-column:2;grid-row:1 / span 2;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:13px 16px;display:flex;flex-direction:column;gap:12px;min-width:0;align-self:start}.tm-inspector header{display:flex;align-items:center;justify-content:space-between;font-weight:600}.tm-inspector header .icon-button{width:25px;height:25px}.tm-selected-name{display:flex;align-items:center;gap:13px}.tm-selected-name>svg{color:var(--accent);flex-shrink:0}.tm-selected-name>div{min-width:0}.tm-selected-name h2{font-size:var(--tm-font-heading, var(--font-body));font-weight:600;overflow-wrap:anywhere}.tm-selected-name span{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-inspector dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px 8px;font-size:var(--tm-font-caption, var(--font-body));margin:7px 0}.tm-inspector dt{color:var(--muted)}.tm-inspector dd{margin:0;overflow-wrap:anywhere}.tm-inspector small{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-end{border-color:light-dark(#ba4b4b,#cc8585);color:light-dark(#a63a3a,#f0a6a6);background:var(--surface)}.tm-end:hover{background:color-mix(in srgb,#c64b4b 7%,var(--surface))}.tm-details{grid-column:1;border:1px solid var(--border);border-radius:9px;min-width:0;background:var(--surface);overflow:hidden}.tm-detail-tabs{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;border-bottom:1px solid var(--border)}.tm-detail-tabs>div{display:flex;overflow:auto;gap:6px}.tm-detail-tabs button[role=tab]{padding:12px 10px;border-bottom:2px solid transparent;font-size:var(--tm-font-caption, var(--font-body));white-space:nowrap;color:var(--muted)}.tm-detail-tabs button.active{border-color:var(--accent);color:var(--accent);font-weight:600}.tm-detail-content{max-height:300px;overflow:auto;padding:13px;font-size:var(--tm-font-caption, var(--font-body));line-height:1.8}.tm-detail-content>p+p{margin-top:7px}.tm-resource-search{margin-bottom:12px;max-width:440px}.tm-path{white-space:normal;overflow-wrap:anywhere;font-family:"Cascadia Code",Consolas,monospace}.tm-detail-unavailable{color:var(--muted);padding:6px 0;font-size:var(--tm-font-caption, var(--font-body))}.tm-muted{color:var(--muted);font-size:var(--tm-font-caption, var(--font-body));margin-top:10px}.tm-status{display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-top:auto;padding-top:2px}.tm-status>span{display:flex;align-items:center;gap:5px}.tm-status>span:first-child svg{color:var(--accent)}.tm-status>span:last-child{margin-left:auto}.tm-action-dialog{width:min(470px,calc(100vw - 28px));max-width:none;border:1px solid var(--border);border-radius:14px;padding:24px;color:var(--ink);background:var(--surface);box-shadow:var(--shadow)}.tm-action-dialog::backdrop{background:#101a1866}.tm-action-dialog h2{font-size:var(--tm-font-heading, var(--font-body));margin-bottom:18px}.tm-action-dialog p{font-size:var(--tm-font-process-table, var(--font-body));line-height:1.8;margin:10px 0;overflow-wrap:anywhere}.tm-action-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.tm-spinning{animation:tm-spin 1s linear infinite}@keyframes tm-spin{to{transform:rotate(360deg)}}
@media(max-width:1150px){.tm-metrics{grid-template-columns:1fr 1fr}.tm-count{display:none}.tm-memory{border-right:0}.tm-metric{flex-wrap:wrap;gap:5px}.tm-metric>div{width:100%}.tm-metric svg{width:100%}.tm-body.has-selection{grid-template-columns:minmax(0,1fr) 225px}.task-manager{padding:20px 18px 12px}}@media(max-width:850px){.tm-body.has-selection{grid-template-columns:minmax(0,1fr)}.tm-inspector{grid-column:1;grid-row:auto}.tm-inspector dl{grid-template-columns:75px 1fr 75px 1fr}.tm-inspector .button{align-self:flex-start;min-width:150px}.tm-details{grid-row:2}.tm-metric strong{font-size:var(--tm-font-heading, var(--font-body))}}@media(max-width:520px){.task-manager{padding:17px 12px 12px;gap:12px}.tm-title{width:100%}.tm-title h1{font-size:var(--tm-font-heading, var(--font-body))}.tm-target{max-width:calc(100% - 50px)}.tm-metric{padding:12px;min-width:0}.tm-metric strong{font-size:var(--tm-font-process-table, var(--font-body))}.tm-metric strong small{display:block}.tm-metric>div{flex-shrink:1}.tm-metric span>small{display:none}.tm-toolbar{gap:6px}.tm-toolbar>.tm-search{flex-basis:100%}.tm-inspector dl{grid-template-columns:75px 1fr}.tm-state{padding:32px 4px}.tm-install-facts{padding:16px;grid-template-columns:1fr;gap:5px}.tm-install-facts span:not(:first-child){margin-top:10px}.tm-state h2{font-size:var(--tm-font-heading, var(--font-body))}.tm-status{gap:8px}.tm-status>span:last-child{margin-left:0}.tm-table-footer{padding:6px 8px}.tm-details .tm-table td{max-width:260px}}
</style>
<style src="../task-manager.css"></style>
