<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.mcp')

import { computed, onMounted, ref } from 'vue'
import type { AutomationGrant } from '@webnav/shared'
import { rpc, servers, automationTasks } from '../backend'
defineEmits<{back:[]}>()
defineProps<{ embedded?: boolean }>()
type Settings={enabled:boolean;clients:{id:string;name:string;grantId:string;revoked:number}[];grants:AutomationGrant[];tools:{name:string;title:string;provider:string;scopes:string[]}[]}
const settings=ref<Settings>(),error=ref(''),busy=ref(false),name=ref(i18nT('mdeaa69222d4e')),grantId=ref('read'),config=ref(''),expiry=ref(0)
const editing=ref(false),grantName=ref(i18nT('m54b241b1c761')),editId=ref(''),scopes=ref(['catalog.read','plugins.read']),allTargets=ref(false),targets=ref<string[]>([]),paths=ref('/')
const builtins:Record<string,string>={get 'catalog.read'() { return i18nT('md6b2d0fa8f77') },get 'plugins.read'() { return i18nT('m5d594494ccdd') },get 'ssh.execute'() { return i18nT('mb6da8e160956') },get 'system.read'() { return i18nT('md18195291ba8') },get 'files.read'() { return i18nT('m407dd16f938f') },get 'files.write'() { return i18nT('m533f9a4f1d10') },get 'history.read'() { return i18nT('m0ad1cf3c5474') },get 'bookmarks.read'() { return i18nT('mabc2cf89648d') }}
const scopeOptions=computed(()=>[...new Set([...Object.keys(builtins),...(settings.value?.tools.flatMap(t=>t.scopes)??[])])])
const targetOptions=computed(()=>servers.value.flatMap(s=>s.connections.filter(c=>c.type==='ssh').map(c=>({id:JSON.stringify([s.id,c.id]),name:s.name+' · '+(c.name||'SSH')}))))
async function run(action:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(e){error.value=(e as Error).message}finally{busy.value=false}}
async function load(){settings.value=await rpc<Settings>('automation.settings')}
function edit(grant?:AutomationGrant){editing.value=true;editId.value=grant?.id??'';grantName.value=grant?.name??i18nT('m54b241b1c761');scopes.value=grant?[...grant.scopes]:['catalog.read','plugins.read'];allTargets.value=grant?.targets===null;targets.value=grant?.targets?.map(t=>JSON.stringify(t))??[];paths.value=grant?.paths.join('\n')??'/'}
async function save(){await run(async()=>{await rpc('automation.grant',{...(editId.value?{id:editId.value}:{}),name:grantName.value,scopes:scopes.value,targets:allTargets.value?null:targets.value.map(t=>JSON.parse(t)),paths:paths.value.split('\n').map(s=>s.trim()).filter(Boolean)},true);editing.value=false;await load()})}
async function pair(){await run(async()=>{const p=await rpc<{config:unknown;expiresAt:number}>('automation.pair',{name:name.value,grantId:grantId.value},true);config.value=JSON.stringify(p.config,null,2);expiry.value=p.expiresAt;await load()})}
function copyConfig(){void run(async()=>{await navigator.clipboard.writeText(config.value)})}
onMounted(()=>run(load))
</script>
<template>
  <section class="automation-panel">
    <button v-if="!embedded" class="text-button" @click="$emit('back')">{{ i18nT('m0cec99ee0b8d') }}</button>
    <p>{{ i18nT('m3a820caa2420') }}</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <template v-if="settings">
      <label class="check-label"><input type="checkbox" :checked="settings.enabled" :disabled="busy" @change="run(async()=>{await rpc('automation.enabled',{enabled:!settings!.enabled},true);await load()})"/>{{ i18nT('m24acd67b17ff') }}</label>
      <h3>{{ i18nT('md136ed06402c') }}</h3>
      <div v-for="grant in settings.grants" :key="grant.id" class="automation-row"><span>{{ grant.name }} <small>{{ i18nT('m2cf1f2004aa9', { p0: (grant.scopes.length) }) }}</small></span><button class="button" :disabled="busy" @click="edit(grant)">{{ i18nT('m051836569928') }}</button></div>
      <button class="button" :disabled="busy" @click="edit()">{{ i18nT('m07816bf377ef') }}</button>
      <form v-if="editing" class="automation-form" @submit.prevent="save">
        <label>{{ i18nT('mf7816a356dbc') }}<input v-model="grantName" required maxlength="80"/></label>
        <fieldset><legend>{{ i18nT('m6df065ed6854') }}</legend><label v-for="scope in scopeOptions" :key="scope" class="check-label"><input v-model="scopes" type="checkbox" :value="scope"/>{{ builtins[scope]??scope }}</label></fieldset>
        <p v-if="scopes.includes('ssh.execute')" class="field-hint">{{ i18nT('m6d38dff05723') }}</p>
        <label class="check-label"><input v-model="allTargets" type="checkbox"/>{{ i18nT('mb2ac6d3ba801') }}</label>
        <fieldset v-if="!allTargets"><legend>{{ i18nT('mca5436d763d3') }}</legend><p v-if="!targetOptions.length">{{ i18nT('m2be14a0d15d5') }}</p><label v-for="target in targetOptions" :key="target.id" class="check-label"><input v-model="targets" type="checkbox" :value="target.id"/>{{ target.name }}</label></fieldset>
        <label>{{ i18nT('m72c5e0e1a870') }}<textarea v-model="paths" rows="3" placeholder="/etc/my-service"/></label>
        <div class="form-actions"><button class="button" type="button" @click="editing=false">{{ i18nT('m2cd0f3be8738') }}</button><button class="button primary" :disabled="busy">{{ i18nT('ma3030bf8f16d') }}</button></div>
      </form>
      <h3>{{ i18nT('m9b54e41c55f1') }}</h3>
      <div class="automation-form"><label>{{ i18nT('md44e9b3d3b31') }}<input v-model="name" maxlength="80"/></label><label>{{ i18nT('md136ed06402c') }}<select v-model="grantId" :aria-label="i18nT('md136ed06402c')"><option v-for="grant in settings.grants" :key="grant.id" :value="grant.id">{{ grant.name }}</option></select></label><button class="button primary" :disabled="busy || !settings.enabled" @click="pair">{{ i18nT('md4034acb102f') }}</button></div>
      <template v-if="config"><p>{{ i18nT('mea47e6a11d3f', { p0: (new Date(expiry).toLocaleTimeString(displayLocale())) }) }}</p><textarea class="automation-config" :value="config" readonly rows="10" :aria-label="i18nT('m17c3ae671aa6')"/><button class="button" @click="copyConfig">{{ i18nT('m6bf7933df3bb') }}</button></template>
      <h3>{{ i18nT('mfa1876770899') }}</h3><p v-if="!settings.clients.filter(c=>!c.revoked).length">{{ i18nT('m0c31d79960c0') }}</p>
      <div v-for="client in settings.clients.filter(c=>!c.revoked)" :key="client.id" class="automation-row"><span>{{ client.name }} <small>{{ settings.grants.find(g=>g.id===client.grantId)?.name }}</small></span><button class="button" :disabled="busy" @click="run(async()=>{await rpc('automation.revoke',{id:client.id},true);await load()})">{{ i18nT('m926a50b98ece') }}</button></div>
      <h3>{{ i18nT('m5253040db864') }}</h3><p v-if="!automationTasks.length">{{ i18nT('mfcbdb54632c4') }}</p><div v-for="task in automationTasks" :key="task.id" class="automation-row"><span>{{ task.name }} <small>{{ task.message }}</small></span><button v-if="task.connected" class="button" :disabled="busy" @click="run(async()=>{await rpc('automation.close',{sessionId:task.sessionId},true)})">{{ i18nT('mc7b24e7997e9') }}</button></div>
      <details><summary>{{ i18nT('m7e1054c8062e', { p0: (settings.tools.length) }) }}</summary><ul><li v-for="tool in settings.tools" :key="tool.name">{{ tool.title }} · {{ tool.provider }}</li></ul></details>
    </template>
  </section>
</template>
<style scoped>
.automation-panel{display:grid;gap:14px}.automation-panel p{margin:0;line-height:1.6}.automation-panel h3{margin:12px 0 0}.automation-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.automation-row small{display:block;opacity:.65}.automation-form{display:grid;gap:12px;padding:16px;border:1px solid var(--border);border-radius:12px}.automation-form label:not(.check-label){display:grid;gap:6px}.automation-form input:not([type=checkbox]),.automation-form select,.automation-form textarea,.automation-config{width:100%;padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--page);color:inherit}.automation-form fieldset{display:grid;gap:8px;border:1px solid var(--border);border-radius:8px}.automation-config{font:12px/1.5 Consolas,monospace;resize:vertical}.automation-panel details{overflow-wrap:anywhere}
</style>
