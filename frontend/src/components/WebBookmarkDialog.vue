<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { PhX, PhCheck, PhTrash, PhCopy, PhKey } from '@phosphor-icons/vue'
import { validateBookmark, type BookmarkSnapshot, type WebBookmark, type WebsiteLogin } from '@webnav/shared'
import { applyBookmarks, bookmarks, connectionState, rpc, synchronizeBookmarks, vaultStatus } from '../backend'
import { createBackdropGuard } from '../dialog-backdrop'

const props = defineProps<{ bookmark?: WebBookmark; reveal?: boolean }>()
const emit = defineEmits<{ close: []; notify: [message: string] }>()
const dialog = ref<HTMLDialogElement>(), form = ref<HTMLFormElement>()
const draft = reactive({ id: props.bookmark?.id ?? crypto.randomUUID(), name: props.bookmark?.name ?? '', url: props.bookmark?.url ?? '' })
const initial = JSON.stringify(draft)
const username = ref(''), password = ref(''), clearLogin = ref(false), masterPassword = ref('')
const login = ref<WebsiteLogin>(), busy = ref(false), error = ref(''), confirmClose = ref(false), confirmDelete = ref(false)
const master = computed(() => vaultStatus.value?.mode === 'master')
const dirty = computed(() => JSON.stringify(draft) !== initial || !!username.value || !!password.value || clearLogin.value)
let generation = 0
const ready = computed(() => connectionState.value === 'ready')
function close() {
  if (busy.value && !props.reveal) return
  if (!props.reveal && dirty.value) { confirmClose.value = true; return }
  emit('close')
}
const backdropEvents = createBackdropGuard(close)
onMounted(async () => {
  dialog.value?.showModal()
  if (props.reveal && !master.value) await revealLogin()
})
onBeforeUnmount(() => {
  generation++; username.value = ''; password.value = ''; masterPassword.value = ''; login.value = undefined
  dialog.value?.close()
})
watch([connectionState, () => vaultStatus.value?.mode], () => {
  if (props.reveal) emit('close')
})
watch(() => bookmarks.value.find(item => item.id === draft.id)?.version, version => {
  if (props.reveal && version !== props.bookmark?.version) emit('close')
})
async function save() {
  if (busy.value || !ready.value || !form.value?.reportValidity()) return
  error.value = ''
  try { validateBookmark({ ...draft, url: draft.url.trim() }) } catch (cause) { error.value = (cause as Error).message; return }
  busy.value = true
  try {
    const update = clearLogin.value ? null : username.value || password.value ? {
      ...(username.value ? { username: username.value } : {}), ...(password.value ? { password: password.value } : {}),
    } : undefined
    const result = await rpc<BookmarkSnapshot>('bookmarks.save', { bookmark: { ...draft, url: draft.url.trim() }, expectedVersion: props.bookmark?.version ?? 0, ...(update !== undefined ? { login: update } : {}) }, true)
    applyBookmarks(result); emit('notify', '网页收藏已保存。'); emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败。'; void synchronizeBookmarks() }
  finally { busy.value = false }
}
async function remove() {
  if (!props.bookmark || busy.value || !ready.value) return
  if (!confirmDelete.value) { confirmDelete.value = true; return }
  busy.value = true; error.value = ''
  try {
    applyBookmarks(await rpc<BookmarkSnapshot>('bookmarks.remove', { id: draft.id, expectedVersion: props.bookmark.version }, true))
    emit('notify', '网页收藏已删除。'); emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '删除失败。'; void synchronizeBookmarks() }
  finally { busy.value = false }
}
async function revealLogin() {
  if (!props.bookmark || busy.value || !ready.value) return
  busy.value = true; error.value = ''; login.value = undefined
  const attempt = ++generation
  try {
    const result = await rpc<WebsiteLogin>('bookmarks.reveal', { id: draft.id, version: props.bookmark.version, masterPassword: masterPassword.value })
    if (generation === attempt && ready.value) login.value = result
  } catch (cause) { if (generation === attempt) error.value = cause instanceof Error ? cause.message : '读取失败。' }
  finally { masterPassword.value = ''; busy.value = false }
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); emit('notify', '已复制。') }
  catch { error.value = '无法写入剪贴板，请选中文字复制。' }
}
watch(confirmClose, async value => { if (value) { await nextTick(); dialog.value?.querySelector<HTMLButtonElement>('[data-continue]')?.focus() } })
</script>

