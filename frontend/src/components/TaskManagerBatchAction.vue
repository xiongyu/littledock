<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.taskManager')

import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { TaskManagerActionPlan, TaskManagerActionResult, TaskManagerProcess } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
const props = defineProps<{ monitorId: string; processes: TaskManagerProcess[]; force: boolean; active: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; changed: [] }>()
const dialog = ref<HTMLDialogElement>(), rows = ref<{ process: TaskManagerProcess; plan?: TaskManagerActionPlan; status: keyof typeof import('../../../backend/plugins/builtin.taskManager/locales/zh-CN.json') }[]>([])
const busy = ref(false), applied = ref(false), notice = ref('')
const available = computed(() => connectionState.value === 'ready' && props.active && props.processes.length > 0 && props.processes.length <= 16)
let generation = 0
function setBusy(value: boolean) { busy.value = value; emit('busy', value) }
async function open() {
  if (!available.value || busy.value) return
  const token = ++generation, id = props.monitorId
  rows.value = props.processes.map(process => ({ process: { ...process }, status: 'mf5475c6e0b98' })); applied.value = false; notice.value = ''; setBusy(true)
  await nextTick(); dialog.value?.showModal()
  for (const row of rows.value) {
    if (token !== generation || connectionState.value !== 'ready' || props.monitorId !== id) break
    try { const plan = await rpc<TaskManagerActionPlan>('taskManager.prepareAction', { monitorId: id, pid: row.process.pid, startedAt: row.process.startedAt, force: props.force }, true); if (token === generation) { row.plan = plan; row.status = 'ma8b0bd9c65f7' } }
    catch { if (token === generation) row.status = 'm1ae8ac5c87c9' }
  }
  if (token === generation) setBusy(false)
}
async function apply() {
  if (busy.value || applied.value || connectionState.value !== 'ready') return
  if (rows.value.some(row => row.plan && row.plan.expiresAt <= Date.now())) { notice.value = i18nT('ma264da6461e4'); return }
  const token = generation, id = props.monitorId; applied.value = true; setBusy(true)
  for (const row of rows.value) {
    if (!row.plan) continue
    if (token !== generation || connectionState.value !== 'ready' || props.monitorId !== id) break
    row.status = 'm195f0f04971f'
    try {
      const result = await rpc<TaskManagerActionResult>('taskManager.applyAction', { monitorId: id, planId: row.plan.id }, true)
      if (token !== generation) break
      row.status = result.status === 'pending' ? 'mb36eaa444957' : 'm899df7e24472'
    } catch {
      if (token !== generation) break
      row.status = 'm566268286eee'; notice.value = i18nT('mf8bb0fad303d'); break
    }
  }
  if (token === generation) { for (const row of rows.value) if (row.status === 'ma8b0bd9c65f7') row.status = 'm231fe2204265'; setBusy(false); emit('changed') }
}
function close() { if (busy.value) return; generation++; dialog.value?.close(); rows.value = [] }
onBeforeUnmount(() => { generation++; dialog.value?.close(); emit('busy', false) })
</script>
<template>
  <button class="button tm-end" :disabled="!available || busy" :title="processes.length > 16 ? i18nT('maea030d130ab') : undefined" @click="open">{{ force ? i18nT('m5b88ff7d326a') : i18nT('m1406c0a6ece8') }}</button>
  <dialog ref="dialog" class="tm-action-dialog tm-batch-dialog" @cancel.prevent="close">
    <h2>{{ force ? i18nT('md68a9c84781f') : i18nT('mfe7aa9f22874') }}</h2><p>{{ i18nT('m8b3b24dea190', { p0: (rows.length) }) }}</p>
    <ul><li v-for="row in rows" :key="row.process.pid + ':' + row.process.startedAt"><strong>{{ row.process.name }}</strong><span>PID {{ row.process.pid }} · {{ i18nT(row.status) }}</span></li></ul>
    <p v-if="notice" role="status">{{ notice }}</p><footer><button class="button" :disabled="busy" @click="close">{{ applied ? i18nT('m3fd47edce45b') : i18nT('m2cd0f3be8738') }}</button><button v-if="!applied" class="button danger" :disabled="busy || !rows.some(row => row.plan) || !!notice" @click="apply">{{ i18nT('me2b09712c834', { p0: (force ? i18nT('m7210d42aa69e') : i18nT('mc7b24e7997e9')), p1: (rows.filter(row => row.plan).length) }) }}</button></footer>
  </dialog>
</template>
