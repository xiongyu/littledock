<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { SyncChoice, SyncHistory, SyncPreview, SyncSettings, SyncStatus } from '@webnav/shared'
import { configSyncStatus as status, connectionState, rpc, vaultStatus } from '../backend'

defineEmits<{ back: [] }>()
defineProps<{ embedded?: boolean }>()
const newId = () => crypto.randomUUID().replaceAll('-', '')
const settings = reactive<SyncSettings>({ provider: 'github', repository: '', branch: 'webnav-sync', spaceId: newId(), username: '', includeSecrets: false, includePlugins: false, autoSync: false })
const token = ref(''), saveToken = ref(false), account = ref(''), password = ref(''), confirmation = ref(''), create = ref(true), minutes = ref(30)
const busy = ref(false), error = ref(''), notice = ref(''), expected = ref('null'), preview = ref<SyncPreview>(), choices = reactive<Record<string, SyncChoice>>({}), mode = ref<'merge' | 'local' | 'remote'>('merge')
const history = ref<SyncHistory>(), restoreVersion = ref(''), oldAccount = ref(''), oldPassword = ref(''), acceptHistory = ref(false), discontinuity = ref(false), rotating = ref(false)
const nextAccount = ref(''), nextPassword = ref(''), nextConfirmation = ref('')
let disposed = false, generation = 0
const enabled = computed(() => connectionState.value === 'ready' && !busy.value && !status.value?.busy)
const canSync = computed(() => enabled.value && status.value?.unlocked && !status.value.pending)
const stable = (value: SyncSettings | null) => value === null ? 'null' : JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN') : '尚未同步'
function clearSecrets() { token.value = ''; password.value = ''; confirmation.value = ''; oldPassword.value = ''; nextPassword.value = ''; nextConfirmation.value = '' }
async function refresh(fill = false) {
  const version = generation, result = await rpc<SyncStatus>('configSync.watch')
  if (disposed || version !== generation || connectionState.value !== 'ready') return
  status.value = result
  if (fill) { expected.value = stable(result.settings); if (result.settings) { Object.assign(settings, result.settings); create.value = false }; saveToken.value = result.tokenSaved }
}
async function action(work: () => Promise<unknown>) {
  if (!enabled.value) return
  busy.value = true; error.value = ''; notice.value = ''; const version = generation
  try { await work(); if (!disposed && version === generation && connectionState.value === 'ready') await refresh() }
  catch (cause) { if (!disposed && version === generation) error.value = cause instanceof Error ? cause.message : '操作未完成。' }
  finally { busy.value = false }
}
function resetPreview() { preview.value = undefined; restoreVersion.value = ''; for (const key of Object.keys(choices)) delete choices[key] }
async function save() {
  const submitted = token.value; token.value = ''
  await action(async () => { await rpc('configSync.configure', { settings: { ...settings }, expected: expected.value, ...(submitted ? { token: submitted } : {}), saveToken: saveToken.value }, true); resetPreview(); await refresh(true); notice.value = '位置已保存。输入同步账号密码后即可预览。' })
}
async function unlock() {
  account.value = account.value.normalize('NFC').trim()
  if (create.value && password.value !== confirmation.value) { error.value = '两次同步密码不一致。'; return }
  const submitted = password.value, submittedToken = token.value; password.value = ''; confirmation.value = ''; token.value = ''
  await action(() => rpc('configSync.unlock', { account: account.value, password: submitted, minutes: minutes.value, create: create.value, ...(submittedToken ? { token: submittedToken } : {}) }, true, 120_000))
  if (status.value?.unlocked) create.value = false
}
async function compare() {
  const old = oldPassword.value; oldPassword.value = ''
  await action(async () => { const result = await rpc<SyncPreview>('configSync.preview', { mode: restoreVersion.value ? 'restore' : mode.value, choices: { ...choices }, acceptDiscontinuity: discontinuity.value, ...(restoreVersion.value ? { version: restoreVersion.value } : {}), ...(old ? { oldAccount: oldAccount.value, oldPassword: old } : {}) }, true, 120_000); if (!disposed && connectionState.value === 'ready') preview.value = result })
}
async function commit() { await action(async () => { await rpc('configSync.apply', { token: preview.value!.token }, true, 180_000); resetPreview(); notice.value = '配置同步完成。' }) }
async function loadHistory(more = false) { await action(async () => { const result = await rpc<SyncHistory>('configSync.history', more && history.value?.cursor ? { cursor: history.value.cursor } : {}, false, 120_000); if (!disposed) history.value = { versions: [...(more ? history.value?.versions ?? [] : []), ...result.versions], cursor: result.cursor } }) }
async function rotate() {
  if (nextPassword.value !== nextConfirmation.value) { error.value = '两次新密码不一致。'; return }
  const secret = nextPassword.value; nextPassword.value = ''; nextConfirmation.value = ''
  await action(async () => { await rpc('configSync.rotatePassword', { account: nextAccount.value, password: secret, acceptHistory: acceptHistory.value }, true, 180_000); account.value = nextAccount.value.normalize('NFC').trim(); rotating.value = false; resetPreview() })
}
watch(connectionState, state => { generation++; clearSecrets(); preview.value = undefined; if (state === 'ready') void refresh(true).catch(() => {}); else { history.value = undefined; error.value = '' } })
watch(() => status.value?.unlocked, unlocked => { if (!unlocked) { clearSecrets(); preview.value = undefined; history.value = undefined } })
onMounted(() => { void refresh(true).catch(cause => { error.value = cause.message }) })
onBeforeUnmount(() => { disposed = true; generation++; clearSecrets(); preview.value = undefined; history.value = undefined })
</script>

