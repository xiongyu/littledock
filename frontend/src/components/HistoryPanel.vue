<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { rpc } from '../backend'
const props=defineProps<{serverId:string}>()
interface HistorySession {id:string;name:string;started:number;ended:number|null;incomplete:number}
interface HistoryPage {rows:{seq:number;text:string}[];after:number;done:boolean;incomplete:boolean}
const sessions=ref<HistorySession[]>([]),selected=ref(''),search=ref(''),page=ref<HistoryPage>(),error=ref(''),busy=ref(false),captured=ref(0),snapshotId=ref(''),cursors=ref<number[]>([0])
let generation=0
async function open() { const ticket=++generation;busy.value=true;error.value='';page.value=undefined;try {const range=await rpc<{id:string;capturedAt:number}>('history.open',{sessionId:selected.value});if(ticket!==generation)return;snapshotId.value=range.id;captured.value=range.capturedAt;cursors.value=[0];await load(0,ticket)}catch(cause){if(ticket===generation)error.value=cause instanceof Error?cause.message:'无法打开历史。'}finally{if(ticket===generation)busy.value=false} }
async function load(after:number,ticket=++generation){busy.value=true;error.value='';try {const data=await rpc<HistoryPage>('history.page',{snapshotId:snapshotId.value,after,search:search.value});if(ticket===generation)page.value=data}catch(cause){if(ticket===generation)error.value=cause instanceof Error?cause.message:'查询失败。'}finally{if(ticket===generation)busy.value=false} }
function next(){if(!page.value||page.value.done)return;cursors.value.push(page.value.after);if(cursors.value.length>100)cursors.value.shift();void load(page.value.after)}
function previous(){cursors.value.pop();void load(cursors.value.at(-1)??0)}
function find(){cursors.value=[0];void load(0)}
onMounted(async()=>{try{sessions.value=await rpc<HistorySession[]>('history.sessions',{serverId:props.serverId});if(sessions.value[0]){selected.value=sessions.value[0].id;await open()}}catch(cause){error.value=cause instanceof Error?cause.message:'读取失败。'}})
onBeforeUnmount(()=>{generation++;void rpc('history.close').catch(()=>{})})
</script>
<template>
  <div class="history-panel"><p class="field-hint">只显示打开时已保存的输出，刷新才纳入新内容。</p><template v-if="sessions.length"><label class="form-field"><span>会话</span><select v-model="selected" :disabled="busy" @change="open"><option v-for="session in sessions" :key="session.id" :value="session.id">{{ new Date(session.started).toLocaleString() }} · {{ session.ended ? '已结束' : '运行中' }}</option></select></label><form class="history-search" @submit.prevent="find"><input v-model="search" aria-label="搜索历史输出" maxlength="256" placeholder="搜索历史输出" /><button class="button" :disabled="busy">查找</button><button type="button" class="button" :disabled="busy" @click="open">刷新</button></form><p v-if="captured" class="field-hint">固定至 {{ new Date(captured).toLocaleString() }}</p><p v-if="page?.incomplete" class="field-error">部分输出未保存或已清理，以下记录可能不完整。</p><pre class="history-output">{{ page?.rows.map(row => row.text).join('') || (busy ? '读取中…' : page?.done ? '没有记录或匹配结果。' : '本段没有匹配结果，可继续查找下一页。') }}</pre><div class="form-actions"><button class="button" :disabled="busy || cursors.length <= 1" @click="previous">上一页</button><button class="button" :disabled="busy || !page || page.done" @click="next">下一页</button></div></template><p v-else-if="!error">这台服务器还没有已保存的 SSH 输出。</p><p v-if="error" class="field-error" role="alert">{{ error }}</p></div>
</template>
