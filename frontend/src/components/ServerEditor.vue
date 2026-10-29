<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { builtInTerminalThemes } from '@webnav/shared'
import { terminalThemes } from '../backend'
import { reactive, ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { PhPlus, PhTrash, PhCheck, PhTerminalWindow, PhDesktop, PhGlobeHemisphereWest } from '@phosphor-icons/vue'
import { orderedGroups, protocolNames, getRdpClient, getRdpCertificatePolicy } from '../catalog'
import type { Connection, Group, Protocol, Server } from '../catalog'
import { validateServer } from '../catalog-management'
import { rpc, type RdpPasswordUpdate } from '../backend'
import BuiltinConnectionFields from './BuiltinConnectionFields.vue'
import RdpDisplayFields from './RdpDisplayFields.vue'
import { connectorProvider, connectorOptions, pluginViews } from '../plugins'
import { connectorViews, connectionTypes } from '../connectors'

const props = defineProps<{ server?: Server; groups: Group[]; initialGroupId?: string; saveError?: string; busy?: boolean }>()
const emit = defineEmits<{ save: [server: Server]; cancel: []; remove: [id: string]; credentials: [serverId: string, connectionId: string]; history: [serverId: string] }>()
const draft = reactive<Server>(props.server ? JSON.parse(JSON.stringify(props.server)) as Server : { id: crypto.randomUUID(), name: '', host: '', groupId: props.initialGroupId ?? '', tags: [], note: '', favorite: false, connections: [] })
const tags = ref(draft.tags.join(', '))
const error = ref('')
const removeArmed = ref(false)
const groupOptions = computed(() => orderedGroups(props.groups))
const editorForm = ref<HTMLFormElement>()
const errorMessage = ref<HTMLParagraphElement>()
const rdpSecrets = reactive<Record<string, string>>({})
const clearRdpSecrets = reactive<Record<string, boolean>>({})
const savedRdpSecrets = reactive<Record<string, boolean>>({})
const rdpPasswords = computed<RdpPasswordUpdate[]>(() => draft.connections.filter(connection => ['rdp', 'vnc', 'wdb'].includes(connection.type) && (rdpSecrets[connection.id] || clearRdpSecrets[connection.id])).map(connection => ({
  serverId: draft.id, connectionId: connection.id,
  secret: clearRdpSecrets[connection.id] ? null : rdpSecrets[connection.id]!,
})))
let disposed = false
onMounted(async () => {
  try {
    await Promise.all((props.server?.connections ?? []).filter(connection => ['rdp', 'vnc', 'wdb'].includes(connection.type)).map(async connection => {
      const description = await rpc<{ hasSecret: boolean }>('credentials.describe', { serverId: draft.id, connectionId: connection.id })
      if (!disposed) savedRdpSecrets[connection.id] = description.hasSecret
    }))
  } catch { /* Saving still validates vault state on the server; never assume an existing secret is empty. */ }
})
onBeforeUnmount(() => { disposed = true; for (const id of Object.keys(rdpSecrets)) rdpSecrets[id] = '' })
watch(() => props.saveError, message => { if (message) errorMessage.value?.focus() }, { flush: 'post' })
function addConnection(type: Protocol) {
  if (draft.connections.length >= 12) return
  const connection: Connection = { id: crypto.randomUUID(), type, name: protocolNames[type] ?? type, port: connectorViews[type]!.port }
  if (type === 'rdp') { connection.rdpClient = 'browser'; connection.rdpOptions = { certificate: 'tofu', security: 'any' } }
  if (type === 'web') connection.url = draft.host ? `https://${draft.host.includes(':') && !draft.host.startsWith('[') ? `[${draft.host}]` : draft.host}/` : 'https://'
  else connection.username = ''
  if (type === 'ssh') connection.saveHistory = true
  if (type === 'local') { connection.saveHistory = false; if(!draft.host)draft.host='127.0.0.1' }
  if (type === 'adb' && !draft.host)draft.host='127.0.0.1'
  if(type.startsWith('plugin:')){const options=connectorOptions(type);if(options[0])connection.providerId=options[0].pluginId}
  draft.connections.push(connection)
}
if (!props.server) addConnection('ssh')
const initialDraft = JSON.stringify({ server: draft, tags: tags.value })
const dirty = computed(() => JSON.stringify({ server: draft, tags: tags.value }) !== initialDraft || rdpPasswords.value.length > 0)
function getValidatedServer(): Server | undefined {
  if (props.busy) return
  error.value = ''
  if (!editorForm.value?.reportValidity()) return
  const server: Server = { ...draft, name: draft.name.trim(), host: draft.host.trim(), note: draft.note.trim(), tags: [...new Set(tags.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))], connections: draft.connections.map(connection => ({ ...connection, name: connection.name.trim(), ...(connection.url !== undefined ? { url: connection.url.trim() } : {}) })) }
  for (const connection of server.connections) if (connection.type === 'web') {
    try { const url = new URL(connection.url ?? ''); connection.port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443 } catch { /* Validation below provides the field message. */ }
  }
  try {
    validateServer(server, props.groups)
    for (const update of rdpPasswords.value) {
      const connection = server.connections.find(connection => connection.id === update.connectionId)
      if (update.secret !== null && connection && ['rdp','wdb'].includes(connection.type) && !connection.username?.trim()) throw new Error(i18nT('m408948bd4e66'))
    }
    return server
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : i18nT('m438ca468c317')
    void nextTick(() => errorMessage.value?.focus())
  }
}
function save() { const server = getValidatedServer(); if (server) emit('save', server) }
function getRdpPasswordUpdates() { return rdpPasswords.value }
defineExpose({ dirty, getValidatedServer, getRdpPasswordUpdates })
</script>

