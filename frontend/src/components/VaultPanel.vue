<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { computed, onBeforeUnmount, ref } from 'vue'
import { rpc, updateVault, vaultStatus } from '../backend'

const enabled = ref(vaultStatus.value?.mode === 'master')
const presets = [5, 15, 30, 60, 240, 1440, 10080, 0]
const minutes = vaultStatus.value?.unlockMinutes ?? 0
const lifetime = ref(presets.includes(minutes) ? String(minutes) : 'custom')
const customMinutes = ref(minutes || 30)
const password = ref(''), confirmation = ref(''), busy = ref(false), error = ref(''), message = ref('')
const hasMaster = computed(() => vaultStatus.value?.mode === 'master')
onBeforeUnmount(() => { password.value = ''; confirmation.value = '' })

async function save() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    if (enabled.value && password.value !== confirmation.value) throw new Error(i18nT('m0b9df9b50033'))
    if (enabled.value && !hasMaster.value && !password.value) throw new Error(i18nT('mc8ea1db856c8'))
    const unlockMinutes = lifetime.value === 'custom' ? customMinutes.value : Number(lifetime.value)
    await updateVault({ mode: enabled.value ? 'master' : 'local', unlockMinutes, ...(enabled.value && password.value ? { password: password.value } : {}) })
    message.value = enabled.value ? i18nT('m7b3d2799f8e4') : i18nT('md05a29cef68c')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('m43510a685e34') }
  finally { password.value = ''; confirmation.value = ''; busy.value = false }
}
async function lock() {
  busy.value = true; error.value = ''
  try { await rpc('vault.lock', {}, true) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : i18nT('m4c5ed96df85b') }
  finally { busy.value = false }
}
</script>
<template>
  <form class="vault-panel" @submit.prevent="save">
    <fieldset class="settings-fields" :disabled="busy">
      <label class="settings-toggle"><span><strong>{{ i18nT('mf36f5f11edef') }}</strong><small>{{ i18nT('m5e5ce3a786b5') }}</small></span><input v-model="enabled" type="checkbox" role="switch" :aria-label="i18nT('m6fe2c998c739')" /></label>
      <p class="field-hint">{{ enabled ? i18nT('m5733fa80d807') : i18nT('ma9b24ca80ebc') }}</p>
      <template v-if="enabled">
        <label class="form-field"><span>{{ hasMaster ? i18nT('m1cdcd2c700d0') : i18nT('m0a72ed1550a7') }}</span><input v-model="password" type="password" autocomplete="new-password" :required="!hasMaster" minlength="8" maxlength="1024" :placeholder="hasMaster ? i18nT('me99dd575dede') : i18nT('md20553030ce5')" /></label>
        <label class="form-field"><span>{{ i18nT('m12aaa082bc80') }}</span><input v-model="confirmation" type="password" autocomplete="new-password" :required="!!password" maxlength="1024" :placeholder="i18nT('mf725268ab2d3')" /></label>
      </template>
      <label class="form-field settings-lifetime"><span>{{ i18nT('m617277819a7d') }}</span><select v-model="lifetime" :disabled="!enabled" :aria-label="i18nT('m617277819a7d')">
        <option value="5">{{ i18nT('m9d9a5e5793d1') }}</option><option value="15">{{ i18nT('m015feae6f8e4') }}</option><option value="30">{{ i18nT('ma01a28d147ac') }}</option><option value="60">{{ i18nT('m5482d1abc42f') }}</option><option value="240">{{ i18nT('m5f90852bb321') }}</option><option value="1440">{{ i18nT('m30c21284df4f') }}</option><option value="10080">{{ i18nT('m38eefacbb326') }}</option><option value="0">{{ i18nT('m643d1dbeaa94') }}</option><option value="custom">{{ i18nT('m45809131f9a2') }}</option>
      </select></label>
      <label v-if="lifetime === 'custom'" class="form-field"><span>{{ i18nT('md0af69476364') }}</span><input v-model.number="customMinutes" type="number" :disabled="!enabled" min="1" max="525600" step="1" required /></label>
      <p class="field-hint">{{ i18nT('m008d46dbfc54') }}</p>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <p v-if="message" class="field-hint" role="status">{{ message }}</p>
      <div class="form-actions"><button v-if="hasMaster" class="button" type="button" @click="lock">{{ i18nT('m44fe1de7b6ef') }}</button><button class="button primary" type="submit">{{ busy ? i18nT('m6bdb4435095e') : i18nT('mc8550237ba70') }}</button></div>
    </fieldset>
  </form>
</template>
