<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { PhHardDrives, PhFolderSimple, PhPlus, PhPencilSimple, PhTrash, PhCopy, PhDownloadSimple, PhUploadSimple, PhX, PhCheck, PhMagnifyingGlass, PhArrowRight, PhStar } from '@phosphor-icons/vue'
import { groupDescendants, orderedGroups, protocolNames } from '../catalog'
import type { Group, Protocol, Server } from '../catalog'
import { MAX_CATALOG_BYTES, parseCatalogImport, serializeCatalog, validateGroups } from '../catalog-management'
import type { CatalogDocument } from '../catalog-management'
import { rpc, synchronize } from '../backend'

const props = defineProps<{ servers: Server[]; groups: Group[]; query: string; initialTab: 'servers' | 'groups'; commit: (groups: Group[], servers: Server[]) => Promise<void> }>()
const emit = defineEmits<{ edit: [server?: Server]; replace: [groups: Group[], servers: Server[]]; notify: [message: string]; clearSearch: [] }>()
const tab = ref(props.initialTab)
watch(() => props.initialTab, value => { tab.value = value })
const groupFilter = ref('all')
const protocol = ref<Protocol | 'all'>('all')
const checked = ref<string[]>([])
const moveTarget = ref('')
watch(() => props.groups, groups => {
  if (moveTarget.value && !groups.some(group => group.id === moveTarget.value)) moveTarget.value = ''
  if (groupFilter.value !== 'all' && groupFilter.value && !groups.some(group => group.id === groupFilter.value)) groupFilter.value = 'all'
})
const groupOptions = computed(() => orderedGroups(props.groups))
const groupLabel = (id: string) => props.groups.find(group => group.id === id)?.name ?? '未分组'
const filtered = computed(() => {
  const descendants = groupDescendants(groupFilter.value, props.groups)
  const text = props.query.trim().toLocaleLowerCase()
  return props.servers.filter(server => (groupFilter.value === 'all' || descendants.has(server.groupId)) && (protocol.value === 'all' || server.connections.some(connection => connection.type === protocol.value)) && [server.name, server.host, server.note, groupLabel(server.groupId), ...server.tags, ...server.connections.map(connection => connection.name)].join(' ').toLocaleLowerCase().includes(text))
})
watch([filtered, tab], () => { checked.value = [] })
const allChecked = computed(() => filtered.value.length > 0 && checked.value.length === filtered.value.length)
function toggleAll() { checked.value = allChecked.value ? [] : filtered.value.map(server => server.id) }
async function replace(groups: Group[], servers: Server[], message: string): Promise<boolean> {
  try { serializeCatalog(groups, servers) } catch (cause) { emit('notify', cause instanceof Error ? cause.message : '配置超出容量限制。'); return false }
  try { await props.commit(groups, servers); emit('notify', message); return true } catch (cause) { emit('notify', cause instanceof Error ? cause.message : '保存失败。'); return false }
}
function moveServers() {
  if (moveTarget.value && !props.groups.some(group => group.id === moveTarget.value)) { emit('notify', '目标分组已不存在，请重新选择。'); moveTarget.value = ''; return }
  replace(props.groups, props.servers.map(server => checked.value.includes(server.id) ? { ...server, groupId: moveTarget.value } : server), `已移动 ${checked.value.length} 台服务器。`)
}
async function duplicate(server: Server) {
  const copy: Server = { ...server, id: crypto.randomUUID(), name: `${server.name.slice(0, 55)} 副本`, favorite: false, tags: [...server.tags], connections: server.connections.map(connection => ({ ...connection, id: crypto.randomUUID() })) }
  if (await replace(props.groups, [...props.servers, copy], '已复制服务器，可以继续编辑。')) emit('edit', copy)
}

