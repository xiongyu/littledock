<script lang="ts">
const storageKey = 'webnav.clipboard-permission-hint.v1'
let shownThisPage = false
function wasShown(doc: Document) {
  if (shownThisPage) return true
  try { return doc.defaultView?.localStorage.getItem(storageKey) === 'shown' } catch { return false }
}
function rememberShown(doc: Document) {
  shownThisPage = true
  try { doc.defaultView?.localStorage.setItem(storageKey, 'shown') } catch { /* Still remember for this page when storage is unavailable. */ }
}
</script>
<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { pluginI18n } from '../i18n.ts'
import { createBackdropGuard } from '../dialog-backdrop'

const { t } = pluginI18n('builtin.sessions')
const props = defineProps<{ enabled: boolean; ownerDocument?: Document }>()
const emit = defineEmits<{ paste: []; dismiss: [] }>()
const dialog = ref<HTMLDialogElement>(), id = useId()
function close() { dialog.value?.close() }
function dismiss() { close(); emit('dismiss') }
const backdropEvents = createBackdropGuard(dismiss)
function requestPaste() {
  if (!props.enabled || !dialog.value || dialog.value.open) return
  const doc = dialog.value.ownerDocument
  if (wasShown(doc)) { emit('paste'); return }
  dialog.value.showModal()
  rememberShown(doc)
}
function continuePaste() {
  if (!dialog.value?.open) return
  close()
  // Keep readText in this click's user gesture, without nextTick or a permission query first.
  if (props.enabled) emit('paste')
}
watch(() => props.enabled, enabled => { if (!enabled) close() }, { flush: 'sync' })
watch(() => props.ownerDocument, close, { flush: 'sync' })
onBeforeUnmount(close)
defineExpose({ requestPaste })
</script>
<template>
  <dialog ref="dialog" class="clipboard-permission-hint" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-body ${id}-note`" v-on="backdropEvents" @cancel.prevent="dismiss" @keydown.stop @contextmenu.stop>
    <h2 :id="`${id}-title`">{{ t('clipboardPermission.title') }}</h2>
    <p :id="`${id}-body`">{{ t('clipboardPermission.body') }}</p>
    <p :id="`${id}-note`" class="clipboard-permission-note">{{ t('clipboardPermission.note') }}</p>
    <div class="form-actions">
      <button type="button" class="button" @click="dismiss">{{ t('clipboardPermission.cancel') }}</button>
      <button type="button" class="button primary" autofocus @click="continuePaste">{{ t('clipboardPermission.continue') }}</button>
    </div>
  </dialog>
</template>
<style scoped>
.clipboard-permission-hint { width: min(440px, calc(100vw - 32px)); max-width: none; padding: 24px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
.clipboard-permission-hint::backdrop { background: #101a1859; }
h2 { margin: 0 0 16px; font-size: 18px; }
p { margin: 12px 0; line-height: 1.7; }
.clipboard-permission-note { color: var(--muted); font-size: 12px; }
.form-actions { flex-wrap: wrap; }
</style>
