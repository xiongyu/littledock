<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { TaskManagerActionPlan, TaskManagerActionResult, TaskManagerProcess } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
const props = defineProps<{ monitorId: string; processes: TaskManagerProcess[]; force: boolean; active: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; changed: [] }>()
const dialog = ref<HTMLDialogElement>(), rows = ref<{ process: TaskManagerProcess; plan?: TaskManagerActionPlan; status: string }[]>([])
const busy = ref(false), applied = ref(false), notice = ref('')
const available = computed(() => connectionState.value === 'ready' && props.active && props.processes.length > 0 && props.processes.length <= 16)
let generation = 0
function setBusy(value: boolean) { busy.value = value; emit('busy', value) }
async function open() {
  if (!available.value || busy.value) return
  const token = ++generation, id = props.monitorId
  rows.value = props.processes.map(process => ({ process: { ...process }, status: '准备确认…' })); applied.value = false; notice.value = ''; setBusy(true)
  await nextTick(); dialog.value?.showModal()
  for (const row of rows.value) {
    if (token !== generation || connectionState.value !== 'ready' || props.monitorId !== id) break
    try { const plan = await rpc<TaskManagerActionPlan>('taskManager.prepareAction', { monitorId: id, pid: row.process.pid, startedAt: row.process.startedAt, force: props.force }, true); if (token === generation) { row.plan = plan; row.status = '待确认' } }
    catch { if (token === generation) row.status = '无法准备：进程变化、受保护或权限不足' }
  }
  if (token === generation) setBusy(false)
}
async function apply() {
  if (busy.value || applied.value || connectionState.value !== 'ready') return
  if (rows.value.some(row => row.plan && row.plan.expiresAt <= Date.now())) { notice.value = '确认已过期，请关闭并重新选择。'; return }
  const token = generation, id = props.monitorId; applied.value = true; setBusy(true)
  for (const row of rows.value) {
    if (!row.plan) continue
    if (token !== generation || connectionState.value !== 'ready' || props.monitorId !== id) break
    row.status = '执行中…'
    try {
      const result = await rpc<TaskManagerActionResult>('taskManager.applyAction', { monitorId: id, planId: row.plan.id }, true)
      if (token !== generation) break
      row.status = result.status === 'pending' ? '已发送，等待退出' : '已退出'
    } catch {
      if (token !== generation) break
      row.status = '失败或结果未知，请核对'; notice.value = '已停止后续操作，未自动重试。请刷新核对各进程。'; break
    }
  }
  if (token === generation) { for (const row of rows.value) if (row.status === '待确认') row.status = '未执行'; setBusy(false); emit('changed') }
}
function close() { if (busy.value) return; generation++; dialog.value?.close(); rows.value = [] }
onBeforeUnmount(() => { generation++; dialog.value?.close(); emit('busy', false) })
</script>
<template>
  <button class="button tm-end" :disabled="!available || busy" :title="processes.length > 16 ? '结束操作每次最多 16 个进程' : undefined" @click="open">{{ force ? '强制结束勾选…' : '结束勾选…' }}</button>
  <dialog ref="dialog" class="tm-action-dialog tm-batch-dialog" @cancel.prevent="close">
    <h2>{{ force ? '强制结束勾选进程' : '结束勾选进程' }}</h2><p>将处理以下 {{ rows.length }} 个进程，未保存的数据可能丢失。</p>
    <ul><li v-for="row in rows" :key="row.process.pid + ':' + row.process.startedAt"><strong>{{ row.process.name }}</strong><span>PID {{ row.process.pid }} · {{ row.status }}</span></li></ul>
    <p v-if="notice" role="status">{{ notice }}</p><footer><button class="button" :disabled="busy" @click="close">{{ applied ? '关闭' : '取消' }}</button><button v-if="!applied" class="button danger" :disabled="busy || !rows.some(row => row.plan) || !!notice" @click="apply">确认{{ force ? '强制结束' : '结束' }} {{ rows.filter(row => row.plan).length }} 个进程</button></footer>
  </dialog>
</template>
