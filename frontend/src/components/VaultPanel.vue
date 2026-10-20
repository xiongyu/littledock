<script setup lang="ts">
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
    if (enabled.value && password.value !== confirmation.value) throw new Error('两次主密码不一致。')
    if (enabled.value && !hasMaster.value && !password.value) throw new Error('请输入主密码。')
    const unlockMinutes = lifetime.value === 'custom' ? customMinutes.value : Number(lifetime.value)
    await updateVault({ mode: enabled.value ? 'master' : 'local', unlockMinutes, ...(enabled.value && password.value ? { password: password.value } : {}) })
    message.value = enabled.value ? '已保存，所有密码统一加密。' : '已保存，所有密码使用可逆编码。'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '设置失败。' }
  finally { password.value = ''; confirmation.value = ''; busy.value = false }
}
async function lock() {
  busy.value = true; error.value = ''
  try { await rpc('vault.lock', {}, true) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '锁定失败。' }
  finally { busy.value = false }
}
</script>
<template>
  <form class="vault-panel" @submit.prevent="save">
    <fieldset class="settings-fields" :disabled="busy">
      <label class="settings-toggle"><span><strong>主密码</strong><small>统一管理所有连接密码和私钥口令</small></span><input v-model="enabled" type="checkbox" role="switch" aria-label="启用主密码" /></label>
      <p class="field-hint">{{ enabled ? '保存后，已有密码和以后保存的密码都使用主密码加密。' : '未设置主密码，密码默认编码保存，打开即可使用。' }}</p>
      <template v-if="enabled">
        <label class="form-field"><span>{{ hasMaster ? '新主密码' : '设置主密码' }}</span><input v-model="password" type="password" autocomplete="new-password" :required="!hasMaster" minlength="8" maxlength="1024" :placeholder="hasMaster ? '留空保持现有主密码' : '至少 8 个字符'" /></label>
        <label class="form-field"><span>确认主密码</span><input v-model="confirmation" type="password" autocomplete="new-password" :required="!!password" maxlength="1024" placeholder="再输入一次" /></label>
      </template>
      <label class="form-field settings-lifetime"><span>解锁有效期</span><select v-model="lifetime" :disabled="!enabled" aria-label="解锁有效期">
        <option value="5">5 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option><option value="240">4 小时</option><option value="1440">1 天</option><option value="10080">7 天</option><option value="0">永不过期（服务运行期间）</option><option value="custom">自定义分钟数</option>
      </select></label>
      <label v-if="lifetime === 'custom'" class="form-field"><span>有效分钟数</span><input v-model.number="customMinutes" type="number" :disabled="!enabled" min="1" max="525600" step="1" required /></label>
      <p class="field-hint">从解锁时开始计时，刷新和新标签共用有效期。永不过期时，服务重启后再输入。</p>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <p v-if="message" class="field-hint" role="status">{{ message }}</p>
      <div class="form-actions"><button v-if="hasMaster" class="button" type="button" @click="lock">立即锁定</button><button class="button primary" type="submit">{{ busy ? '正在保存…' : '保存设置' }}</button></div>
    </fieldset>
  </form>
</template>