const groupDraft = reactive({ id: '', name: '', parentId: '' })
const groupError = ref('')
const visibleGroups = computed(() => groupOptions.value.filter(group => group.name.toLocaleLowerCase().includes(props.query.trim().toLocaleLowerCase())))
const parents = computed(() => groupOptions.value.filter(group => !groupDescendants(groupDraft.id, props.groups).has(group.id)))
function editGroup(group?: Group) { Object.assign(groupDraft, { id: group?.id ?? '', name: group?.name ?? '', parentId: group?.parentId ?? '' }); groupError.value = '' }
async function saveGroup() {
  const group: Group = { id: groupDraft.id || crypto.randomUUID(), name: groupDraft.name.trim(), ...(groupDraft.parentId ? { parentId: groupDraft.parentId } : {}) }
  const groups = groupDraft.id ? props.groups.map(item => item.id === group.id ? group : item) : [...props.groups, group]
  try { validateGroups(groups); if (await replace(groups, props.servers, '分组已保存。')) editGroup(group) } catch (cause) { groupError.value = cause instanceof Error ? cause.message : '分组配置不正确。' }
}

const confirmDialog = ref<HTMLDialogElement>()
const confirmTitle = ref('')
const confirmText = ref('')
let confirmAction: (() => unknown) | undefined
async function confirm(title: string, text: string, action: () => unknown) { confirmTitle.value = title; confirmText.value = text; confirmAction = action; await nextTick(); confirmDialog.value?.showModal() }
async function applyConfirmed() { await confirmAction?.(); confirmAction = undefined; confirmDialog.value?.close() }
function removeServers(ids: string[]) {
  void confirm(`删除 ${ids.length} 台服务器？`, '同时移除这些服务器的连接入口和收藏。保存到本机数据库。', () => replace(props.groups, props.servers.filter(server => !ids.includes(server.id)), `已删除 ${ids.length} 台服务器。`))
}
function removeGroup(group: Group) {
  const count = props.servers.filter(server => server.groupId === group.id).length
  void confirm(`删除“${group.name}”？`, `${count} 台直属服务器将移到未分组；子分组移到它的上级，服务器不会被删除。`, async () => {
    const groups = props.groups.filter(item => item.id !== group.id).map(item => item.parentId === group.id ? { id: item.id, name: item.name, ...(group.parentId ? { parentId: group.parentId } : {}) } : item)
    try { validateGroups(groups); await replace(groups, props.servers.map(server => server.groupId === group.id ? { ...server, groupId: '' } : server), '分组已删除，服务器已保留。'); editGroup() } catch (cause) { emit('notify', `${cause instanceof Error ? cause.message : '无法删除'} 请先调整同名子分组。`) }
  })
}

