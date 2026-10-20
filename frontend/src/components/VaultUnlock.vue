<script setup lang="ts">
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
  catch (cause) { error.value = cause instanceof Error ? cause.message : '解锁失败。' }
  finally { password.value = ''; busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="vault-unlock" aria-labelledby="unlock-title" aria-describedby="unlock-description" @cancel.prevent>
    <form @submit.prevent="unlock">
      <span class="unlock-symbol"><PhLockKey :size="28" /></span>
      <h2 id="unlock-title">解锁 WebNav</h2>
      <p id="unlock-description">输入主密码，继续使用工作台。</p>
      <label class="form-field"><span>主密码</span><input v-model="password" type="password" autocomplete="current-password" maxlength="1024" autofocus required :disabled="busy || connectionState !== 'locked'" /></label>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <p v-if="connectionState !== 'locked'" class="field-hint" role="status">{{ connectionState === 'offline' ? '本地服务已断开，正在等待重连…' : '正在连接本地服务…' }}</p>
      <button type="submit" class="button primary" :disabled="busy || connectionState !== 'locked'">{{ busy ? '正在解锁…' : '解锁' }}</button>
    </form>
  </dialog>
</template>
