<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, nextTick, reactive, ref, watch } from 'vue'
import { PhHardDrives, PhFolderSimple, PhPlus, PhPencilSimple, PhTrash, PhCopy, PhDownloadSimple, PhUploadSimple, PhX, PhCheck, PhMagnifyingGlass, PhArrowRight, PhStar } from '@phosphor-icons/vue'
import { groupDescendants, orderedGroups, protocolNames } from '../catalog'
import type { Group, Protocol, Server } from '../catalog'
import { MAX_CATALOG_BYTES, parseCatalogImport, serializeCatalog, validateGroups } from '../catalog-management'
import type { CatalogDocument } from '../catalog-management'
import { rpc, synchronize } from '../backend'

const props = defineProps<{ servers: Server[]; groups: Group[]; query: string; initialTab: 'servers' | 'groups'; commit: (groups: Group[], servers: Server[]) => Promise<void> }>()
const emit = defineEmits<{ edit: [server?: Server, initialGroupId?: string]; replace: [groups: Group[], servers: Server[]]; notify: [message: string]; clearSearch: [] }>()
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
const groupLabel = (id: string) => props.groups.find(group => group.id === id)?.name ?? i18nT('me86ea3f280d9')
const filtered = computed(() => {
  const descendants = groupDescendants(groupFilter.value, props.groups)
  const text = props.query.trim().toLocaleLowerCase()
  return props.servers.filter(server => (groupFilter.value === 'all' || descendants.has(server.groupId)) && (protocol.value === 'all' || server.connections.some(connection => connection.type === protocol.value)) && [server.name, server.host, server.note, groupLabel(server.groupId), ...server.tags, ...server.connections.map(connection => connection.name)].join(' ').toLocaleLowerCase().includes(text))
})
watch([filtered, tab], () => { checked.value = [] })
const allChecked = computed(() => filtered.value.length > 0 && checked.value.length === filtered.value.length)
function toggleAll() { checked.value = allChecked.value ? [] : filtered.value.map(server => server.id) }
async function replace(groups: Group[], servers: Server[], message: string): Promise<boolean> {
  try { serializeCatalog(groups, servers) } catch (cause) { emit('notify', cause instanceof Error ? cause.message : i18nT('mf64681b7cad5')); return false }
  try { await props.commit(groups, servers); emit('notify', message); return true } catch (cause) { emit('notify', cause instanceof Error ? cause.message : i18nT('mcf1487e7aa89')); return false }
}
function moveServers() {
  if (moveTarget.value && !props.groups.some(group => group.id === moveTarget.value)) { emit('notify', i18nT('mbd6b7220ef6a')); moveTarget.value = ''; return }
  replace(props.groups, props.servers.map(server => checked.value.includes(server.id) ? { ...server, groupId: moveTarget.value } : server), i18nT('m198077700f78', { p0: (checked.value.length) }))
}
async function duplicate(server: Server) {
  const copy: Server = { ...server, id: crypto.randomUUID(), name: i18nT('mef5e52459e97', { p0: (server.name.slice(0, 55)) }), favorite: false, tags: [...server.tags], connections: server.connections.map(connection => ({ ...connection, id: crypto.randomUUID() })) }
  if (await replace(props.groups, [...props.servers, copy], i18nT('m672a7f3c6b99'))) emit('edit', copy)
}

const groupDraft = reactive({ id: '', name: '', parentId: '' })
const groupError = ref('')
const visibleGroups = computed(() => groupOptions.value.filter(group => group.name.toLocaleLowerCase().includes(props.query.trim().toLocaleLowerCase())))
const parents = computed(() => groupOptions.value.filter(group => !groupDescendants(groupDraft.id, props.groups).has(group.id)))
function editGroup(group?: Group) { Object.assign(groupDraft, { id: group?.id ?? '', name: group?.name ?? '', parentId: group?.parentId ?? '' }); groupError.value = '' }
async function saveGroup() {
  const group: Group = { id: groupDraft.id || crypto.randomUUID(), name: groupDraft.name.trim(), ...(groupDraft.parentId ? { parentId: groupDraft.parentId } : {}) }
  const groups = groupDraft.id ? props.groups.map(item => item.id === group.id ? group : item) : [...props.groups, group]
  try { validateGroups(groups); if (await replace(groups, props.servers, i18nT('m519e9fd941cd'))) editGroup(group) } catch (cause) { groupError.value = cause instanceof Error ? cause.message : i18nT('mfd24fbbb7193') }
}