<template>
  <div class="sync-panel">
    <button v-if="!embedded" class="button sync-back" @click="$emit('back')">← 全局设置</button>
    <p class="sync-intro">配置先在本机加密，再保存到你的仓库。仓库令牌负责读写，自定义同步账号和密码负责解密。</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice" class="sync-notice" role="status">{{ notice }}</p>
    <section class="sync-status" aria-live="polite"><strong>{{ status?.unlocked ? '同步空间已解锁' : '同步空间未解锁' }}</strong><p>{{ status?.message ?? '正在读取设置…' }}</p><small>上次成功：{{ time(status?.lastSuccess) }}<template v-if="status?.expiresAt"> · 解锁到 {{ time(status.expiresAt) }}</template></small></section>
    <details :open="!status?.settings" class="sync-section"><summary>存储位置与同步内容</summary>
      <div class="sync-fields"><label>存储平台<select v-model="settings.provider"><option value="github">GitHub</option><option value="gitee">Gitee</option></select></label><label>仓库地址<input v-model="settings.repository" type="url" placeholder="https://github.com/你的账号/仓库" autocomplete="off" /></label><label>平台用户名<input v-model="settings.username" autocomplete="off" placeholder="GitHub 可留空；Gitee 填登录名" /></label><label>仓库访问令牌<input v-model="token" type="password" autocomplete="new-password" :placeholder="status?.hasToken ? '已提供；留空保持' : '用于仓库读写，不用于解密'" /></label><label>分支<input v-model="settings.branch" autocomplete="off" /></label><label>同步空间编号<input v-model="settings.spaceId" maxlength="32" autocomplete="off" /><small>新电脑填写同一个编号。创建独立空间时可<button class="sync-text-button" @click="settings.spaceId=newId()">生成新编号</button>。</small></label></div>
      <label class="check-label"><input v-model="saveToken" type="checkbox" :disabled="vaultStatus?.mode!=='master'" />在本机保存令牌（需要本地主密码；移除主密码时清除）</label>
      <p>默认同步分组、服务器、入口、收藏和终端配色。私钥文件、历史记录、截图和本机设备授权不上传。</p>
      <label class="check-label"><input v-model="settings.includeSecrets" type="checkbox" />同步保存的密码与私钥口令</label>
      <label class="check-label"><input v-model="settings.includePlugins" type="checkbox" />同步插件恢复清单（不会自动安装）</label>
      <label class="check-label"><input v-model="settings.autoSync" type="checkbox" :disabled="!status?.hasBaseline" />解锁期间自动同步；删除和冲突需要确认</label>
      <div class="sync-actions"><button class="button primary" :disabled="!enabled" @click="save">保存设置</button><button class="button" :disabled="!enabled || !status?.settings" @click="action(()=>rpc('configSync.check',{},false,120000))">检查连接</button></div>
    </details>
    <section v-if="!status?.unlocked" class="sync-section"><h3>解锁同步空间</h3>
      <div class="sync-fields"><label>使用方式<select v-model="create"><option :value="false">连接已有空间</option><option :value="true">新建同步空间</option></select></label><label>自定义同步账号<input v-model="account" autocomplete="off" maxlength="256" /></label><label>同步密码<input v-model="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" placeholder="至少 12 个字符，建议使用长口令" @keyup.enter="unlock" /></label><label v-if="create">再次输入同步密码<input v-model="confirmation" type="password" autocomplete="new-password" /></label><label>保持解锁<select v-model="minutes"><option :value="30">30 分钟</option><option :value="240">4 小时</option><option :value="0">本次服务运行期间</option></select></label></div>
      <p class="sync-hint">账号区分大小写，首尾空白会去除。密码不会保存，忘记后无法找回。服务重启需要重新输入；仓库令牌未保存时也需重新提供。</p>
      <button class="button primary" :disabled="!enabled || !status?.settings || !account || password.length<12" @click="unlock">解锁并读取</button>
    </section>
    <section v-else class="sync-section"><div class="sync-actions"><button class="button primary" :disabled="!canSync" @click="resetPreview();compare()">立即同步 / 预览差异</button><button class="button" :disabled="!canSync" @click="loadHistory()">历史版本</button><button class="button" :disabled="!canSync" @click="rotating=!rotating">更换同步账号密码</button><button class="button" :disabled="connectionState!=='ready'" @click="rpc('configSync.lock',{},true).catch(cause=>error=cause.message)">锁定</button></div>
      <label>同步方式<select v-model="mode" @change="resetPreview()"><option value="merge">合并两端修改</option><option value="local">整体采用本机</option><option value="remote">整体采用云端</option></select></label>
      <details><summary>云端历史异常处理</summary><label class="check-label"><input v-model="discontinuity" type="checkbox" />我已核查仓库，接受云端历史不连续；仍先预览</label></details>
    </section>
    <section v-if="status?.pending" class="sync-section"><h3>有待核对的上传</h3><p>上传可能已成功。先核对原提交，不要新建一次上传。</p><div class="sync-actions"><button class="button" :disabled="!enabled || !status.unlocked" @click="action(()=>rpc('configSync.recover',{},true,180000))">核对待处理操作</button><button class="button" :disabled="!enabled || !status.unlocked" @click="action(()=>rpc('configSync.recover',{retry:true},true,180000))">核对后重送原提交</button></div></section>
    <section v-if="preview" class="sync-section sync-preview"><h3>{{ preview.first ? '首次同步预览' : preview.mode==='restore' ? '恢复预览' : '同步预览' }}</h3><p>{{ preview.changeCount }} 项差异 · {{ preview.conflicts }} 项未解决冲突</p><p v-for="warning in preview.warnings" :key="warning" class="sync-hint">{{ warning }}</p><p v-if="preview.hasDeletions" class="form-error">本次包含删除，请核对保留来源。</p>
      <details v-for="change in preview.changes" :key="change.key" :open="change.conflict"><summary>{{ change.kind }} · {{ change.name }} <strong v-if="change.conflict">需要选择</strong><span v-else>{{ change.action==='delete'?'涉及删除':change.action==='add'?'新增':'修改' }}</span></summary><div class="sync-comparison"><div><b>本机</b><pre>{{ change.local }}</pre></div><div><b>云端</b><pre>{{ change.remote }}</pre></div></div><label v-if="change.conflict || choices[change.key]">保留来源<select v-model="choices[change.key]"><option :value="undefined" disabled>请选择</option><option value="local">本机</option><option value="remote">云端</option></select></label></details>
      <p v-if="preview.changeCount>preview.changes.length">当前展示 {{ preview.changes.length }} 项，未解决冲突优先显示。更新预览后继续处理其余冲突。</p>
      <div class="sync-actions"><button class="button" :disabled="!canSync" @click="compare">更新预览</button><button class="button primary" :disabled="!canSync || preview.conflicts>0" @click="commit">确认并同步</button><button class="button" @click="resetPreview">取消</button></div>
    </section>
    <section v-if="history" class="sync-section"><h3>加密历史</h3><p v-if="!history.versions.length">尚无历史版本。</p><div v-for="item in history.versions" :key="item.version" class="sync-history-row"><span>{{ time(item.time) }} · {{ item.version.slice(0,8) }}</span><button class="button" :disabled="!canSync" @click="restoreVersion=item.version;preview=undefined">选择恢复</button></div><button v-if="history.cursor" class="button" :disabled="!canSync" @click="loadHistory(true)">更多版本</button>
      <div v-if="restoreVersion"><p>已选择 {{ restoreVersion.slice(0,8) }}，恢复将生成新的当前版本。</p><details><summary>此版本使用旧账号密码</summary><div class="sync-fields"><label>旧同步账号<input v-model="oldAccount" autocomplete="off" /></label><label>旧同步密码<input v-model="oldPassword" type="password" autocomplete="new-password" /></label></div></details><button class="button primary" :disabled="!canSync" @click="compare">预览恢复</button></div>
    </section>
    <section v-if="rotating && status?.unlocked" class="sync-section"><h3>更换同步账号密码</h3><div class="sync-fields"><label>新同步账号<input v-model="nextAccount" autocomplete="off" /></label><label>新同步密码<input v-model="nextPassword" type="password" autocomplete="new-password" /></label><label>确认新密码<input v-model="nextConfirmation" type="password" autocomplete="new-password" /></label></div><label class="check-label"><input v-model="acceptHistory" type="checkbox" />我已知晓：旧 Git 历史与已下载副本仍可能用旧密码解密</label><button class="button primary" :disabled="!canSync || !acceptHistory || !nextAccount || nextPassword.length<12" @click="rotate">重新加密当前配置</button></section>
    <section v-if="status?.bindings.length" class="sync-section"><h3>需要检查本机绑定</h3><p>先在入口编辑中确认 Shell、目录或设备；确认后才允许连接。</p><div v-for="binding in status.bindings" :key="binding.serverId+binding.connectionId" class="sync-history-row"><span>{{ binding.name }}</span><button class="button" :disabled="!enabled" @click="action(()=>rpc('configSync.confirmBinding',{...binding,confirm:true},true))">已检查，允许连接</button></div></section>
    <section v-if="status?.pluginPlan.length" class="sync-section"><h3>插件恢复清单</h3><p>请到插件中心按仓库地址安装所需插件。</p><div v-for="plugin in status.pluginPlan" :key="plugin.id"><strong>{{ plugin.id }}</strong><p class="sync-repository">{{ plugin.repository }} · {{ plugin.commit.slice(0,8) }}</p></div></section>
  </div>
