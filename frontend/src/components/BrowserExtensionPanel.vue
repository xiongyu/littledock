<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowLeft, PhCopy, PhTrash, PhArrowClockwise } from '@phosphor-icons/vue'
import type { ExtensionStatus } from '@webnav/shared'
import { connectionState, rpc, vaultStatus } from '../backend'
defineEmits<{ back: [] }>()
const state = ref<ExtensionStatus>({ devices: [] }), name = ref('我的浏览器'), password = ref(''), busy = ref(false), error = ref(''), message = ref('')
const pairing = ref<{ id: string; code: string; expiresAt: number }>(), now = ref(Date.now())
const enabled = computed(() => connectionState.value === 'ready' && vaultStatus.value?.unlocked)
const seconds = computed(() => Math.max(0, Math.ceil(((pairing.value?.expiresAt ?? 0) - now.value) / 1000)))
let alive = true, generation = 0, polling = false, timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  if (!enabled.value || polling) return
  polling = true; const expected = generation
  try {
    const next = await rpc<ExtensionStatus>('extensions.status')
    if (!alive || !enabled.value || expected !== generation) return
    state.value = next
    if (pairing.value && next.devices.some(d => d.id === pairing.value!.id)) { pairing.value = undefined; message.value = '浏览器已配对。打开目标网站，从扩展图标选择账号即可填写。' }
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '读取授权失败。' }
  finally { polling = false }
}
function cancel() {
  const old = pairing.value; pairing.value = undefined; password.value = ''; generation++
  if (old && connectionState.value === 'ready') void rpc('extensions.cancelPairing', { id: old.id }, true).catch(() => {})
}
async function begin() {
  if (busy.value || !enabled.value) return
  const masterPassword = password.value
  cancel(); const expected = generation; busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await rpc<{ id: string; code: string; expiresAt: number }>('extensions.beginPairing', { name: name.value, masterPassword }, true)
    if (!alive || !enabled.value || expected !== generation) { void rpc('extensions.cancelPairing', { id: result.id }, true).catch(() => {}); return }
    pairing.value = result
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : '生成配对码失败。' }
  finally { password.value = ''; busy.value = false }
}
async function copy() { if (!pairing.value) return; try { await navigator.clipboard.writeText(pairing.value.code); message.value = '已复制，请粘贴到浏览器扩展中。' } catch { error.value = '无法访问剪贴板，请手动复制配对码。' } }
async function revoke(id: string, bookmarkId?: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { state.value = await rpc<ExtensionStatus>(bookmarkId ? 'extensions.revokeGrant' : 'extensions.revoke', { id, ...(bookmarkId ? { bookmarkId } : {}) }, true); message.value = bookmarkId ? '已撤销此网站的填写授权。' : '已撤销浏览器授权。' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '撤销失败，请刷新核对。' }
  finally { busy.value = false }
}
watch(enabled, value => { if (!value) { cancel(); state.value = { devices: [] } } else void refresh() })
onMounted(() => { void refresh(); timer = setInterval(() => { now.value = Date.now(); if (pairing.value && !seconds.value) cancel(); if (pairing.value) void refresh() }, 1000) })
onBeforeUnmount(() => { alive = false; clearInterval(timer); cancel() })
</script>
<template>
  <section class="extension-panel">
    <button class="button extension-back" @click="$emit('back')"><PhArrowLeft :size="16" />全局设置</button>
    <p class="field-hint">已配对的浏览器可使用网页收藏中的账密，也可从扩展保存当前网页和已输入的账号密码。按完整域名或 IP 匹配，HTTP / HTTPS 共用，非默认端口区分。每个网站首次选择后授权；主密码锁定后停止填写和保存。</p>
    <div class="extension-downloads"><a class="button" href="/extensions/webnav-chrome.zip" download>Chrome 扩展</a><a class="button" href="/extensions/webnav-edge.zip" download>Edge 扩展</a><a class="button" href="/extensions/webnav-firefox.zip" download>Firefox 扩展</a></div>
    <details class="extension-help"><summary>如何安装</summary><p>Chrome / Edge：解压安装包，在扩展管理页开启开发者模式，选择“加载已解压的扩展”，选中解压后的文件夹。</p><p>Firefox：当前提供未签名开发包。在 about:debugging → 此 Firefox → 临时载入附加组件中选择解压后的 manifest.json，浏览器重启后需要重新载入。正式持久安装需 Mozilla 签名。</p></details>
    <form class="extension-pairing" @submit.prevent="begin">
      <h3>配对一个浏览器</h3>
      <label class="form-field"><span>浏览器名称</span><input v-model="name" maxlength="60" required :disabled="busy || !enabled" placeholder="例如：工作 Edge" /></label>
      <label v-if="vaultStatus?.mode === 'master'" class="form-field"><span>再次输入主密码</span><input v-model="password" type="password" autocomplete="current-password" required :disabled="busy || !enabled" /></label>
      <p class="field-hint">配对身份仅保存在本机，不参与配置同步。网站账号密码不会保存在扩展中。</p>
      <button class="button primary" type="submit" :disabled="busy || !enabled">{{ busy ? '正在处理…' : '生成一次性配对码' }}</button>
    </form>
    <div v-if="pairing" class="extension-code"><div><strong>在 {{ seconds }} 秒内粘贴到扩展</strong><button class="icon-button" title="复制配对码" aria-label="复制配对码" @click="copy"><PhCopy :size="18" /></button></div><textarea :value="pairing.code" readonly aria-label="一次性配对码" rows="3" spellcheck="false" /><button class="button" @click="cancel">取消配对</button></div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><p v-if="message" class="field-hint" role="status">{{ message }}</p>
    <div class="extension-heading"><h3>已配对浏览器</h3><button class="icon-button" title="刷新授权列表" aria-label="刷新授权列表" :disabled="!enabled" @click="refresh"><PhArrowClockwise :size="18" /></button></div>
    <p v-if="!state.devices.length" class="field-hint">{{ enabled ? '尚未配对浏览器。' : '连接并解锁 WebNav 后查看授权。' }}</p>
    <article v-for="device in state.devices" :key="device.id" class="extension-device"><div class="extension-heading"><div><strong>{{ device.name }}</strong><small>最近连接：{{ new Date(device.lastUsedAt).toLocaleString() }}</small></div><button class="icon-button" :title="`撤销 ${device.name} 授权`" :aria-label="`撤销 ${device.name} 授权`" :disabled="busy || !enabled" @click="revoke(device.id)"><PhTrash :size="18" /></button></div>
      <p v-if="!device.grants.length" class="field-hint">尚未授权网站。在对应网站点击扩展图标，选择账号并填写。</p>
      <div v-for="grant in device.grants" :key="grant.bookmarkId" class="extension-grant"><div><strong>{{ grant.name }}</strong><small>{{ grant.origin }} · {{ grant.automatic ? '自动填写' : '点击填写' }}</small></div><button class="icon-button" :title="`撤销 ${grant.name} 填写授权`" :aria-label="`撤销 ${grant.name} 填写授权`" :disabled="busy || !enabled" @click="revoke(device.id, grant.bookmarkId)"><PhTrash :size="16" /></button></div>
    </article>
  </section>
</template>
<style scoped>
.extension-panel{display:grid;gap:16px}.extension-back{justify-self:start;display:flex;align-items:center;gap:8px}.extension-panel h3,.extension-panel p{margin:0}.extension-downloads{display:flex;flex-wrap:wrap;gap:8px}.extension-downloads a{text-decoration:none}.extension-help{font-size:13px;color:var(--muted);line-height:1.7}.extension-help p{margin-top:10px}.extension-pairing{display:grid;gap:14px;padding-top:12px;border-top:1px solid var(--border)}.extension-pairing .primary{justify-self:start}.extension-code{display:grid;gap:10px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}.extension-code>div,.extension-heading,.extension-grant{display:flex;align-items:center;justify-content:space-between;gap:12px}.extension-code textarea{width:100%;resize:vertical;word-break:break-all;background:var(--page);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:10px}.extension-device{border:1px solid var(--border);border-radius:12px;padding:14px;display:grid;gap:12px}.extension-device small{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.extension-heading>div,.extension-grant>div{min-width:0}.extension-grant{padding-top:10px;border-top:1px solid var(--border)}.extension-grant strong{font-size:13px}
</style>