const confirmDialog = ref<HTMLDialogElement>()
const confirmTitle = ref('')
const confirmText = ref('')
let confirmAction: (() => unknown) | undefined
async function confirm(title: string, text: string, action: () => unknown) { confirmTitle.value = title; confirmText.value = text; confirmAction = action; await nextTick(); confirmDialog.value?.showModal() }
async function applyConfirmed() { await confirmAction?.(); confirmAction = undefined; confirmDialog.value?.close() }
function removeServers(ids: string[]) {
  void confirm(i18nT('meda79eca04eb', { p0: (ids.length) }), i18nT('m37e3334f9978'), () => replace(props.groups, props.servers.filter(server => !ids.includes(server.id)), i18nT('mc7040e47ffe5', { p0: (ids.length) })))
}
function removeGroup(group: Group) {
  const count = props.servers.filter(server => server.groupId === group.id).length
  void confirm(i18nT('m16f62060635a', { p0: (group.name) }), i18nT('mf7f1483c2b07', { p0: (count) }), async () => {
    const groups = props.groups.filter(item => item.id !== group.id).map(item => item.parentId === group.id ? { id: item.id, name: item.name, ...(group.parentId ? { parentId: group.parentId } : {}) } : item)
    try { validateGroups(groups); await replace(groups, props.servers.map(server => server.groupId === group.id ? { ...server, groupId: '' } : server), i18nT('m2c6b4c3cb69e')); editGroup() } catch (cause) { emit('notify', i18nT('m095f959ee14f', { p0: (cause instanceof Error ? cause.message : i18nT('m8200c383b466')) })) }
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
  if (file.size > MAX_CATALOG_BYTES) { importError.value = i18nT('m66b1e76960ff'); return }
  importBusy.value = true
  try { const content = await file.text(); if (generation === importGeneration) { importText.value = content; await previewImport() } } catch { if (generation === importGeneration) importError.value = i18nT('mcbf2506e92fa') } finally { if (generation === importGeneration) importBusy.value = false }
}
async function previewImport() {
  const generation=++importGeneration
  importDraft.value=undefined;importToken.value='';importBusy.value=true
  try {
    if(new TextEncoder().encode(importText.value).byteLength>MAX_CATALOG_BYTES)throw new Error(i18nT('m563ecba8088a'))
    const result=await rpc<{token:string;catalog:CatalogDocument}>('imports.preview',{catalog:JSON.parse(importText.value)})
    if(generation!==importGeneration)return
    importToken.value=result.token;importDraft.value=parseCatalogImport(result.catalog);importError.value=''
  } catch(cause) { if(generation===importGeneration)importError.value=cause instanceof SyntaxError?i18nT('me008c09d7931'):cause instanceof Error?cause.message:i18nT('mf382c2eb8134') }
  finally {if(generation===importGeneration)importBusy.value=false}
}
async function importLocalSsh() {
  await openImport();const generation=++importGeneration;importBusy.value=true
  try {const result=await rpc<{token:string;catalog:CatalogDocument;warnings:string[]}>('ssh.importPreview');if(generation!==importGeneration)return;importDraft.value=parseCatalogImport(result.catalog);importToken.value=result.token;importWarnings.value=result.warnings}
  catch(cause){if(generation===importGeneration)importError.value=cause instanceof Error?cause.message:i18nT('m2b7f56d39008')}
  finally {if(generation===importGeneration)importBusy.value=false}
}
async function applyImport() {
  if (!importDraft.value || importBusy.value) return
  importBusy.value = true
  try { await rpc('imports.apply', { token: importToken.value }, true); await synchronize(); groupFilter.value = 'all'; protocol.value = 'all'; editGroup(); emit('clearSearch'); closeImport(); emit('notify', i18nT('me4a513b9228d')) } catch (cause) { importError.value = cause instanceof Error ? cause.message : i18nT('md5d4ca586936') } finally { importBusy.value = false }
}
async function exportConfig() {
  try { const result = await rpc<{ text: string }>('exports.config'); const url = URL.createObjectURL(new Blob([result.text], { type: 'application/json' })); const anchor = documentElement(url); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); emit('notify', i18nT('mbb35610bad45')) } catch (cause) { emit('notify', cause instanceof Error ? cause.message : i18nT('mf7862b83251f')) }
}
function documentElement(url: string) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'webnav-config.json'; document.body.appendChild(anchor); return anchor }
</script>