const importDialog = ref<HTMLDialogElement>()
const importFile = ref<HTMLInputElement>()
const importText = ref('')
const importError = ref('')
const importDraft = ref<CatalogDocument>()
const importToken = ref('')
const importWarnings = ref<string[]>([])
const importBusy = ref(false)
let importGeneration = 0
watch(importText, () => { importGeneration++; importDraft.value = undefined; importToken.value = ''; importWarnings.value = []; importError.value = ''; importBusy.value = false }, {flush:'sync'})
async function openImport() { importGeneration++; importBusy.value = false; importText.value = ''; importDraft.value = undefined; importToken.value = ''; importWarnings.value = []; importError.value = ''; await nextTick(); importDialog.value?.showModal() }
function closeImport() { importGeneration++; importBusy.value = false; importDialog.value?.close() }
async function readImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file) return
  importDraft.value = undefined; importText.value = ''; importError.value = ''; importBusy.value = false
  const generation = ++importGeneration
  await nextTick()
  if (file.size > MAX_CATALOG_BYTES) { importError.value = '配置文件不能超过 1 MiB。'; return }
  importBusy.value = true
  try { const content = await file.text(); if (generation === importGeneration) { importText.value = content; await previewImport() } } catch { if (generation === importGeneration) importError.value = '无法读取这个文件。' } finally { if (generation === importGeneration) importBusy.value = false }
}
async function previewImport() {
  const generation=++importGeneration
  importDraft.value=undefined;importToken.value='';importBusy.value=true
  try {
    if(new TextEncoder().encode(importText.value).byteLength>MAX_CATALOG_BYTES)throw new Error('配置不能超过 1 MiB。')
    const result=await rpc<{token:string;catalog:CatalogDocument}>('imports.preview',{catalog:JSON.parse(importText.value)})
    if(generation!==importGeneration)return
    importToken.value=result.token;importDraft.value=parseCatalogImport(result.catalog);importError.value=''
  } catch(cause) { if(generation===importGeneration)importError.value=cause instanceof SyntaxError?'JSON 格式不正确，请检查内容。':cause instanceof Error?cause.message:'无法导入。' }
  finally {if(generation===importGeneration)importBusy.value=false}
}
async function importLocalSsh() {
  await openImport();const generation=++importGeneration;importBusy.value=true
  try {const result=await rpc<{token:string;catalog:CatalogDocument;warnings:string[]}>('ssh.importPreview');if(generation!==importGeneration)return;importDraft.value=parseCatalogImport(result.catalog);importToken.value=result.token;importWarnings.value=result.warnings}
  catch(cause){if(generation===importGeneration)importError.value=cause instanceof Error?cause.message:'读取 SSH 配置失败。'}
  finally {if(generation===importGeneration)importBusy.value=false}
}
async function applyImport() {
  if (!importDraft.value || importBusy.value) return
  importBusy.value = true
  try { await rpc('imports.apply', { token: importToken.value }, true); await synchronize(); groupFilter.value = 'all'; protocol.value = 'all'; editGroup(); emit('clearSearch'); closeImport(); emit('notify', '已导入本机数据库；未启动任何连接。') } catch (cause) { importError.value = cause instanceof Error ? cause.message : '导入失败。' } finally { importBusy.value = false }
}
async function exportConfig() {
  try { const result = await rpc<{ text: string }>('exports.config'); const url = URL.createObjectURL(new Blob([result.text], { type: 'application/json' })); const anchor = documentElement(url); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); emit('notify', '已导出配置，不包含凭据或会话历史。') } catch (cause) { emit('notify', cause instanceof Error ? cause.message : '导出失败。') }
}
function documentElement(url: string) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'webnav-config.json'; document.body.appendChild(anchor); return anchor }
</script>

