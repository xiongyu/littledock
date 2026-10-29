<script setup lang="ts">
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
  { id: 'local', name: '本机 · 运行 WebNav 的电脑', group: '本机', target: { kind: 'local' } as TaskManagerTarget },
  ...servers.value.flatMap(server => server.connections.filter(connection => connection.type === 'ssh').map(connection => {
    const item: TaskManagerTarget = { kind: 'ssh', serverId: server.id, connectionId: connection.id }
    return { id: targetKey(item), name: `${server.name} · ${connection.name} · ${server.host}`, group: groups.value.find(group => group.id === server.groupId)?.name ?? '未分组', target: item }
  })),
])
const targetGroups = computed(() => [...new Set(targets.value.map(item => item.group))])
const currentTarget = computed(() => targets.value.find(item => item.id === target.value))
const ready = computed(() => state.value?.phase === 'ready' && connectionState.value === 'ready')
const platformName = computed(() => ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' })[state.value?.platform?.os ?? snapshot.value?.platform ?? 'linux'])
const phaseLabel = computed(() => !available.value ? '插件未启用' : connectionState.value === 'locked' ? '工作台已锁定' : connectionState.value !== 'ready' ? '本机服务未连接' : state.value ? ({ connecting: '正在连接', 'host-key': '核对 SSH 主机指纹', 'not-installed': '需要安装采集器', installing: '正在安装采集器', starting: '正在启动采集器', ready: paused.value ? '更新已暂停' : hidden.value || !props.active ? '后台暂停更新' : '正在监控', error: '连接失败', closed: '监控已停止' })[state.value.phase] : connectionLost.value ? '连接已中断' : '准备连接')
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
const detailTabs = [{ id: 'overview', name: '概览' }, { id: 'files', name: '文件' }, { id: 'connections', name: '网络' }, { id: 'modules', name: '模块' }, { id: 'threads', name: '线程' }] as const
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
    { id: 'overview', label: '查看进程详情', disabled: !canInspect },
    { id: 'connections', label: '查看网络连接', disabled: !canInspect },
    { id: 'files', label: '查看文件与句柄', disabled: !canInspect },
    { id: 'copy-name', label: '复制进程名称', separator: true },
    { id: 'copy-pid', label: '复制 PID' },
    { id: 'copy-path', label: '复制文件路径', disabled: !process?.executable },
    { id: 'search-online', label: '在线搜索进程名' },
  ]
  if (canTerminateGracefully.value) items.push({ id: 'terminate', label: '结束进程…', separator: true, danger: true, disabled: !canTerminate.value || actionBusy.value })
  if (snapshot.value?.capabilities.includes('terminate-force')) items.push({ id: 'terminate-force', label: '强制结束…', separator: !canTerminateGracefully.value, danger: true, disabled: !canTerminate.value || actionBusy.value })
  items.push({ id: 'clear', label: '取消选中', separator: true, disabled: actionBusy.value })
  return items
})
function capabilityMessage(reason: string) {
  const [category, condition] = reason.split(':')
  const name = ({ files: '文件与句柄', modules: '模块', threads: '线程', connections: '网络连接' } as Record<string, string>)[category ?? ''] ?? '部分详情'
  return condition === 'truncated' ? `${name}已达读取上限，仅显示部分记录。` : `${name}在此平台或当前用户权限下不可用。`
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : '操作失败，请检查连接。' }
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
  else if (watched.value.length >= MAX_WATCHED_PROCESSES) notice.value = `最多勾选 ${MAX_WATCHED_PROCESSES} 个进程。`
  else watched.value = addWatchedProcess(watched.value, process, snapshot.value)
  if (!watched.value.length) onlyWatched.value = false
}
function checkPage() {
  if (actionBusy.value || !snapshot.value) return
  if (pageChecked.value) { const keys = new Set(checkablePage.value.map(row => processKey(row.process))); watched.value = watched.value.filter(item => !keys.has(item.key)); if (onlyWatched.value && keys.has(selection.value)) clearSelection() }
  else { for (const row of checkablePage.value) watched.value = addWatchedProcess(watched.value, row.process, snapshot.value); if (checkablePage.value.some(row => !checkedKeys.value.has(processKey(row.process)))) notice.value = `最多勾选 ${MAX_WATCHED_PROCESSES} 个进程。` }
  if (!watched.value.length) onlyWatched.value = false
}
function toggleWatch() { clearSelection(); query.value = ''; onlyWatched.value = !onlyWatched.value; page.value = 0 }
function clearChecked() { if (onlyWatched.value) clearSelection(); watched.value = []; onlyWatched.value = false; page.value = 0 }
async function copyChecked(ids: boolean) {
  const text = ids ? watched.value.map(item => item.process.pid).join('\n') : ['名称\tPID\tCPU(%)\t内存(bytes)', ...watched.value.map(item => `${item.process.name}\t${item.process.pid}\t${item.latest?.cpuPercent ?? '未知'}\t${item.latest?.memoryBytes ?? '未采集'}`)].join('\n')
  try { await navigator.clipboard.writeText(text); emit('status', '已复制勾选进程') } catch { notice.value = '无法写入剪贴板，请允许页面访问后重试。' }
}
async function loadCommandLine() {
  const process = selected.value, id = state.value?.id, token = generation, request = ++commandGeneration
  commandLine.value = undefined; commandError.value = ''; commandBusy.value = false
  if (!process || !id || !ready.value) return
  if (process.startedAt <= 0) { commandError.value = '无法核对进程身份，暂不能读取启动参数。'; return }
  commandBusy.value = true
  try { const result = parseTaskManagerCommandLine(await rpc('taskManager.commandLine', { monitorId: id, pid: process.pid, startedAt: process.startedAt })); if (current(token) && request === commandGeneration && processKey(result) === selection.value) commandLine.value = result }
  catch (cause) { if (current(token) && request === commandGeneration) commandError.value = message(cause) }
  finally { if (current(token) && request === commandGeneration) commandBusy.value = false }
}
async function copyCommandLine() { if (commandLine.value?.commandLine == null) return; try { await navigator.clipboard.writeText(commandLine.value.commandLine); emit('status', '已复制命令行') } catch { commandError.value = '无法写入剪贴板，请允许页面访问后重试。' } }
async function disconnect(showNotice = true) {
  generation++; stopTimer(); const id = state.value?.id; state.value = undefined; clearData(); busy.value = false; refreshing.value = false; detailBusy.value = false; error.value = ''; connectionLost.value = true
  if (showNotice) notice.value = '监控已停止。目标上的其他进程继续运行。'
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
        if (selection.value && !selected.value) { clearSelection(); query.value = ''; if (!actionBusy.value) notice.value = '所选进程已不在当前采样中，已取消选中。' }
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
  catch (cause) { if (current(token)) { error.value = message(cause); notice.value = '将先核对当前状态，不会自动重复安装或确认。' } }
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
  try { await navigator.clipboard.writeText(text); if (current(token)) emit('status', '已复制') }
  catch { if (current(token)) notice.value = '无法写入剪贴板，请在进程详情中手动复制。' }
}
function changeSort(key: ProcessSort) { if (sort.value === key) descending.value = !descending.value; else { sort.value = key; descending.value = key === 'cpuPercent' || key === 'memoryBytes' } }
function sortDescription(key: ProcessSort) { return sort.value === key ? descending.value ? 'descending' : 'ascending' : 'none' }
function formatStarted(value: number) { return value > 0 ? new Date(value).toLocaleString() : '不可用' }
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
  if (plan.expiresAt <= Date.now()) { actionPlan.value = undefined; actionDialog.value?.close(); error.value = '操作确认已过期，请重新选择进程。'; return }
  actionBusy.value = true
  try {
    const result = await rpc<TaskManagerActionResult>('taskManager.applyAction', { monitorId: plan.monitorId, planId: plan.id }, true)
    if (current(token)) { notice.value = result.message ?? (result.status === 'pending' ? '已发送结束请求，进程仍在退出中。' : result.status === 'already-exited' ? '进程已经退出。' : '已确认进程退出。'); await refresh() }
  } catch (cause) { if (current(token)) { error.value = message(cause); notice.value = '请刷新进程列表核对结果。本次操作不会自动重发。' } }
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
  <section class="task-manager" aria-label="任务管理器">
    <header class="tm-heading">
      <div class="tm-title"><PhActivity :size="27" /><h1>任务管理器</h1><span class="tm-pill">{{ state?.target.kind === 'ssh' ? 'SSH' : '本机' }}</span></div>
      <label class="tm-target"><span class="visually-hidden">监控目标</span><PhHardDrives :size="19" /><select v-model="target" aria-label="监控目标" :disabled="actionBusy"><optgroup v-for="group in targetGroups" :key="group" :label="group"><option v-for="item in targets.filter(item => item.group === group)" :key="item.id" :value="item.id">{{ item.name }}</option></optgroup></select></label>
      <button v-if="state" class="icon-button" :disabled="actionBusy" aria-label="停止监控" title="停止监控" @click="disconnect()"><PhPlug :size="20" /></button>
      <button class="button tm-recording-entry" :disabled="actionBusy || !recordingSupported" :title="recordingSupported ? '持续监控' : '当前提供者不支持持续监控'" @click="view = 'history'"><PhClockCounterClockwise :size="16"/>持续监控</button>
      <p class="tm-subtitle"><template v-if="state?.platform">{{ platformName }} · {{ state.platform.arch }} · {{ state.platform.username }}@{{ state.platform.hostname }}<span class="tm-separator">·</span></template>{{ phaseLabel }}</p>
    </header>
    <p v-if="error" class="tm-message tm-error" role="alert"><PhWarningCircle :size="18" />{{ error }}<button v-if="state && !busy" class="button" @click="refresh">核对状态</button></p>
    <p v-if="notice" class="tm-message" role="status">{{ notice }}</p>
    <div class="tm-viewbar"><div role="tablist" aria-label="任务管理器视图" class="tm-main-tabs"><button role="tab" :disabled="actionBusy" :aria-selected="view === 'processes'" :class="{ active: view === 'processes' }" @click="view = 'processes'">进程</button><button role="tab" :disabled="actionBusy" :aria-selected="view === 'performance'" :class="{ active: view === 'performance' }" @click="view = 'performance'">性能</button><button role="tab" :disabled="actionBusy || !recordingSupported" :title="recordingSupported ? '历史' : '当前提供者不支持历史查询'" :aria-selected="view === 'history'" :class="{ active: view === 'history' }" @click="view = 'history'">历史</button></div><span class="tm-view-spacer"></span><template v-if="ready && view !== 'history'"><button class="icon-button" :aria-pressed="paused" :aria-label="paused ? '恢复更新' : '暂停更新'" :title="paused ? '恢复当前页面更新' : '仅暂停当前页面更新，不停止持续监控'" @click="paused = !paused"><PhPlay v-if="paused" :size="19" /><PhPause v-else :size="19" /></button><label class="tm-interval"><span>更新</span><select v-model="interval" aria-label="采样间隔"><option :value="1000">1 秒</option><option :value="2000">2 秒</option><option :value="5000">5 秒</option></select></label><button class="icon-button" :disabled="refreshing || paused" aria-label="刷新进程" title="刷新采样" @click="refresh"><PhArrowClockwise :size="19" :class="{ 'tm-spinning': refreshing }" /></button></template></div>

    <div v-if="!ready" class="tm-state" :class="{ 'tm-history-connection': view === 'history' }" role="status">
      <div class="tm-state-icon"><PhDownloadSimple v-if="state?.phase === 'not-installed'" :size="40" /><PhShieldCheck v-else-if="state?.phase === 'host-key'" :size="40" /><PhActivity v-else :size="40" /></div>
      <h2>{{ busy && !state ? '正在连接目标' : phaseLabel }}</h2>
      <template v-if="state?.phase === 'not-installed'">
        <p>此目标还没有兼容的采集器。点击后自动准备、上传并启动。</p>
        <div class="tm-install-facts"><span>安装位置</span><code>{{ state.installPath || '~/.webnav/tools' }}</code><span>运行方式</span><strong>{{ state.target.kind === 'ssh' ? '通过当前 SSH 连接采集' : '本机独立采集进程' }}</strong><span>权限</span><strong>使用当前用户，不设置开机自启</strong></div>
        <button class="button primary" :disabled="busy" @click="stateAction('install')"><PhDownloadSimple :size="18" />安装并连接</button>
      </template>
      <template v-else-if="state?.phase === 'host-key' && state.hostKey">
        <p>{{ state.hostKey.changed ? 'SSH 主机指纹已变化，请核对目标机器后再继续。' : '首次连接此 SSH 入口，请核对主机指纹。' }}</p>
        <div class="tm-fingerprint"><strong>{{ state.hostKey.host }}:{{ state.hostKey.port }}</strong><code>{{ state.hostKey.fingerprint }}</code><small v-if="state.hostKey.changed">原指纹：{{ state.hostKey.previous }}</small></div>
        <div class="tm-state-actions"><button class="button" :disabled="busy" @click="disconnect()">取消连接</button><button class="button primary" :disabled="busy" @click="stateAction('hostKeyDecision', { accept: true })">{{ state.hostKey.changed ? '确认更新指纹并继续' : '信任此主机并继续' }}</button></div>
      </template>
      <template v-else-if="busy || state?.phase === 'connecting' || state?.phase === 'installing' || state?.phase === 'starting'">
        <p>{{ state?.progress || state?.message || '正在检测系统与采集器，请稍候。' }}</p><progress aria-label="连接与安装进度"></progress><button class="button" @click="disconnect()">取消</button>
      </template>
      <template v-else>
        <p>{{ state?.message || (connectionState === 'locked' ? '解锁工作台后重新连接监控。' : !available ? '请在插件中心启用任务管理器服务。' : connectionState !== 'ready' ? '等待本机服务恢复后重新连接。' : '选择本机或已保存的 SSH 入口，查看真实运行进程。') }}</p>
        <button class="button primary" :disabled="connectionState !== 'ready' || !available || !currentTarget" @click="connect"><PhPlug :size="18" />{{ started ? '重新连接' : '连接监控' }}</button>
      </template>
    </div>
    <TaskManagerHistory v-if="currentTarget && recordingSupported" v-show="view === 'history'" :key="currentTarget.id" :active="props.active && !hidden && view === 'history'" :target-key="currentTarget.id" :target-label="state?.label || currentTarget.name" :monitor-id="state?.id" :connected="ready" :capabilities="snapshot?.capabilities"/>

    <template v-if="ready">
      <TaskManagerPerformance v-if="snapshot" v-show="view === 'performance'" :snapshot="snapshot" :history="history" :category="performanceCategory"/>
      <div v-show="view === 'processes'" class="tm-process-view">
      <div class="tm-overview">
        <button class="tm-summary-card" aria-label="查看 CPU 性能" @click="openPerformance('cpu')"><header><span>CPU</span><small>整机 · 按核查看 ›</small></header><strong>{{ formatPercent(snapshot?.cpuPercent) }}</strong><svg viewBox="0 0 240 52" preserveAspectRatio="none" role="img" aria-label="最近五分钟 CPU 趋势"><path class="tm-chart-grid" d="M0,48H240 M0,26H240 M0,4H240 M60,4V48 M120,4V48 M180,4V48"/><path :d="metricPath(history, 'cpu')" class="tm-chart-line"/></svg><footer>{{ snapshot?.cpuCount ?? '—' }} 个逻辑处理器 · {{ snapshot?.processes.length ?? '—' }} 个进程</footer></button>
        <button class="tm-summary-card tm-memory" aria-label="查看内存性能" @click="openPerformance('memory')"><header><span>内存</span><small>{{ formatPercent(memoryPercent) }} ›</small></header><strong>{{ snapshot ? formatMemory(snapshot.memory.used) : '—' }}<small> / {{ snapshot ? formatMemory(snapshot.memory.total) : '—' }}</small></strong><svg viewBox="0 0 240 52" preserveAspectRatio="none" role="img" aria-label="最近五分钟内存趋势"><path class="tm-chart-grid" d="M0,48H240 M0,26H240 M0,4H240 M60,4V48 M120,4V48 M180,4V48"/><path :d="metricPath(history, 'memory')" class="tm-chart-line"/></svg><footer>物理内存 · 查看使用曲线 ›</footer></button>
        <button class="tm-summary-card" aria-label="查看磁盘性能" @click="openPerformance('disks')"><header><span>磁盘</span><small>{{ snapshot?.performance?.disks.length ? snapshot.performance.disks.length + ' 个设备' : '未提供' }} ›</small></header><strong>{{ firstDisk ? formatPercent(firstDisk.activePercent) : '不可用' }}<small> 活动时间</small></strong><div class="tm-summary-rates"><span>读取<b>{{ formatRate(firstDisk?.readBytesPerSecond) }}</b></span><span>写入<b>{{ formatRate(firstDisk?.writeBytesPerSecond) }}</b></span></div><footer>{{ firstDisk?.name ?? '按平台与驱动能力提供' }}</footer></button>
        <button class="tm-summary-card" aria-label="查看 GPU 性能" @click="openPerformance('gpus')"><header><span>GPU</span><small>{{ snapshot?.performance?.gpus.length ? snapshot.performance.gpus.length + ' 个适配器' : '未提供' }} ›</small></header><strong>{{ firstGpu ? formatPercent(firstGpu.utilizationPercent) : '不可用' }}</strong><div class="tm-summary-rates"><span>专用显存<b>{{ firstGpu?.memoryUsedBytes == null ? '不可用' : formatMemory(firstGpu.memoryUsedBytes) }} / {{ firstGpu?.memoryTotalBytes == null ? '—' : formatMemory(firstGpu.memoryTotalBytes) }}</b></span><span v-if="firstGpu?.sharedMemoryUsedBytes !== undefined || firstGpu?.sharedMemoryTotalBytes !== undefined">共享内存<b>{{ firstGpu?.sharedMemoryUsedBytes == null ? '不可用' : formatMemory(firstGpu.sharedMemoryUsedBytes) }} / {{ firstGpu?.sharedMemoryTotalBytes == null ? '—' : formatMemory(firstGpu.sharedMemoryTotalBytes) }}</b></span></div><footer><template v-if="firstGpu?.utilizationScope === 'visible-clients'">可访问进程统计 · </template>{{ firstGpu?.name ?? '按平台与驱动能力提供' }}</footer></button>
      </div>
      <div class="tm-toolbar">
        <label class="tm-search" :class="{ 'tm-search-selected': !!selected }"><PhCheckCircle v-if="selected" :size="18" /><PhMagnifyingGlass v-else :size="18" /><span v-if="selected || query" class="tm-search-mode" :title="selected ? '仅标记选中，顺序固定、数值继续更新；输入文字改为筛选' : '按输入内容筛选进程'">{{ selected ? '已选中' : '筛选' }}</span><input :value="searchValue" :disabled="actionBusy" aria-label="搜索进程、PID、用户或路径" placeholder="搜索进程、PID、用户或路径" @input="inputSearch" @keydown.esc.prevent="clearSearch" /><button v-if="searchValue" :disabled="actionBusy" :aria-label="selected ? '取消选中进程' : '清空进程搜索'" :title="selected ? '取消选中，恢复列表排序' : '清空筛选'" @click="clearSearch"><PhX :size="16" /></button></label>
        <div class="segmented"><button :class="{ active: tree }" :aria-pressed="tree" title="进程树" aria-label="进程树" @click="tree = true"><PhTreeStructure :size="18" /></button><button :class="{ active: !tree }" :aria-pressed="!tree" title="进程列表" aria-label="进程列表" @click="tree = false"><PhList :size="18" /></button></div>
      </div>
      <div class="tm-heat-legend" aria-label="进程资源占比色阶"><span>资源占比</span><span class="heat-low">低 &lt;10%</span><span class="heat-medium">中 10–&lt;30%</span><span class="heat-high">高 30–&lt;60%</span><span class="heat-critical">很高 ≥60%</span><small>CPU：整机占比 · 内存：目标物理内存占比</small></div>
      <div v-if="watched.length" class="tm-multiselect" aria-label="勾选进程操作"><strong>已勾选 {{ watched.length }} 项</strong><button class="button" :class="{ primary: onlyWatched }" :aria-pressed="onlyWatched" :disabled="actionBusy" @click="toggleWatch">{{ onlyWatched ? '显示全部进程' : '只看勾选进程' }}</button><button class="button" @click="copyChecked(true)">复制 PID</button><button class="button" @click="copyChecked(false)">复制清单</button><TaskManagerBatchAction v-if="state && snapshot?.capabilities.some(cap => cap === 'terminate-force' || cap === 'terminate-graceful')" :key="state.id" :monitor-id="state.id" :processes="checkedLive" :force="!canTerminateGracefully" :active="ready && active" @busy="actionBusy = $event" @changed="refresh" /><button class="button" :disabled="actionBusy" @click="clearChecked">清空勾选</button></div>
      <TaskManagerWatch v-if="onlyWatched && watched.length" :items="watched" :paused="paused" :inactive="!active || hidden" />
      <div class="tm-body" :class="{ 'has-selection': !!selected }">
        <div class="tm-processes">
          <div class="tm-table-scroll"><table v-resizable-columns="{ id: 'task-manager.processes', widths: [246, 56, 64, 164, 220, 110], minimums: [120, 52, 56, 120, 90, 64], fill: 4 }" class="tm-table"><thead><tr><th :aria-sort="sortDescription('name')"><input class="tm-process-check" type="checkbox" aria-label="勾选当前页进程" :checked="pageChecked" :indeterminate="pageMixed" :disabled="actionBusy || !checkablePage.length" @change="checkPage" /><button @click="changeSort('name')">名称</button></th><th :aria-sort="sortDescription('pid')"><button @click="changeSort('pid')">PID</button></th><th :aria-sort="sortDescription('cpuPercent')"><button @click="changeSort('cpuPercent')">CPU {{ sort === 'cpuPercent' ? descending ? '↓' : '↑' : '' }}</button></th><th :aria-sort="sortDescription('memoryBytes')"><button @click="changeSort('memoryBytes')">内存</button></th><th :aria-sort="sortDescription('username')"><button @click="changeSort('username')">用户</button></th><th>状态</th></tr></thead><tbody>
            <tr v-for="row in visibleRows" :key="processKey(row.process)" :class="{ selected: selection === processKey(row.process), 'tm-row-missing': row.missing }" :aria-selected="selection === processKey(row.process)" :aria-disabled="row.missing || actionBusy" @click="!row.missing && choose(row.process)" @contextmenu.prevent.stop="openProcessMenu($event, row)" @keydown="openProcessMenu($event, row)">
              <td><div class="tm-process-entry"><input class="tm-process-check" type="checkbox" :aria-label="'勾选 ' + row.process.name + ' PID ' + row.process.pid" :checked="checkedKeys.has(processKey(row.process))" :disabled="actionBusy || (!checkedKeys.has(processKey(row.process)) && (row.missing || row.process.startedAt <= 0))" @click.stop @keydown.stop @change="checkProcess(row.process)" /><div class="tm-process-name" :style="{ paddingLeft: Math.min(row.depth, 8) * 14 + 'px' }"><button v-if="row.children" class="tm-branch" :disabled="row.missing || actionBusy" :aria-label="(collapsed.has(processKey(row.process)) ? '展开 ' : '收起 ') + row.process.name" :aria-expanded="!collapsed.has(processKey(row.process))" @click.stop="toggleBranch(row.process)"><PhCaretRight v-if="collapsed.has(processKey(row.process))" :size="13" /><PhCaretDown v-else :size="13" /></button><span v-else class="tm-branch"></span><PhCheckCircle v-if="selection === processKey(row.process)" class="tm-selected-icon" :size="16" /><PhCpu v-else :size="16" /><button class="tm-name-select" :disabled="row.missing || actionBusy" :title="row.process.executable || row.process.name" @click.stop="choose(row.process)">{{ row.process.name }}</button></div></div></td>
              <td :title="String(row.process.pid)">{{ row.process.pid }}</td><td class="tm-heat-cell" :class="'heat-' + usageHeat(row.missing ? null : row.process.cpuPercent)" :data-heat="usageHeat(row.missing ? null : row.process.cpuPercent)" :title="'CPU 整机占比 ' + formatPercent(row.missing ? null : row.process.cpuPercent)">{{ formatPercent(row.missing ? null : row.process.cpuPercent) }}</td><td class="tm-heat-cell" :class="'heat-' + usageHeat(row.missing ? null : memoryShare(row.process.memoryBytes, snapshot?.memory.total))" :data-heat="usageHeat(row.missing ? null : memoryShare(row.process.memoryBytes, snapshot?.memory.total))" :title="row.missing ? '本次未采集' : '占目标物理内存 ' + formatPercent(memoryShare(row.process.memoryBytes, snapshot?.memory.total))"><span>{{ row.missing ? '—' : formatMemory(row.process.memoryBytes) }}</span><small v-if="!row.missing">{{ formatPercent(memoryShare(row.process.memoryBytes, snapshot?.memory.total)) }}</small></td><td :title="row.process.username">{{ row.process.username || '—' }}</td><td :title="row.missing ? '本次未采集：可能已退出或不可访问，取消选中后重新排列' : row.process.status">{{ row.missing ? '本次未采集' : row.process.status || '—' }}</td>
            </tr>
          </tbody></table><div v-if="!visibleRows.length" class="tm-table-empty">{{ !snapshot ? '正在采集进程…' : query ? '没有匹配的进程' : '当前权限下没有可显示的进程' }}</div></div>
          <footer class="tm-table-footer"><span>{{ rows.length }} 项<template v-if="query">匹配</template><template v-if="selected"> · 顺序已固定</template><template v-if="snapshot?.truncated"> · 权限或采集上限导致部分进程未显示</template><template v-if="tree && query"> · 搜索以列表展示</template></span><span class="tm-pages"><button class="icon-button" :disabled="page === 0" aria-label="上一页进程" @click="page--">‹</button>{{ page + 1 }} / {{ pages }}<button class="icon-button" :disabled="page + 1 >= pages" aria-label="下一页进程" @click="page++">›</button></span></footer>
        </div>
        <aside v-if="selected" class="tm-inspector" aria-label="所选进程概览"><header><span>进程概览</span><button class="icon-button" aria-label="关闭进程详情" :disabled="actionBusy" @click="clearSearch"><PhX :size="17" /></button></header><div class="tm-selected-name"><PhCpu :size="32" /><div><h2>{{ selected.name }}</h2><span>PID {{ selected.pid }}</span></div></div><dl><dt>父进程</dt><dd>{{ selected.ppid }}</dd><dt>用户</dt><dd>{{ selected.username || '不可用' }}</dd><dt>状态</dt><dd>{{ selected.status || '不可用' }}</dd><dt>启动时间</dt><dd>{{ formatStarted(selected.startedAt) }}</dd><dt>可执行文件</dt><dd class="tm-path">{{ selected.executable || '不可用' }}</dd><dt>CPU</dt><dd>{{ formatPercent(selected.cpuPercent) }}</dd><dt>内存</dt><dd>{{ formatMemory(selected.memoryBytes) }}</dd><dt>线程</dt><dd>{{ selected.threads ?? '不可用' }}</dd></dl><button class="button" @click="detailTab = 'overview'">查看启动参数</button><button class="button tm-end" :disabled="!canTerminate || actionBusy" @click="prepareAction()">{{ canTerminateGracefully ? '结束进程' : '强制结束…' }}</button><button v-if="canTerminateGracefully && snapshot?.capabilities.includes('terminate-force')" class="button" :disabled="!canTerminate || actionBusy" @click="prepareAction(true)">强制结束…</button><small v-if="!canTerminate">当前进程或采集器不支持结束操作。</small></aside>
        <section v-if="selected" class="tm-details" aria-label="进程详情"><PluginUiSlot :key="selection" plugin="builtin.taskManager" point="process-details" :context="processContext" :is-current="processCurrent" :items="detailTabs.map(tab => ({ id: tab.id, label: tab.name }))" v-model:active="detailTab"><template #actions><button v-if="detailTabs.some(tab => tab.id === detailTab)" class="icon-button" :disabled="detailBusy" aria-label="刷新进程详情" title="刷新进程详情" @click="loadDetails"><PhArrowClockwise :size="16" /></button></template><div id="tm-detail-content" class="tm-detail-content">
          <template v-if="detailTab === 'overview'"><section class="tm-command-line" aria-label="进程启动参数"><header><strong>启动参数 <small>完整命令行</small></strong><div><button class="icon-button" aria-label="刷新启动参数" title="刷新启动参数" :disabled="commandBusy" @click="loadCommandLine"><PhArrowClockwise :size="16" /></button><button class="button" :disabled="commandLine?.commandLine == null" @click="copyCommandLine">复制命令行</button></div></header><p v-if="commandBusy" role="status">正在读取启动参数…</p><p v-else-if="commandError" role="alert">{{ commandError }}</p><p v-else-if="commandLine?.commandLine === null">{{ commandLine.unavailable === 'permission' ? '当前用户没有读取此进程启动参数的权限。' : '系统未提供启动参数，或进程受到保护。' }}</p><pre v-else-if="commandLine?.commandLine">{{ commandLine.commandLine }}</pre><p v-else>此进程没有提供命令行内容。</p><small v-if="commandLine?.truncated">内容超过上限，仅显示前 32 KiB。</small></section><p>选中 <strong>{{ selected.name }}</strong> · PID {{ selected.pid }}。点击文件、网络、模块或线程按需读取详情。</p><p class="tm-muted">CPU 按整机逻辑处理器归一；内存为工作集 / RSS。部分系统对象受当前用户权限限制。</p></template>
          <template v-else><label class="tm-search tm-resource-search"><PhMagnifyingGlass :size="16" /><input v-model="resourceQuery" aria-label="筛选当前进程资源" placeholder="筛选当前进程资源" /></label><p v-if="detailBusy" role="status">正在读取详情…</p><p v-else-if="detailError" class="tm-error" role="alert">{{ detailError }}</p><template v-else-if="details"><p v-for="reason in unavailableDetails" :key="reason" class="tm-detail-unavailable">{{ capabilityMessage(reason) }}</p>
            <table v-if="detailTab === 'files' && filteredFiles.length" v-resizable-columns="{ id: 'task-manager.files', widths: [100, 460, 120], fill: 1 }" class="tm-table"><thead><tr><th>类型</th><th>路径</th><th>FD / 句柄</th></tr></thead><tbody><tr v-for="(item, index) in filteredFiles" :key="index"><td>{{ item.type }}</td><td class="tm-path">{{ item.path }}</td><td>{{ item.fd }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'connections' && filteredConnections.length" v-resizable-columns="{ id: 'task-manager.connections', widths: [90, 220, 220, 120], fill: 2 }" class="tm-table"><thead><tr><th>协议</th><th>本地地址</th><th>远端地址</th><th>状态</th></tr></thead><tbody><tr v-for="(item, index) in filteredConnections" :key="index"><td>{{ item.protocol }}</td><td>{{ item.localAddress }}:{{ item.localPort }}</td><td>{{ item.remoteAddress }}:{{ item.remotePort }}</td><td>{{ item.state }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'modules' && filteredModules.length" v-resizable-columns="{ id: 'task-manager.modules', widths: [600], fill: 0 }" class="tm-table"><thead><tr><th>模块路径</th></tr></thead><tbody><tr v-for="(item, index) in filteredModules" :key="index"><td class="tm-path">{{ item }}</td></tr></tbody></table>
            <table v-else-if="detailTab === 'threads' && filteredThreads.length" v-resizable-columns="{ id: 'task-manager.threads', widths: [110, 180, 130], fill: 2 }" class="tm-table"><thead><tr><th>线程 ID</th><th>累计 CPU 时间</th><th>状态</th></tr></thead><tbody><tr v-for="item in filteredThreads" :key="item.id"><td>{{ item.id }}</td><td>{{ item.cpuTime == null ? '—' : item.cpuTime.toFixed(2) + ' 秒' }}</td><td>{{ item.state || '—' }}</td></tr></tbody></table>
            <p v-else class="tm-table-empty">{{ resourceQuery ? '没有匹配的资源' : '当前权限和平台下没有可显示的记录' }}</p><p class="tm-muted">按需读取，每类最多显示 200 项；详情不会随进程列表自动刷新。</p>
          </template></template>
        </div></PluginUiSlot></section>
      </div>
      </div>
      <footer v-show="view !== 'history'" class="tm-status"><span><PhCheckCircle :size="14" />{{ phaseLabel }}</span><span v-if="snapshot">采样 {{ new Date(snapshot.sampledAt).toLocaleTimeString() }}<template v-if="memoryPercent !== null"> · 内存 {{ formatPercent(memoryPercent) }}</template></span><span>页面曲线最多保留 5 分钟 · 持续监控独立记录</span></footer>
    </template>
    <ContextMenu v-if="processMenu" :key="processMenu.identity" :x="processMenu.x" :y="processMenu.y" :items="processMenuItems" :label="processMenu.name + ' · PID ' + processMenu.pid + ' 操作'" :extension="processMenuBinding" :execute="processMenuAction" @close="processMenu = undefined" />
    <dialog ref="actionDialog" class="tm-action-dialog" aria-labelledby="tm-action-title" @cancel.prevent="closeAction"><template v-if="actionPlan"><h2 id="tm-action-title">{{ actionPlan.force ? '强制结束进程' : '结束进程' }}</h2><p>目标：<strong>{{ actionPlan.label }}</strong></p><p>进程：<strong>{{ actionPlan.process.name }}</strong> · PID {{ actionPlan.process.pid }}</p><p>启动：{{ formatStarted(actionPlan.process.startedAt) }}</p><p v-if="state?.platform">操作用户：{{ state.platform.username }}</p><p>{{ actionPlan.force ? '强制结束会立即中断进程，未保存的数据可能丢失。' : '此操作会请求所选进程退出，未保存的数据可能丢失。' }}</p><footer><button class="button" :disabled="actionBusy" @click="closeAction">取消</button><button class="button tm-end" :disabled="actionBusy" @click="applyAction">{{ actionBusy ? '正在核对结果…' : actionPlan.force ? '确认强制结束' : '确认结束' }}</button></footer></template></dialog>
  </section>
</template>

<style scoped>
.task-manager{display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;padding:24px 26px 12px;color:var(--ink)}.tm-heading{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.tm-title{display:flex;align-items:center;gap:9px;white-space:nowrap}.tm-title>svg{color:var(--accent)}.tm-title h1{font-size:var(--tm-font-metric, var(--font-body));font-weight:650;letter-spacing:-.04em}.tm-pill{font-size:var(--tm-font-caption, var(--font-body));border:1px solid var(--border);background:var(--surface-soft);border-radius:4px;padding:2px 5px}.tm-target{display:flex;align-items:center;gap:8px;border:1px solid var(--accent);background:var(--surface);border-radius:var(--control-radius);padding:0 10px;max-width:460px;min-width:180px;flex:1}.tm-target select{border:0;background:transparent;padding:9px 0;min-width:0;width:100%;outline-offset:0}.tm-target option,.tm-target optgroup{background:var(--surface);color:var(--ink)}.tm-subtitle{flex-basis:100%;color:var(--muted);font-size:var(--tm-font-caption, var(--font-body))}.tm-separator{padding:0 8px}.tm-message{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:10px 13px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft);font-size:var(--tm-font-caption, var(--font-body));overflow-wrap:anywhere}.tm-error{color:light-dark(#9a3434,#f0a6a6)}.tm-message .button{margin-left:auto;font-size:var(--tm-font-caption, var(--font-body));min-height:30px}.tm-state{display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;padding:60px 20px;flex:1}.tm-state-icon{display:grid;place-items:center;width:80px;height:80px;background:var(--surface-soft);border:1px solid var(--border);border-radius:22px;color:var(--accent)}.tm-state h2{font-size:var(--tm-font-metric, var(--font-body));font-weight:600}.tm-state>p{max-width:570px;color:var(--muted);line-height:1.9}.tm-install-facts{display:grid;grid-template-columns:auto minmax(0,1fr);text-align:left;gap:14px 24px;border:1px solid var(--border);background:var(--surface);padding:22px;border-radius:12px;font-size:var(--tm-font-process-table, var(--font-body));max-width:680px;width:100%}.tm-install-facts span{color:var(--muted)}.tm-install-facts strong{font-weight:500}.tm-install-facts code{overflow-wrap:anywhere}.tm-state-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.tm-fingerprint{display:flex;flex-direction:column;gap:10px;max-width:100%;overflow-wrap:anywhere;padding:18px;border:1px solid var(--border);background:var(--surface)}.tm-fingerprint code{word-break:break-all}.tm-state progress{max-width:360px;width:100%;accent-color:var(--accent);height:7px}.tm-metrics{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 145px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}.tm-metric{display:flex;gap:15px;align-items:center;padding:14px 18px;min-width:0;border-right:1px solid var(--border)}.tm-metric>div{flex-shrink:0}.tm-metric span,.tm-count>span{display:block;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-metric strong{display:block;font-size:var(--tm-font-heading, var(--font-body));font-weight:600;margin-top:2px}.tm-metric small{font-weight:400;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-metric svg{flex:1;min-width:50px;height:52px}.tm-chart-grid{stroke:var(--border);stroke-width:.5;fill:none}.tm-chart-line{fill:none;stroke:var(--accent);stroke-width:1.7;stroke-linejoin:round}.tm-memory .tm-chart-line{stroke:var(--metric-memory)}.tm-count{padding:14px 18px}.tm-count strong{font-size:var(--tm-font-heading, var(--font-body));line-height:1.2;display:inline-block;margin:4px 0}.tm-count small{display:block;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.tm-search{display:flex;align-items:center;gap:8px;min-width:190px;flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--control-radius);padding:0 11px;color:var(--muted)}.tm-search input{width:100%;border:0;background:transparent;padding:9px 0;min-width:0;outline-offset:0;font-size:var(--tm-font-caption, var(--font-body))}.tm-search button{padding:0}.tm-toolbar .segmented button{padding:8px 10px}.tm-interval{font-size:var(--tm-font-caption, var(--font-body));display:flex;align-items:center;gap:6px;color:var(--muted)}.tm-interval select{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px}.tm-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-height:0}.tm-body.has-selection{grid-template-columns:minmax(0,1fr) 260px}.tm-processes{min-width:0;border:1px solid var(--border);border-radius:9px;background:var(--surface);overflow:hidden;align-self:start}.tm-table-scroll{overflow:auto;max-height:clamp(270px,48dvh,650px)}.tm-table{width:100%;border-collapse:collapse;font-size:var(--tm-font-caption, var(--font-body));text-align:left;white-space:nowrap}.tm-table th{position:sticky;top:0;z-index:1;background:var(--surface-soft);font-size:var(--tm-font-caption, var(--font-body));font-weight:500;color:var(--muted);height:34px;border-bottom:1px solid var(--border)}.tm-table th,.tm-table td{padding:6px 10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent)}.tm-table th button{font:inherit;color:inherit;padding:0;width:100%;text-align:left}.tm-table tr.selected{background:color-mix(in srgb,var(--accent) 14%,var(--surface))}.tm-processes tbody tr:hover{background:var(--hover)}.tm-processes tbody tr{cursor:pointer}.tm-table td.tm-number{background:linear-gradient(to right,color-mix(in srgb,var(--accent) 12%,transparent) var(--usage),transparent var(--usage));font-variant-numeric:tabular-nums}.tm-process-name{display:flex;align-items:center;gap:7px;min-width:180px}.tm-process-name>svg{color:var(--accent)}.tm-branch{width:14px;height:18px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}.tm-name-select{padding:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm-table-footer{display:flex;align-items:center;justify-content:space-between;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);padding:6px 12px;gap:12px;border-top:1px solid var(--border)}.tm-pages{display:flex;gap:4px;align-items:center;white-space:nowrap}.tm-pages .icon-button{height:24px;width:24px}.tm-table-empty{padding:30px 18px;color:var(--muted);text-align:center;font-size:var(--tm-font-caption, var(--font-body))}.tm-inspector{grid-column:2;grid-row:1 / span 2;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:13px 16px;display:flex;flex-direction:column;gap:12px;min-width:0;align-self:start}.tm-inspector header{display:flex;align-items:center;justify-content:space-between;font-weight:600}.tm-inspector header .icon-button{width:25px;height:25px}.tm-selected-name{display:flex;align-items:center;gap:13px}.tm-selected-name>svg{color:var(--accent);flex-shrink:0}.tm-selected-name>div{min-width:0}.tm-selected-name h2{font-size:var(--tm-font-heading, var(--font-body));font-weight:600;overflow-wrap:anywhere}.tm-selected-name span{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-inspector dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px 8px;font-size:var(--tm-font-caption, var(--font-body));margin:7px 0}.tm-inspector dt{color:var(--muted)}.tm-inspector dd{margin:0;overflow-wrap:anywhere}.tm-inspector small{font-size:var(--tm-font-caption, var(--font-body));color:var(--muted)}.tm-end{border-color:light-dark(#ba4b4b,#cc8585);color:light-dark(#a63a3a,#f0a6a6);background:var(--surface)}.tm-end:hover{background:color-mix(in srgb,#c64b4b 7%,var(--surface))}.tm-details{grid-column:1;border:1px solid var(--border);border-radius:9px;min-width:0;background:var(--surface);overflow:hidden}.tm-detail-tabs{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;border-bottom:1px solid var(--border)}.tm-detail-tabs>div{display:flex;overflow:auto;gap:6px}.tm-detail-tabs button[role=tab]{padding:12px 10px;border-bottom:2px solid transparent;font-size:var(--tm-font-caption, var(--font-body));white-space:nowrap;color:var(--muted)}.tm-detail-tabs button.active{border-color:var(--accent);color:var(--accent);font-weight:600}.tm-detail-content{max-height:300px;overflow:auto;padding:13px;font-size:var(--tm-font-caption, var(--font-body));line-height:1.8}.tm-detail-content>p+p{margin-top:7px}.tm-resource-search{margin-bottom:12px;max-width:440px}.tm-path{white-space:normal;overflow-wrap:anywhere;font-family:"Cascadia Code",Consolas,monospace}.tm-detail-unavailable{color:var(--muted);padding:6px 0;font-size:var(--tm-font-caption, var(--font-body))}.tm-muted{color:var(--muted);font-size:var(--tm-font-caption, var(--font-body));margin-top:10px}.tm-status{display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:var(--tm-font-caption, var(--font-body));color:var(--muted);margin-top:auto;padding-top:2px}.tm-status>span{display:flex;align-items:center;gap:5px}.tm-status>span:first-child svg{color:var(--accent)}.tm-status>span:last-child{margin-left:auto}.tm-action-dialog{width:min(470px,calc(100vw - 28px));max-width:none;border:1px solid var(--border);border-radius:14px;padding:24px;color:var(--ink);background:var(--surface);box-shadow:var(--shadow)}.tm-action-dialog::backdrop{background:#101a1866}.tm-action-dialog h2{font-size:var(--tm-font-heading, var(--font-body));margin-bottom:18px}.tm-action-dialog p{font-size:var(--tm-font-process-table, var(--font-body));line-height:1.8;margin:10px 0;overflow-wrap:anywhere}.tm-action-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}.tm-spinning{animation:tm-spin 1s linear infinite}@keyframes tm-spin{to{transform:rotate(360deg)}}
@media(max-width:1150px){.tm-metrics{grid-template-columns:1fr 1fr}.tm-count{display:none}.tm-memory{border-right:0}.tm-metric{flex-wrap:wrap;gap:5px}.tm-metric>div{width:100%}.tm-metric svg{width:100%}.tm-body.has-selection{grid-template-columns:minmax(0,1fr) 225px}.task-manager{padding:20px 18px 12px}}@media(max-width:850px){.tm-body.has-selection{grid-template-columns:minmax(0,1fr)}.tm-inspector{grid-column:1;grid-row:auto}.tm-inspector dl{grid-template-columns:75px 1fr 75px 1fr}.tm-inspector .button{align-self:flex-start;min-width:150px}.tm-details{grid-row:2}.tm-metric strong{font-size:var(--tm-font-heading, var(--font-body))}}@media(max-width:520px){.task-manager{padding:17px 12px 12px;gap:12px}.tm-title{width:100%}.tm-title h1{font-size:var(--tm-font-heading, var(--font-body))}.tm-target{max-width:calc(100% - 50px)}.tm-metric{padding:12px;min-width:0}.tm-metric strong{font-size:var(--tm-font-process-table, var(--font-body))}.tm-metric strong small{display:block}.tm-metric>div{flex-shrink:1}.tm-metric span>small{display:none}.tm-toolbar{gap:6px}.tm-toolbar>.tm-search{flex-basis:100%}.tm-inspector dl{grid-template-columns:75px 1fr}.tm-state{padding:32px 4px}.tm-install-facts{padding:16px;grid-template-columns:1fr;gap:5px}.tm-install-facts span:not(:first-child){margin-top:10px}.tm-state h2{font-size:var(--tm-font-heading, var(--font-body))}.tm-status{gap:8px}.tm-status>span:last-child{margin-left:0}.tm-table-footer{padding:6px 8px}.tm-details .tm-table td{max-width:260px}}
</style>
<style src="../task-manager.css"></style>
