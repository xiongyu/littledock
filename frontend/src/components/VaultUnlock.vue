<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhLockKey } from '@phosphor-icons/vue'
import { connectionState, unlockVault, vaultStatus } from '../backend'

const dialog = ref<HTMLDialogElement>(), password = ref(''), error = ref(''), busy = ref(false)
const locked = computed(() => connectionState.value === 'locked' || (vaultStatus.value?.mode === 'master' && connectionState.value !== 'ready'))
async function reflectLock() {
  await nextTick()
  if (locked.value) { if (!dialog.value?.open) dialog.value?.showModal() }
  else { dialog.value?.close(); password.value = ''; error.value = '' }
}
watch(locked, reflectLock)
onMounted(reflectLock)
onBeforeUnmount(() => { password.value = ''; dialog.value?.close() })
async function unlock() {
  busy.value = true; error.value = ''
  try { await unlockVault(password.value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('meb153b568f9b') }
  finally { password.value = ''; busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="vault-unlock" aria-labelledby="unlock-title" aria-describedby="unlock-description" @cancel.prevent>
    <form @submit.prevent="unlock">
      <span class="unlock-symbol"><PhLockKey :size="28" /></span>
      <h2 id="unlock-title">{{ i18nT('m6e9469d786b9') }}</h2>
      <p id="unlock-description">{{ i18nT('mb68db5d30dc2') }}</p>
      <label class="form-field"><span>{{ i18nT('mf36f5f11edef') }}</span><input v-model="password" type="password" autocomplete="current-password" maxlength="1024" autofocus required :disabled="busy || connectionState !== 'locked'" /></label>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <p v-if="connectionState !== 'locked'" class="field-hint" role="status">{{ connectionState === 'offline' ? i18nT('mbf93376094fd') : i18nT('mb224e54783af') }}</p>
      <button type="submit" class="button primary" :disabled="busy || connectionState !== 'locked'">{{ busy ? i18nT('mf797426ff1cc') : i18nT('m70fba17fffb7') }}</button>
    </form>
  </dialog>
</template>