<template>
  <section class="management-page" aria-label="管理中心">
    <div class="management-topline"><div class="management-tabs" aria-label="管理类别"><button :class="{ active: tab === 'servers' }" :aria-pressed="tab === 'servers'" @click="tab = 'servers'"><PhHardDrives :size="18" />服务器 <small>{{ servers.length }}</small></button><button :class="{ active: tab === 'groups' }" :aria-pressed="tab === 'groups'" @click="tab = 'groups'"><PhFolderSimple :size="18" />分组 <small>{{ groups.length }}</small></button></div><div class="management-actions"><button class="button" @click="importLocalSsh">导入本机 SSH</button><button class="icon-button" aria-label="导入配置" title="导入配置" @click="openImport"><PhUploadSimple :size="19" /></button><button class="icon-button" aria-label="导出配置" title="导出配置" @click="exportConfig"><PhDownloadSimple :size="19" /></button><button class="button primary" @click="tab === 'servers' ? emit('edit') : editGroup()"><PhPlus :size="18" />{{ tab === 'servers' ? '添加服务器' : '新建分组' }}</button></div></div>
    <p class="management-notice">修改保存到本机数据库，刷新后保留。</p>

    <template v-if="tab === 'servers'">
      <div class="management-filter"><label><span class="visually-hidden">管理分组筛选</span><select v-model="groupFilter" aria-label="管理分组筛选"><option value="all">全部分组</option><option value="">未分组</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label><div class="segmented"><button v-for="type in ['all','ssh','rdp','web'] as const" :key="type" :class="{ active: protocol === type }" :aria-pressed="protocol === type" @click="protocol = type">{{ type === 'all' ? '全部' : protocolNames[type] }}</button></div><span class="management-result">{{ filtered.length }} 台服务器 · {{ filtered.reduce((sum, server) => sum + server.connections.length, 0) }} 个入口</span></div>
      <div v-if="checked.length" class="bulk-toolbar"><span>已选 {{ checked.length }} 项</span><select v-model="moveTarget" aria-label="批量移动目标分组"><option value="">未分组</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select><button class="icon-button" aria-label="移动选中服务器" title="移动到所选分组" @click="moveServers"><PhArrowRight :size="18" /></button><button class="icon-button" aria-label="删除选中服务器" title="删除选中服务器" @click="removeServers([...checked])"><PhTrash :size="18" /></button><button class="icon-button" aria-label="取消选择" title="取消选择" @click="checked = []"><PhX :size="18" /></button></div>
      <div v-if="filtered.length" class="management-table-wrap"><table class="management-table"><thead><tr><th class="selection-cell"><input type="checkbox" :checked="allChecked" :indeterminate="checked.length > 0 && !allChecked" aria-label="选择当前筛选的全部服务器" @change="toggleAll" /></th><th>服务器</th><th>分组 / 标签</th><th>连接入口</th><th class="management-operations">操作</th></tr></thead><tbody><tr v-for="server in filtered" :key="server.id" :class="{ selected: checked.includes(server.id) }"><td class="selection-cell"><input v-model="checked" type="checkbox" :value="server.id" :aria-label="`选择${server.name}`" /></td><td><button class="management-server-name" :title="`编辑${server.name}`" @click="emit('edit', server)">{{ server.name }}<PhStar v-if="server.favorite" :size="13" weight="fill" /></button><span class="server-address">{{ server.host }}</span></td><td><span class="management-group">{{ groupLabel(server.groupId) }}</span><div class="management-tags"><span v-for="tag in server.tags" :key="tag">{{ tag }}</span></div></td><td><div class="management-connections"><span v-for="connection in server.connections" :key="connection.id" :title="`${connection.name} · ${connection.type === 'web' ? connection.url : connection.port}`">{{ protocolNames[connection.type] }}<small>{{ connection.type === 'web' ? connection.name : connection.port }}</small></span></div></td><td><div class="management-row-actions"><button class="icon-button" :aria-label="`编辑${server.name}`" title="编辑" @click="emit('edit', server)"><PhPencilSimple :size="17" /></button><button class="icon-button" :aria-label="`复制${server.name}`" title="复制" @click="duplicate(server)"><PhCopy :size="17" /></button><button class="icon-button" :aria-label="`删除${server.name}`" title="删除" @click="removeServers([server.id])"><PhTrash :size="17" /></button></div></td></tr></tbody></table></div>
      <div v-else class="empty-state"><PhMagnifyingGlass :size="32" /><h3>{{ servers.length ? '没有匹配的服务器' : '还没有服务器' }}</h3><p>添加服务器，或调整搜索与筛选条件。</p><button class="button" @click="groupFilter = 'all'; protocol = 'all'; emit('clearSearch')">重置筛选</button></div>
    </template>

    <div v-else class="management-groups"><section class="group-list-panel" aria-label="分组列表"><div class="group-panel-heading"><h2>分组目录</h2><span>{{ visibleGroups.length }}</span></div><button v-for="group in visibleGroups" :key="group.id" :class="['management-group-row', { active: groupDraft.id === group.id }]" :style="{ paddingLeft: `${16 + group.depth * 16}px` }" @click="editGroup(group)"><PhFolderSimple :size="19" /><span>{{ group.name }}</span><small>{{ servers.filter(server => server.groupId === group.id).length }}</small></button><p v-if="!visibleGroups.length" class="panel-intro group-empty">{{ query ? '没有匹配的分组。' : '暂无分组，右侧创建一个。' }}</p><div class="ungrouped-summary">未分组 <span>{{ servers.filter(server => !server.groupId).length }}</span></div></section>
      <form class="group-detail-panel" @submit.prevent="saveGroup"><div class="group-panel-heading"><h2>{{ groupDraft.id ? '编辑分组' : '新建分组' }}</h2><PhFolderSimple :size="20" /></div><label class="form-field"><span>分组名称</span><input v-model="groupDraft.name" required maxlength="40" placeholder="例如：开发环境" /></label><label class="form-field"><span>上级分组</span><select v-model="groupDraft.parentId"><option value="">顶层分组</option><option v-for="group in parents" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label><p class="field-hint">移动分组时，下属服务器和子分组一起保留。</p><p v-if="groupError" class="field-error" role="alert">{{ groupError }}</p><div class="form-actions"><button v-if="groupDraft.id" type="button" class="icon-button" aria-label="删除当前分组" title="删除分组" @click="removeGroup(groups.find(group => group.id === groupDraft.id)!)"><PhTrash :size="18" /></button><span class="action-spacer"></span><button type="button" class="button" @click="editGroup()">重置</button><button type="submit" class="button primary"><PhCheck :size="17" />保存分组</button></div></form>
    </div>

    <dialog ref="confirmDialog" class="management-dialog confirm-dialog" aria-labelledby="confirm-title" @click="event => { if (event.target === confirmDialog) confirmDialog?.close() }"><header><h2 id="confirm-title">{{ confirmTitle }}</h2><button class="icon-button" aria-label="取消删除" @click="confirmDialog?.close()"><PhX :size="20" /></button></header><p>{{ confirmText }}</p><div class="form-actions"><button class="button" @click="confirmDialog?.close()">取消</button><button class="button primary" @click="applyConfirmed">确认删除</button></div></dialog>
    <dialog ref="importDialog" class="management-dialog import-dialog" aria-labelledby="import-title" @cancel="importGeneration++"><header><h2 id="import-title">导入配置</h2><button class="icon-button" aria-label="关闭导入" @click="closeImport"><PhX :size="20" /></button></header><p class="panel-intro">先校验并预览，再替换目录。不会连接服务器；不接受密码或私钥字段。</p><input ref="importFile" type="file" accept=".json,application/json" class="visually-hidden" aria-label="选择 JSON 配置文件" @change="readImport" /><button class="button" :disabled="importBusy" @click="importFile?.click()"><PhUploadSimple :size="17" />选择 JSON 文件</button><label class="form-field import-content"><span>或粘贴配置 JSON</span><textarea v-model="importText" :disabled="importBusy" rows="7" spellcheck="false" placeholder='{"schemaVersion":1,"groups":[],"servers":[]}'></textarea></label><p v-if="importError" class="field-error" role="alert">{{ importError }}</p><section v-if="importDraft" class="import-summary"><strong>替换预览</strong><p v-for="warning in importWarnings" :key="warning">{{ warning }}</p><p>服务器 {{ servers.length }} → {{ importDraft.servers.length }} · 分组 {{ groups.length }} → {{ importDraft.groups.length }}</p><p>当前目录将整体替换；私钥保留在本机原路径。</p><ul><li v-for="server in importDraft.servers.slice(0, 8)" :key="server.id">{{ server.name }} <code>{{ server.host }}</code></li></ul><small v-if="importDraft.servers.length > 8">另外 {{ importDraft.servers.length - 8 }} 台服务器</small></section><div class="form-actions"><button class="button" @click="closeImport">取消</button><button v-if="!importDraft" class="button primary" :disabled="importBusy" @click="previewImport">校验并预览</button><button v-else class="button primary" :disabled="importBusy" @click="applyImport">确认替换目录</button></div></dialog>
  </section>
</template>
