<script setup lang="ts">
import { reactive, ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { PhPlus, PhTrash, PhCheck, PhTerminalWindow, PhDesktop, PhGlobeHemisphereWest } from '@phosphor-icons/vue'
import { orderedGroups, protocolNames } from '../catalog'
import type { Connection, Group, Protocol, Server } from '../catalog'
import { validateServer } from '../catalog-management'
import { rpc, type RdpPasswordUpdate } from '../backend'

const props = defineProps<{ server?: Server; groups: Group[]; saveError?: string; busy?: boolean }>()
const emit = defineEmits<{ save: [server: Server]; cancel: []; remove: [id: string]; credentials: [serverId: string, connectionId: string]; history: [serverId: string] }>()
const draft = reactive<Server>(props.server ? JSON.parse(JSON.stringify(props.server)) as Server : { id: crypto.randomUUID(), name: '', host: '', groupId: '', tags: [], note: '', favorite: false, connections: [] })
const tags = ref(draft.tags.join(', '))
const error = ref('')
const removeArmed = ref(false)
const groupOptions = computed(() => orderedGroups(props.groups))
const editorForm = ref<HTMLFormElement>()
const errorMessage = ref<HTMLParagraphElement>()
const rdpSecrets = reactive<Record<string, string>>({})
const clearRdpSecrets = reactive<Record<string, boolean>>({})
const savedRdpSecrets = reactive<Record<string, boolean>>({})
const rdpPasswords = computed<RdpPasswordUpdate[]>(() => draft.connections.filter(connection => connection.type === 'rdp' && (rdpSecrets[connection.id] || clearRdpSecrets[connection.id])).map(connection => ({
  serverId: draft.id, connectionId: connection.id,
  secret: clearRdpSecrets[connection.id] ? null : rdpSecrets[connection.id]!,
})))
let disposed = false
onMounted(async () => {
  try {
    await Promise.all((props.server?.connections ?? []).filter(connection => connection.type === 'rdp').map(async connection => {
      const description = await rpc<{ hasSecret: boolean }>('credentials.describe', { serverId: draft.id, connectionId: connection.id })
      if (!disposed) savedRdpSecrets[connection.id] = description.hasSecret
    }))
  } catch { /* Saving still validates vault state on the server; never assume an existing secret is empty. */ }
})
onBeforeUnmount(() => { disposed = true; for (const id of Object.keys(rdpSecrets)) rdpSecrets[id] = '' })
watch(() => props.saveError, message => { if (message) errorMessage.value?.focus() }, { flush: 'post' })
function addConnection(type: Protocol) {
  if (draft.connections.length >= 12) return
  const connection: Connection = { id: crypto.randomUUID(), type, name: protocolNames[type], port: type === 'ssh' ? 22 : type === 'rdp' ? 3389 : 443 }
  if (type === 'web') connection.url = draft.host ? `https://${draft.host.includes(':') && !draft.host.startsWith('[') ? `[${draft.host}]` : draft.host}/` : 'https://'
  else connection.username = ''
  if (type === 'ssh') connection.saveHistory = true
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
      if (update.secret !== null && !server.connections.find(connection => connection.id === update.connectionId)?.username?.trim()) throw new Error('保存 RDP 密码时请填写用户名。')
    }
    return server
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请检查配置。'
    void nextTick(() => errorMessage.value?.focus())
  }
}
function save() { const server = getValidatedServer(); if (server) emit('save', server) }
function getRdpPasswordUpdates() { return rdpPasswords.value }
defineExpose({ dirty, getValidatedServer, getRdpPasswordUpdates })
</script>