<template>
  <section class="management-page" :aria-label="i18nT('m64b3e602bf0e')">
    <div class="management-topline"><div class="management-tabs" :aria-label="i18nT('md4c70c3fa338')"><button :class="{ active: tab === 'servers' }" :aria-pressed="tab === 'servers'" @click="tab = 'servers'"><PhHardDrives :size="18" />{{ i18nT('m2388cbc6a486') }}<small>{{ servers.length }}</small></button><button :class="{ active: tab === 'groups' }" :aria-pressed="tab === 'groups'" @click="tab = 'groups'"><PhFolderSimple :size="18" />{{ i18nT('m399ee6934772') }}<small>{{ groups.length }}</small></button></div><div class="management-actions"><button class="button" @click="importLocalSsh">{{ i18nT('m634d3f38201e') }}</button><button class="icon-button" :aria-label="i18nT('mb48b6518293a')" :title="i18nT('mb48b6518293a')" @click="openImport"><PhUploadSimple :size="19" /></button><button class="icon-button" :aria-label="i18nT('m429ea3af443d')" :title="i18nT('m429ea3af443d')" @click="exportConfig"><PhDownloadSimple :size="19" /></button><button class="button primary" @click="tab === 'servers' ? emit('edit', undefined, groupFilter) : editGroup()"><PhPlus :size="18" />{{ tab === 'servers' ? i18nT('mebf91996f8fe') : i18nT('m3d49d9fcb6d1') }}</button></div></div>
    <p class="management-notice">{{ i18nT('m4ee07f714017') }}</p>

    <template v-if="tab === 'servers'">
      <div class="management-filter"><label><span class="visually-hidden">{{ i18nT('m1336f4eb5b34') }}</span><select v-model="groupFilter" :aria-label="i18nT('m1336f4eb5b34')"><option value="all">{{ i18nT('m140e85a15cfe') }}</option><option value="">{{ i18nT('me86ea3f280d9') }}</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label><div class="segmented"><button v-for="type in ['all','ssh','rdp','vnc','web'] as const" :key="type" :class="{ active: protocol === type }" :aria-pressed="protocol === type" @click="protocol = type">{{ type === 'all' ? i18nT('m5c55a67935af') : protocolNames[type] }}</button></div><span class="management-result">{{ i18nT('me62e2770fd9a', { p0: (filtered.length), p1: (filtered.reduce((sum, server) => sum + server.connections.length, 0)) }) }}</span></div>
      <div v-if="checked.length" class="bulk-toolbar"><span>{{ i18nT('mdfd3db5fee5c', { p0: (checked.length) }) }}</span><select v-model="moveTarget" :aria-label="i18nT('m9cc81ea4e3be')"><option value="">{{ i18nT('me86ea3f280d9') }}</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select><button class="icon-button" :aria-label="i18nT('m22becf592747')" :title="i18nT('ma57fef7ae3b5')" @click="moveServers"><PhArrowRight :size="18" /></button><button class="icon-button" :aria-label="i18nT('m39014c77605c')" :title="i18nT('m39014c77605c')" @click="removeServers([...checked])"><PhTrash :size="18" /></button><button class="icon-button" :aria-label="i18nT('m74966e20df2e')" :title="i18nT('m74966e20df2e')" @click="checked = []"><PhX :size="18" /></button></div>
      <div v-if="filtered.length" class="management-table-wrap"><table class="management-table"><thead><tr><th class="selection-cell"><input type="checkbox" :checked="allChecked" :indeterminate="checked.length > 0 && !allChecked" :aria-label="i18nT('mbfea6e38787f')" @change="toggleAll" /></th><th>{{ i18nT('m2388cbc6a486') }}</th><th>{{ i18nT('mea7f1aa70057') }}</th><th>{{ i18nT('m3a8ffd4246b8') }}</th><th class="management-operations">{{ i18nT('med31fbb483ee') }}</th></tr></thead><tbody><tr v-for="server in filtered" :key="server.id" :class="{ selected: checked.includes(server.id) }"><td class="selection-cell"><input v-model="checked" type="checkbox" :value="server.id" :aria-label="i18nT('meb0626f2625a', { p0: (server.name) })" /></td><td><button class="management-server-name" :title="i18nT('mba50ba8e6057', { p0: (server.name) })" @click="emit('edit', server)">{{ server.name }}<PhStar v-if="server.favorite" :size="13" weight="fill" /></button><span class="server-address">{{ server.host }}</span></td><td><span class="management-group">{{ groupLabel(server.groupId) }}</span><div class="management-tags"><span v-for="tag in server.tags" :key="tag">{{ tag }}</span></div></td><td><div class="management-connections"><span v-for="connection in server.connections" :key="connection.id" :title="`${connection.name} · ${connection.type === 'web' ? connection.url : connection.port}`">{{ protocolNames[connection.type] }}<small>{{ connection.type === 'web' ? connection.name : connection.port }}</small></span></div></td><td><div class="management-row-actions"><button class="icon-button" :aria-label="i18nT('mba50ba8e6057', { p0: (server.name) })" :title="i18nT('m051836569928')" @click="emit('edit', server)"><PhPencilSimple :size="17" /></button><button class="icon-button" :aria-label="i18nT('m2a76bfd72978', { p0: (server.name) })" :title="i18nT('m63d90d977348')" @click="duplicate(server)"><PhCopy :size="17" /></button><button class="icon-button" :aria-label="i18nT('m1d3174fbd549', { p0: (server.name) })" :title="i18nT('m2f9daa828907')" @click="removeServers([server.id])"><PhTrash :size="17" /></button></div></td></tr></tbody></table></div>
      <div v-else class="empty-state"><PhMagnifyingGlass :size="32" /><h3>{{ servers.length ? i18nT('md4e51eea9b7d') : i18nT('m4e5db443f3d9') }}</h3><p>{{ i18nT('md91cd9f1dde7') }}</p><button class="button" @click="groupFilter = 'all'; protocol = 'all'; emit('clearSearch')">{{ i18nT('m13a431e59b65') }}</button></div>
    </template>

    <div v-else class="management-groups"><section class="group-list-panel" :aria-label="i18nT('m7aa2b2b7e98b')"><div class="group-panel-heading"><h2>{{ i18nT('mfb0e512abaa2') }}</h2><span>{{ visibleGroups.length }}</span></div><button v-for="group in visibleGroups" :key="group.id" :class="['management-group-row', { active: groupDraft.id === group.id }]" :style="{ paddingLeft: `${16 + group.depth * 16}px` }" @click="editGroup(group)"><PhFolderSimple :size="19" /><span>{{ group.name }}</span><small>{{ servers.filter(server => server.groupId === group.id).length }}</small></button><p v-if="!visibleGroups.length" class="panel-intro group-empty">{{ query ? i18nT('ma5f30d42697c') : i18nT('m5ba8eeee8f08') }}</p><div class="ungrouped-summary">{{ i18nT('me86ea3f280d9') }}<span>{{ servers.filter(server => !server.groupId).length }}</span></div></section>
      <form class="group-detail-panel" @submit.prevent="saveGroup"><div class="group-panel-heading"><h2>{{ groupDraft.id ? i18nT('md00b2a96c3b3') : i18nT('m3d49d9fcb6d1') }}</h2><PhFolderSimple :size="20" /></div><label class="form-field"><span>{{ i18nT('md7e266bdc806') }}</span><input v-model="groupDraft.name" required maxlength="40" :placeholder="i18nT('m78bcc86b2cae')" /></label><label class="form-field"><span>{{ i18nT('m24facb0ea488') }}</span><select v-model="groupDraft.parentId"><option value="">{{ i18nT('m7ab956131380') }}</option><option v-for="group in parents" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label><p class="field-hint">{{ i18nT('mc65b7e30bca7') }}</p><p v-if="groupError" class="field-error" role="alert">{{ groupError }}</p><div class="form-actions"><button v-if="groupDraft.id" type="button" class="icon-button" :aria-label="i18nT('mdf7beced4569')" :title="i18nT('m7605c1d82eed')" @click="removeGroup(groups.find(group => group.id === groupDraft.id)!)"><PhTrash :size="18" /></button><span class="action-spacer"></span><button type="button" class="button" @click="editGroup()">{{ i18nT('mcb5d682bac3d') }}</button><button type="submit" class="button primary"><PhCheck :size="17" />{{ i18nT('mb1acb72364b3') }}</button></div></form>
    </div>

    <dialog ref="confirmDialog" class="management-dialog confirm-dialog" aria-labelledby="confirm-title" @click="event => { if (event.target === confirmDialog) confirmDialog?.close() }"><header><h2 id="confirm-title">{{ confirmTitle }}</h2><button class="icon-button" :aria-label="i18nT('ma6926595ce6b')" @click="confirmDialog?.close()"><PhX :size="20" /></button></header><p>{{ confirmText }}</p><div class="form-actions"><button class="button" @click="confirmDialog?.close()">{{ i18nT('m2cd0f3be8738') }}</button><button class="button primary" @click="applyConfirmed">{{ i18nT('ma3ea3c17b401') }}</button></div></dialog>
    <dialog ref="importDialog" class="management-dialog import-dialog" aria-labelledby="import-title" @cancel="importGeneration++"><header><h2 id="import-title">{{ i18nT('mb48b6518293a') }}</h2><button class="icon-button" :aria-label="i18nT('m15f87d14cc41')" @click="closeImport"><PhX :size="20" /></button></header><p class="panel-intro">{{ i18nT('mc70810dba89d') }}</p><input ref="importFile" type="file" accept=".json,application/json" class="visually-hidden" :aria-label="i18nT('m989742789da1')" @change="readImport" /><button class="button" :disabled="importBusy" @click="importFile?.click()"><PhUploadSimple :size="17" />{{ i18nT('m405a583fb019') }}</button><label class="form-field import-content"><span>{{ i18nT('m1be67881c872') }}</span><textarea v-model="importText" :disabled="importBusy" rows="7" spellcheck="false" placeholder='{"schemaVersion":1,"groups":[],"servers":[]}'></textarea></label><p v-if="importError" class="field-error" role="alert">{{ importError }}</p><section v-if="importDraft" class="import-summary"><strong>{{ i18nT('mac1711bb8427') }}</strong><p v-for="warning in importWarnings" :key="warning">{{ warning }}</p><p>{{ i18nT('mf0cac152eb20', { p0: (servers.length), p1: (importDraft.servers.length), p2: (groups.length), p3: (importDraft.groups.length) }) }}</p><p>{{ i18nT('m21ef65ad34d3') }}</p><ul><li v-for="server in importDraft.servers.slice(0, 8)" :key="server.id">{{ server.name }} <code>{{ server.host }}</code></li></ul><small v-if="importDraft.servers.length > 8">{{ i18nT('m4e3a980f58d4', { p0: (importDraft.servers.length - 8) }) }}</small></section><div class="form-actions"><button class="button" @click="closeImport">{{ i18nT('m2cd0f3be8738') }}</button><button v-if="!importDraft" class="button primary" :disabled="importBusy" @click="previewImport">{{ i18nT('mcfec9515a802') }}</button><button v-else class="button primary" :disabled="importBusy" @click="applyImport">{{ i18nT('mbf0918ec980f') }}</button></div></dialog>
  </section>
</template>