</template>

<style scoped>
.sync-panel{display:grid;gap:16px;min-width:0}.sync-back{justify-self:start}.sync-intro,.sync-hint{color:var(--muted);line-height:1.7}.sync-status,.sync-section{padding:18px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}.sync-status p,.sync-section p{line-height:1.7;margin:10px 0}.sync-section h3{margin:0 0 14px}.sync-section summary{cursor:pointer;font-weight:600;padding:6px 0}.sync-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:14px 0}.sync-panel label{display:flex;flex-direction:column;gap:7px;min-width:0}.sync-panel input:not([type=checkbox]),.sync-panel select{width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink)}.sync-panel .check-label{flex-direction:row;align-items:flex-start;margin:12px 0;line-height:1.6}.check-label input{margin-top:5px}.sync-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.sync-comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sync-comparison>div{min-width:0}.sync-comparison pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;font-size:12px;line-height:1.5;padding:10px;background:var(--surface-soft)}.sync-preview>details{border-top:1px solid var(--border);padding:10px 0}.sync-preview summary span,.sync-preview summary strong{margin-left:10px}.sync-history-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0}.sync-repository{overflow-wrap:anywhere;font-size:12px}.sync-notice{color:var(--accent)}.sync-text-button{border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;padding:0 3px}.sync-panel small{color:var(--muted);line-height:1.5}@media(max-width:640px){.sync-fields,.sync-comparison{grid-template-columns:1fr}.sync-section{padding:12px}.sync-history-row{align-items:flex-start;flex-direction:column}}
</style>
