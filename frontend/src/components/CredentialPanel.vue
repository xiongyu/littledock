<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { rpc } from '../backend'
const props = defineProps<{ serverId: string; connectionId: string }>()
const emit = defineEmits<{ saved: [] }>()
const kind = ref<'password' | 'key'>('key'), path = ref(''), secret = ref(''), clearSecret = ref(false), hasSecret = ref(false), error = ref(''), busy = ref(false)
onMounted(async () => { try { const data = await rpc<{kind:'key'|'password';path:string;hasSecret:boolean}>('credentials.describe', {serverId:props.serverId,connectionId:props.connectionId}); kind.value=data.kind;path.value=data.path;hasSecret.value=data.hasSecret } catch(cause) { error.value=cause instanceof Error ? cause.message : '无法读取认证设置。' } })
onBeforeUnmount(() => { secret.value='' })
async function save() {
  busy.value=true;error.value=''
  try { await rpc('credentials.save', {serverId:props.serverId,connectionId:props.connectionId,kind:kind.value,path:path.value,...(secret.value || clearSecret.value ? {secret:secret.value} : {})},true);emit('saved') } catch(cause) { error.value=cause instanceof Error ? cause.message : '保存失败。' } finally { secret.value='';busy.value=false }
}
</script>
<template>
  <form class="credential-form" @submit.prevent="save">
    <label class="form-field"><span>认证方式</span><select v-model="kind"><option value="key">本机私钥</option><option value="password">登录密码</option></select></label>
    <label v-if="kind === 'key'" class="form-field"><span>私钥文件路径</span><input v-model="path" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="本机私钥文件的绝对路径" /></label>
    <label class="form-field"><span>{{ kind === 'key' ? '私钥口令（可选）' : '登录密码' }}</span><input v-model="secret" type="password" maxlength="4096" autocomplete="new-password" :placeholder="hasSecret ? '已保存，留空保持不变' : kind === 'key' ? '无口令时留空' : '输入密码后保存'" /></label>
    <label v-if="kind === 'key' && hasSecret" class="check-label"><input v-model="clearSecret" type="checkbox" />清除已保存的私钥口令</label>
    <p class="field-hint">私钥由后端从本机文件读取，不复制到浏览器。</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><div class="form-actions"><button class="button primary" :disabled="busy">保存认证信息</button></div>
  </form>
</template>