<template>
  <form ref="editorForm" class="editor-form" :aria-busy="busy" @submit.prevent="save">
    <fieldset class="editor-fields" :disabled="busy">
    <p class="panel-intro">保存到本机数据库。认证资料单独保存，不进入配置导出。</p>
    <label class="form-field"><span>服务器名称</span><input v-model="draft.name" required maxlength="60" placeholder="例如：开发工作站" /></label>
    <label class="form-field"><span>服务器地址</span><input v-model="draft.host" required maxlength="253" placeholder="IP 地址或主机名" autocapitalize="off" spellcheck="false" /></label>
    <label class="form-field"><span>所属分组</span><select v-model="draft.groupId"><option value="">未分组</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ '　'.repeat(group.depth) }}{{ group.name }}</option></select></label>
    <label class="form-field"><span>标签 <small>逗号分隔</small></span><input v-model="tags" maxlength="370" placeholder="开发, Linux" /></label>
    <div class="editor-section-title"><h3>连接入口 <small>{{ draft.connections.length }}/12</small></h3><div class="connection-add"><button v-for="type in ['ssh','rdp','web'] as const" :key="type" type="button" class="icon-button small" :disabled="draft.connections.length >= 12" :title="`添加${protocolNames[type]}入口`" :aria-label="`添加${protocolNames[type]}入口`" @click="addConnection(type)"><PhTerminalWindow v-if="type === 'ssh'" :size="18" /><PhDesktop v-else-if="type === 'rdp'" :size="18" /><PhGlobeHemisphereWest v-else :size="18" /><PhPlus :size="10" /></button></div></div>
    <fieldset v-for="(connection, index) in draft.connections" :key="connection.id" class="connection-form"><legend>{{ protocolNames[connection.type] }} · {{ index + 1 }}</legend>
      <button class="icon-button small remove-connection" type="button" :aria-label="`移除连接入口 ${index + 1}`" title="移除此入口" @click="draft.connections.splice(index, 1)"><PhTrash :size="16" /></button>
      <div :class="{ 'form-two-columns': connection.type !== 'web' }"><label class="form-field"><span>入口名称</span><input v-model="connection.name" required maxlength="30" :aria-label="`入口 ${index + 1} 名称`" /></label><label v-if="connection.type !== 'web'" class="form-field"><span>端口</span><input v-model.number="connection.port" :aria-label="`入口 ${index + 1} 端口`" type="number" min="1" max="65535" required /></label></div>
      <label v-if="connection.type === 'web'" class="form-field"><span>网页地址</span><input v-model="connection.url" :aria-label="`入口 ${index + 1} 网页地址`" required maxlength="2048" placeholder="https://example.com/admin" /></label>
      <label v-else class="form-field"><span>用户名</span><input v-model="connection.username" :aria-label="`入口 ${index + 1} 用户名`" maxlength="100" autocomplete="off" placeholder="连接时填写" /></label>
      <template v-if="connection.type === 'rdp'">
        <label class="form-field"><span>登录密码 <small v-if="savedRdpSecrets[connection.id]">已保存</small></span><input v-model="rdpSecrets[connection.id]" :aria-label="`入口 ${index + 1} 登录密码`" type="password" maxlength="1280" autocomplete="new-password" :disabled="clearRdpSecrets[connection.id]" :placeholder="savedRdpSecrets[connection.id] ? '已保存，留空保持不变' : '输入后随服务器保存；留空不修改密码'" /></label>
        <label v-if="savedRdpSecrets[connection.id]" class="check-label"><input v-model="clearRdpSecrets[connection.id]" type="checkbox" />清除 WebNav 中保存的密码</label>
      </template>
      <label v-if="connection.type === 'ssh'" class="check-label"><input v-model="connection.saveHistory" type="checkbox" />保存输出历史 </label>
    <div v-if="connection.type === 'ssh'" class="credential-shortcuts"><button type="button" class="button" :disabled="!server?.connections.some(item => item.id === connection.id)" @click="emit('credentials', draft.id, connection.id)">认证设置</button><button v-if="server" type="button" class="button" @click="emit('history', draft.id)">查看历史</button><small v-if="!server?.connections.some(item => item.id === connection.id)">先保存入口，再设置认证。</small></div>
    </fieldset>
    <p v-if="!draft.connections.length" class="field-error">至少添加一个连接入口。</p>
    <label class="form-field"><span>备注</span><textarea v-model="draft.note" maxlength="500" rows="2" placeholder="记录用途或维护说明"></textarea></label>
    <label class="check-label"><input v-model="draft.favorite" type="checkbox" />加入收藏夹</label>
    <p v-if="error || saveError" ref="errorMessage" class="field-error" role="alert" tabindex="-1">{{ error || saveError }}</p>
    <div class="form-actions"><button v-if="server" type="button" class="button danger-button" @click="removeArmed ? emit('remove', server.id) : removeArmed = true"><PhTrash :size="17" />{{ removeArmed ? '确认删除' : '删除' }}</button><span class="action-spacer"></span><button type="button" class="button" @click="emit('cancel')">取消</button><button class="button primary" type="submit"><PhCheck :size="17" />{{ busy ? '保存中…' : '保存' }}</button></div>
    </fieldset>
  </form>
</template>
