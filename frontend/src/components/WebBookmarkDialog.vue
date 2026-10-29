<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.webBookmarks')

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
    applyBookmarks(result); emit('notify', i18nT('m1781426c3dde')); emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('mcf1487e7aa89'); void synchronizeBookmarks() }
  finally { busy.value = false }
}
async function remove() {
  if (!props.bookmark || busy.value || !ready.value) return
  if (!confirmDelete.value) { confirmDelete.value = true; return }
  busy.value = true; error.value = ''
  try {
    applyBookmarks(await rpc<BookmarkSnapshot>('bookmarks.remove', { id: draft.id, expectedVersion: props.bookmark.version }, true))
    emit('notify', i18nT('m13947c4b7163')); emit('close')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('mf06e4127fc8b'); void synchronizeBookmarks() }
  finally { busy.value = false }
}
async function revealLogin() {
  if (!props.bookmark || busy.value || !ready.value) return
  busy.value = true; error.value = ''; login.value = undefined
  const attempt = ++generation
  try {
    const result = await rpc<WebsiteLogin>('bookmarks.reveal', { id: draft.id, version: props.bookmark.version, masterPassword: masterPassword.value })
    if (generation === attempt && ready.value) login.value = result
  } catch (cause) { if (generation === attempt) error.value = cause instanceof Error ? cause.message : i18nT('m5215599023ee') }
  finally { masterPassword.value = ''; busy.value = false }
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); emit('notify', i18nT('m591b281ea790')) }
  catch { error.value = i18nT('mb037180f72b1') }
}
watch(confirmClose, async value => { if (value) { await nextTick(); dialog.value?.querySelector<HTMLButtonElement>('[data-continue]')?.focus() } })
</script>

<template>
  <dialog ref="dialog" class="management-dialog bookmark-dialog" aria-labelledby="bookmark-dialog-title" v-on="backdropEvents" @cancel.prevent="close">
    <header><h2 id="bookmark-dialog-title">{{ reveal ? bookmark?.name + i18nT('m0a00c0e32f52') : bookmark ? i18nT('m8823cd555cde') : i18nT('me02fe0c55fe3') }}</h2><button class="icon-button" :aria-label="i18nT('m8ec741ca5697')" :disabled="busy && !reveal" @click="close"><PhX :size="20" /></button></header>
    <template v-if="reveal">
      <div v-if="login" class="bookmark-login">
        <label class="form-field"><span>{{ i18nT('m311bb313fdec') }}</span><div class="bookmark-copy-row"><input :value="login.username" :aria-label="i18nT('m3479de591fd9')" readonly autocomplete="off" /><button class="icon-button" :title="i18nT('m80056420fe73')" :aria-label="i18nT('meb2cd8f7e992')" @click="copy(login.username)"><PhCopy :size="18" /></button></div></label>
        <label class="form-field"><span>{{ i18nT('ma621ab606db2') }}</span><div class="bookmark-copy-row"><input :value="login.password" :aria-label="i18nT('m91365ef688ae')" readonly autocomplete="off" /><button class="icon-button" :title="i18nT('mc49aca3e41e2')" :aria-label="i18nT('mdf2ac2c0ab14')" @click="copy(login.password)"><PhCopy :size="18" /></button></div></label>
      </div>
      <form v-else @submit.prevent="revealLogin">
        <p v-if="master" class="bookmark-help">{{ i18nT('m165d1740deac') }}</p>
        <label v-if="master" class="form-field"><span>{{ i18nT('mf36f5f11edef') }}</span><input v-model="masterPassword" type="password" autocomplete="current-password" required maxlength="1024" autofocus :disabled="busy" /></label>
        <p v-if="busy && !master" role="status">{{ i18nT('m86b6d0d63062') }}</p>
        <button class="button primary" :disabled="busy || !ready"><PhKey :size="17" />{{ busy ? i18nT('mc725500abce1') : i18nT('m08c3d6fbbb52') }}</button>
      </form>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </template>
    <form v-else ref="form" @submit.prevent="save">
      <fieldset :disabled="busy || !ready" class="editor-fields">
        <label class="form-field"><span>{{ i18nT('m5a632d88aad2') }}</span><input v-model="draft.name" required maxlength="60" autofocus /></label>
        <label class="form-field"><span>{{ i18nT('ma8ecb4b6dabe') }}</span><input v-model="draft.url" type="url" required maxlength="2048" placeholder="https://example.com/" autocapitalize="off" spellcheck="false" /></label>
        <label class="form-field"><span>{{ i18nT('m311bb313fdec') }}<small v-if="bookmark?.hasLogin">{{ i18nT('m03972021b92f') }}</small></span><input v-model="username" maxlength="256" autocomplete="off" :disabled="clearLogin" :placeholder="bookmark?.hasLogin ? i18nT('mdaab1630bae1') : i18nT('m537352400c49')" /></label>
        <label class="form-field"><span>{{ i18nT('ma621ab606db2') }}</span><input v-model="password" type="password" maxlength="4096" autocomplete="new-password" :disabled="clearLogin" :placeholder="bookmark?.hasLogin ? i18nT('m93e91a4b0a7d') : i18nT('m537352400c49')" /></label>
        <label v-if="bookmark?.hasLogin" class="check-label"><input v-model="clearLogin" type="checkbox" />{{ i18nT('mbfce8a6870cf') }}</label>
        <p class="bookmark-help">{{ i18nT('m04076a178e32') }}</p>
        <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      </fieldset>
        <div v-if="confirmClose" class="bookmark-unsaved" role="alert">
          <p>{{ i18nT('m5c3ce8a53ae6') }}</p>
          <div class="bookmark-dialog-actions"><button data-continue type="button" class="button" @click="confirmClose = false">{{ i18nT('mfd4b9e3b6c68') }}</button><button type="button" class="button" @click="emit('close')">{{ i18nT('m8bcc3e177f5f') }}</button><button class="button primary" :disabled="busy || !ready">{{ i18nT('ma3030bf8f16d') }}</button></div>
        </div>
        <div v-else class="form-actions">
          <button v-if="bookmark" type="button" class="button danger-button" :disabled="busy || !ready" @click="remove"><PhTrash :size="17" />{{ confirmDelete ? i18nT('ma3ea3c17b401') : i18nT('m2f9daa828907') }}</button><span class="action-spacer"></span>
          <button type="button" class="button" :disabled="busy" @click="close">{{ i18nT('m2cd0f3be8738') }}</button><button class="button primary" :disabled="busy || !ready"><PhCheck :size="17" />{{ busy ? i18nT('mff509c9ba052') : i18nT('ma3030bf8f16d') }}</button>
        </div>
    </form>
  </dialog>
</template>
