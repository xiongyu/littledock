<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.terminalHistory')

import { onMounted, onBeforeUnmount, ref } from 'vue'
import { rpc } from '../backend'
const props=defineProps<{serverId:string}>()
interface HistorySession {id:string;name:string;started:number;ended:number|null;incomplete:number}
interface HistoryPage {rows:{seq:number;text:string}[];after:number;done:boolean;incomplete:boolean}
const sessions=ref<HistorySession[]>([]),selected=ref(''),search=ref(''),page=ref<HistoryPage>(),error=ref(''),busy=ref(false),captured=ref(0),snapshotId=ref(''),cursors=ref<number[]>([0])
let generation=0
async function open() { const ticket=++generation;busy.value=true;error.value='';page.value=undefined;try {const range=await rpc<{id:string;capturedAt:number}>('history.open',{sessionId:selected.value});if(ticket!==generation)return;snapshotId.value=range.id;captured.value=range.capturedAt;cursors.value=[0];await load(0,ticket)}catch(cause){if(ticket===generation)error.value=cause instanceof Error?cause.message:i18nT('m78d13342b569')}finally{if(ticket===generation)busy.value=false} }
async function load(after:number,ticket=++generation){busy.value=true;error.value='';try {const data=await rpc<HistoryPage>('history.page',{snapshotId:snapshotId.value,after,search:search.value});if(ticket===generation)page.value=data}catch(cause){if(ticket===generation)error.value=cause instanceof Error?cause.message:i18nT('mab55f6b7bcd4')}finally{if(ticket===generation)busy.value=false} }
function next(){if(!page.value||page.value.done)return;cursors.value.push(page.value.after);if(cursors.value.length>100)cursors.value.shift();void load(page.value.after)}
function previous(){cursors.value.pop();void load(cursors.value.at(-1)??0)}
function find(){cursors.value=[0];void load(0)}
onMounted(async()=>{try{sessions.value=await rpc<HistorySession[]>('history.sessions',{serverId:props.serverId});if(sessions.value[0]){selected.value=sessions.value[0].id;await open()}}catch(cause){error.value=cause instanceof Error?cause.message:i18nT('m5215599023ee')}})
onBeforeUnmount(()=>{generation++;void rpc('history.close').catch(()=>{})})
</script>
<template>
  <div class="history-panel"><p class="field-hint">{{ i18nT('me713c9f1cbae') }}</p><template v-if="sessions.length"><label class="form-field"><span>{{ i18nT('ma63280253f17') }}</span><select v-model="selected" :disabled="busy" @change="open"><option v-for="session in sessions" :key="session.id" :value="session.id">{{ new Date(session.started).toLocaleString(displayLocale()) }} · {{ session.ended ? i18nT('md79b1d0e5c61') : i18nT('m1f0eb99b7ed0') }}</option></select></label><form class="history-search" @submit.prevent="find"><input v-model="search" :aria-label="i18nT('m964a7955e668')" maxlength="256" :placeholder="i18nT('m964a7955e668')" /><button class="button" :disabled="busy">{{ i18nT('m3003318e729a') }}</button><button type="button" class="button" :disabled="busy" @click="open">{{ i18nT('maee887434131') }}</button></form><p v-if="captured" class="field-hint">{{ i18nT('m83a1c8b3daed', { p0: (new Date(captured).toLocaleString(displayLocale())) }) }}</p><p v-if="page?.incomplete" class="field-error">{{ i18nT('m4ba7c9267827') }}</p><pre class="history-output">{{ page?.rows.map(row => row.text).join('') || (busy ? i18nT('m346ff60e6c7c') : page?.done ? i18nT('m0fc37868a28f') : i18nT('mf7187884fa8b')) }}</pre><div class="form-actions"><button class="button" :disabled="busy || cursors.length <= 1" @click="previous">{{ i18nT('mc9b9ae7a6144') }}</button><button class="button" :disabled="busy || !page || page.done" @click="next">{{ i18nT('m8a8542f69648') }}</button></div></template><p v-else-if="!error">{{ i18nT('mbcbad9f60bdf') }}</p><p v-if="error" class="field-error" role="alert">{{ error }}</p></div>
</template>