<template>
  <form ref="editorForm" class="editor-form" :aria-busy="busy" @submit.prevent="save">
    <div class="form-actions editor-actions" role="group" :aria-label="i18nT('m073613041ad2')"><button v-if="server" type="button" class="button danger-button" :disabled="busy" @click="removeArmed ? emit('remove', server.id) : removeArmed = true"><PhTrash :size="17" />{{ removeArmed ? i18nT('ma3ea3c17b401') : i18nT('m2f9daa828907') }}</button><span class="action-spacer"></span><button type="button" class="button" :disabled="busy" @click="emit('cancel')">{{ i18nT('m2cd0f3be8738') }}</button><button class="button primary" type="submit" :disabled="busy"><PhCheck :size="17" />{{ busy ? i18nT('mff509c9ba052') : i18nT('ma3030bf8f16d') }}</button></div>
    <div class="editor-scroll">
    <fieldset class="editor-fields" :disabled="busy">
    <p class="panel-intro">{{ i18nT('m3bf4951a2f48') }}</p>
    <label class="form-field"><span>{{ i18nT('mec79bfcf63ea') }}</span><input v-model="draft.name" required maxlength="60" :placeholder="i18nT('md7632d2fe6d5')" /></label>
    <label class="form-field"><span>{{ i18nT('md3716cc5a2f5') }}</span><input v-model="draft.host" required maxlength="253" :placeholder="i18nT('m13377c804c3a')" autocapitalize="off" spellcheck="false" /></label>
    <label class="form-field"><span>{{ i18nT('m6c49c1f947d1') }}</span><select v-model="draft.groupId"><option value="">{{ i18nT('me86ea3f280d9') }}</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label>
    <label class="form-field"><span>{{ i18nT('m1d0fd5f9336d') }}<small>{{ i18nT('m07a7f1dd375a') }}</small></span><input v-model="tags" maxlength="370" :placeholder="i18nT('m18fd169e28f4')" /></label>
    <div class="editor-section-title"><h3>{{ i18nT('m3a8ffd4246b8') }}<small>{{ draft.connections.length }}/12</small></h3><div class="connection-add"><button v-for="type in connectionTypes" :key="type" type="button" class="icon-button small" :disabled="draft.connections.length >= 12" :title="i18nT('mcd32b16f6601', { p0: (protocolNames[type]) })" :aria-label="i18nT('mcd32b16f6601', { p0: (protocolNames[type]) })" @click="addConnection(type)"><component :is="connectorViews[type]!.icon" :size="18" /><PhPlus :size="10" /></button></div></div>
    <fieldset v-for="(connection, index) in draft.connections" :key="connection.id" class="connection-form"><legend>{{ protocolNames[connection.type] }} · {{ index + 1 }}</legend>
      <button class="icon-button small remove-connection" type="button" :aria-label="i18nT('m627f0d1e35dd', { p0: (index + 1) })" :title="i18nT('m6c9a79da5891')" @click="draft.connections.splice(index, 1)"><PhTrash :size="16" /></button>
      <div :class="{ 'form-two-columns': !['web','local'].includes(connection.type) }"><label class="form-field"><span>{{ i18nT('mf71eeb00eccf') }}</span><input v-model="connection.name" required maxlength="30" :aria-label="i18nT('m94bb461d0598', { p0: (index + 1) })" /></label><label v-if="!['web','local'].includes(connection.type)" class="form-field"><span>{{ i18nT('me71ac32b544b') }}</span><input v-model.number="connection.port" :aria-label="i18nT('m994be82abbce', { p0: (index + 1) })" type="number" min="1" max="65535" required /></label></div>
      <label class="form-field"><span>{{ i18nT('m10be49c28e22') }}</span><select :value="connection.providerId ?? ''" @change="connection.providerId=($event.target as HTMLSelectElement).value || undefined"><option value="">{{ i18nT('ma44f9f9fcaca') }}</option><option v-if="!connection.type.startsWith('plugin:')" value="builtin">{{ i18nT('ma90c9592da0f') }}</option><option v-for="provider in connectorOptions(connection.type)" :key="provider.pluginId" :value="provider.pluginId">{{ provider.name }} · {{ provider.pluginId }}</option><option v-if="connection.providerId && connection.providerId!=='builtin' && !connectorOptions(connection.type).some(p=>p.pluginId===connection.providerId)" :value="connection.providerId">{{ i18nT('m25f97b9eae9d', { p0: (connection.providerId) }) }}</option></select></label>
      <component v-if="connectorProvider(connection)?.form || pluginViews['connection-form']" :is="connectorProvider(connection)?.form ?? pluginViews['connection-form']" :connection="connection" :server-id="draft.id" @update:connection="draft.connections[index]=$event" />
      <BuiltinConnectionFields v-if="['local','adb','wdb'].includes(connection.type)" :connection="connection" @update:connection="draft.connections[index]=$event" />
      <label v-if="connection.type === 'web'" class="form-field"><span>{{ i18nT('meb6f944d5229') }}</span><input v-model="connection.url" :aria-label="i18nT('m693cfd8915e0', { p0: (index + 1) })" required maxlength="2048" placeholder="https://example.com/admin" /></label>
      <label v-else-if="!['vnc','local','adb'].includes(connection.type)" class="form-field"><span>{{ i18nT('m1a3f0617d6de') }}</span><input v-model="connection.username" :aria-label="i18nT('ma48f5236d063', { p0: (index + 1) })" maxlength="100" autocomplete="off" :placeholder="connection.type === 'rdp' ? i18nT('m763e9e4c51ad') : i18nT('me80b9d580196')" /></label>
      <template v-if="['rdp','vnc','wdb'].includes(connection.type)">
        <label class="form-field"><span>{{ i18nT('mfb5bbea8d049') }}<small v-if="savedRdpSecrets[connection.id]">{{ i18nT('m1bd91a7d0c53') }}</small></span><input v-model="rdpSecrets[connection.id]" :aria-label="i18nT('m55e83ff363e2', { p0: (index + 1) })" type="password" maxlength="1280" autocomplete="new-password" :disabled="clearRdpSecrets[connection.id]" :placeholder="savedRdpSecrets[connection.id] ? i18nT('m4ae398ebce8f') : i18nT('mbc2a7c72597e')" /></label>
        <label v-if="savedRdpSecrets[connection.id]" class="check-label"><input v-model="clearRdpSecrets[connection.id]" type="checkbox" />{{ i18nT('maebef09ed0c6') }}</label>
      </template>
      <template v-if="connection.type === 'rdp'">
        <label class="form-field"><span>{{ i18nT('mff1804eeb7de') }}</span><select :value="getRdpClient(connection)" :aria-label="i18nT('m9c399efd14e1', { p0: (index + 1) })" @change="connection.rdpClient = ($event.target as HTMLSelectElement).value as 'native' | 'browser'; connection.rdpOptions ??= {}"><option value="browser">{{ i18nT('m4989385305ef') }}</option><option value="native">{{ i18nT('m610621fb127a') }}</option></select></label>
        <template v-if="getRdpClient(connection) === 'browser'">
          <label class="form-field"><span>{{ i18nT('m8ebf07f544fa') }}<small>{{ i18nT('m537352400c49') }}</small></span><input :value="connection.rdpOptions?.domain ?? ''" :aria-label="i18nT('m01f0a54dcfbd', { p0: (index + 1) })" maxlength="100" @input="connection.rdpOptions = { ...connection.rdpOptions, domain: ($event.target as HTMLInputElement).value }" /></label>
          <label class="form-field"><span>{{ i18nT('mf3f2343ceca4') }}</span><select :value="connection.rdpOptions?.security ?? 'any'" :aria-label="i18nT('maf4200761487', { p0: (index + 1) })" @change="connection.rdpOptions = { ...connection.rdpOptions, security: ($event.target as HTMLSelectElement).value as 'any' | 'nla' | 'tls' | 'rdp' }"><option value="any">{{ i18nT('mb68e8550d27e') }}</option><option value="nla">NLA</option><option value="tls">TLS</option><option value="rdp">{{ i18nT('m3209a33477a9') }}</option></select></label>
          <label class="form-field"><span>{{ i18nT('m8490aab8deab') }}</span><select :value="getRdpCertificatePolicy(connection)" :aria-label="i18nT('m62621edb8c6d', { p0: (index + 1) })" @change="connection.rdpOptions = { ...connection.rdpOptions, certificate: ($event.target as HTMLSelectElement).value as 'verify' | 'tofu' }"><option value="tofu">{{ i18nT('m591df8efecbd') }}</option><option value="verify">{{ i18nT('m27f27e6762ea') }}</option></select></label>
        </template>
        <RdpDisplayFields v-model="connection.rdpDisplay" :entry-number="index + 1" :browser="getRdpClient(connection) === 'browser'" />
      </template>
      <p v-if="connection.type === 'vnc'" class="rdp-display-hint">{{ i18nT('m7df93d0bc935') }}</p>
      <label v-if="['ssh','local'].includes(connection.type)" class="form-field"><span>{{ i18nT('m3e7571c83eac') }}</span><select :value="connection.terminalThemeId ?? ''" :aria-label="i18nT('m8d30f4bf50f1', { p0: (index + 1) })" @change="connection.terminalThemeId = ($event.target as HTMLSelectElement).value || undefined"><option value="">{{ i18nT('mfa5bb73e2e88') }}</option><option v-for="theme in [...builtInTerminalThemes, ...terminalThemes.themes]" :key="theme.id" :value="theme.id">{{ theme.name }}</option><option v-if="connection.terminalThemeId && ![...builtInTerminalThemes, ...terminalThemes.themes].some(theme => theme.id === connection.terminalThemeId)" :value="connection.terminalThemeId">{{ i18nT('m37666e48e077') }}</option></select></label>
      <label v-if="['ssh','local'].includes(connection.type)" class="check-label"><input v-model="connection.saveHistory" type="checkbox" />{{ i18nT('m0992a5267584') }}</label>
    <div v-if="connection.type === 'ssh'" class="credential-shortcuts"><button type="button" class="button" :disabled="!server?.connections.some(item => item.id === connection.id)" @click="emit('credentials', draft.id, connection.id)">{{ i18nT('m537b09e69e86') }}</button><button v-if="server" type="button" class="button" @click="emit('history', draft.id)">{{ i18nT('ma5783b941d7d') }}</button><small v-if="!server?.connections.some(item => item.id === connection.id)">{{ i18nT('mff060a914c5b') }}</small></div>
    </fieldset>
    <p v-if="!draft.connections.length" class="field-error">{{ i18nT('m67ad0a3ca4e3') }}</p>
    <label class="form-field"><span>{{ i18nT('mdaede9881787') }}</span><textarea v-model="draft.note" maxlength="500" rows="2" :placeholder="i18nT('md6ece56c02db')"></textarea></label>
    <label class="check-label"><input v-model="draft.favorite" type="checkbox" />{{ i18nT('m2e8a4ae9c22d') }}</label>
    <p v-if="error || saveError" ref="errorMessage" class="field-error" role="alert" tabindex="-1">{{ error || saveError }}</p>
    </fieldset>
    </div>
  </form>
</template>
