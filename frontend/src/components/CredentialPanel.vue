<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { rpc } from '../backend'
const props = defineProps<{ serverId: string; connectionId: string }>()
const emit = defineEmits<{ saved: [] }>()
const kind = ref<'password' | 'key'>('key'), path = ref(''), secret = ref(''), clearSecret = ref(false), hasSecret = ref(false), error = ref(''), busy = ref(false)
onMounted(async () => { try { const data = await rpc<{kind:'key'|'password';path:string;hasSecret:boolean}>('credentials.describe', {serverId:props.serverId,connectionId:props.connectionId}); kind.value=data.kind;path.value=data.path;hasSecret.value=data.hasSecret } catch(cause) { error.value=cause instanceof Error ? cause.message : i18nT('m212da9769ab8') } })
onBeforeUnmount(() => { secret.value='' })
async function save() {
  busy.value=true;error.value=''
  try { await rpc('credentials.save', {serverId:props.serverId,connectionId:props.connectionId,kind:kind.value,path:path.value,...(secret.value || clearSecret.value ? {secret:secret.value} : {})},true);emit('saved') } catch(cause) { error.value=cause instanceof Error ? cause.message : i18nT('mcf1487e7aa89') } finally { secret.value='';busy.value=false }
}
</script>
<template>
  <form class="credential-form" @submit.prevent="save">
    <label class="form-field"><span>{{ i18nT('md1ff8f98bc3f') }}</span><select v-model="kind"><option value="key">{{ i18nT('m3e7809d8fba6') }}</option><option value="password">{{ i18nT('mfb5bbea8d049') }}</option></select></label>
    <label v-if="kind === 'key'" class="form-field"><span>{{ i18nT('m8e7189f6d17d') }}</span><input v-model="path" required maxlength="2048" autocomplete="off" spellcheck="false" :placeholder="i18nT('mf7fe5792255c')" /></label>
    <label class="form-field"><span>{{ kind === 'key' ? i18nT('m9f46b6e64fa5') : i18nT('mfb5bbea8d049') }}</span><input v-model="secret" type="password" maxlength="4096" autocomplete="new-password" :placeholder="hasSecret ? i18nT('m4ae398ebce8f') : kind === 'key' ? i18nT('mcbd794258c7e') : i18nT('m692ebe3a9a3f')" /></label>
    <label v-if="kind === 'key' && hasSecret" class="check-label"><input v-model="clearSecret" type="checkbox" />{{ i18nT('m49dad8c7b7bd') }}</label>
    <p class="field-hint">{{ i18nT('ma90c64f07b8a') }}</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p><div class="form-actions"><button class="button primary" :disabled="busy">{{ i18nT('me35ed47760d6') }}</button></div>
  </form>
</template>