<template>
  <dialog ref="dialog" class="management-dialog bookmark-dialog" aria-labelledby="bookmark-dialog-title" v-on="backdropEvents" @cancel.prevent="close">
    <header><h2 id="bookmark-dialog-title">{{ reveal ? bookmark?.name + ' · 账号密码' : bookmark ? '编辑网页收藏' : '添加网页收藏' }}</h2><button class="icon-button" aria-label="关闭网页收藏面板" :disabled="busy && !reveal" @click="close"><PhX :size="20" /></button></header>
    <template v-if="reveal">
      <div v-if="login" class="bookmark-login">
        <label class="form-field"><span>账号</span><div class="bookmark-copy-row"><input :value="login.username" aria-label="已保存的网站账号" readonly autocomplete="off" /><button class="icon-button" title="复制账号" aria-label="复制网站账号" @click="copy(login.username)"><PhCopy :size="18" /></button></div></label>
        <label class="form-field"><span>密码</span><div class="bookmark-copy-row"><input :value="login.password" aria-label="已保存的网站密码" readonly autocomplete="off" /><button class="icon-button" title="复制密码" aria-label="复制网站密码" @click="copy(login.password)"><PhCopy :size="18" /></button></div></label>
      </div>
      <form v-else @submit.prevent="revealLogin">
        <p v-if="master" class="bookmark-help">查看此网站的账密，请再次输入主密码。</p>
        <label v-if="master" class="form-field"><span>主密码</span><input v-model="masterPassword" type="password" autocomplete="current-password" required maxlength="1024" autofocus :disabled="busy" /></label>
        <p v-if="busy && !master" role="status">正在读取…</p>
        <button class="button primary" :disabled="busy || !ready"><PhKey :size="17" />{{ busy ? '正在验证…' : '查看账号密码' }}</button>
      </form>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </template>
    <form v-else ref="form" @submit.prevent="save">
      <fieldset :disabled="busy || !ready" class="editor-fields">
        <label class="form-field"><span>网站名称</span><input v-model="draft.name" required maxlength="60" autofocus /></label>
        <label class="form-field"><span>网址</span><input v-model="draft.url" type="url" required maxlength="2048" placeholder="https://example.com/" autocapitalize="off" spellcheck="false" /></label>
        <label class="form-field"><span>账号 <small v-if="bookmark?.hasLogin">账密已保存</small></span><input v-model="username" maxlength="256" autocomplete="off" :disabled="clearLogin" :placeholder="bookmark?.hasLogin ? '留空保持原账号' : '可选'" /></label>
        <label class="form-field"><span>密码</span><input v-model="password" type="password" maxlength="4096" autocomplete="new-password" :disabled="clearLogin" :placeholder="bookmark?.hasLogin ? '留空保持原密码' : '可选'" /></label>
        <label v-if="bookmark?.hasLogin" class="check-label"><input v-model="clearLogin" type="checkbox" />清除已保存的账号密码</label>
        <p class="bookmark-help">截图使用未登录的页面，可在卡片上手动刷新。</p>
        <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      </fieldset>
        <div v-if="confirmClose" class="bookmark-unsaved" role="alert">
          <p>有未保存的修改，要保存吗？</p>
          <div class="bookmark-dialog-actions"><button data-continue type="button" class="button" @click="confirmClose = false">继续编辑</button><button type="button" class="button" @click="emit('close')">不保存</button><button class="button primary" :disabled="busy || !ready">保存</button></div>
        </div>
        <div v-else class="form-actions">
          <button v-if="bookmark" type="button" class="button danger-button" :disabled="busy || !ready" @click="remove"><PhTrash :size="17" />{{ confirmDelete ? '确认删除' : '删除' }}</button><span class="action-spacer"></span>
          <button type="button" class="button" :disabled="busy" @click="close">取消</button><button class="button primary" :disabled="busy || !ready"><PhCheck :size="17" />{{ busy ? '保存中…' : '保存' }}</button>
        </div>
    </form>
  </dialog>
</template>
