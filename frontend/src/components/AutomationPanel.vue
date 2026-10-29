<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AutomationGrant } from '@webnav/shared'
import { rpc, servers, automationTasks } from '../backend'
defineEmits<{back:[]}>()
defineProps<{ embedded?: boolean }>()
type Settings={enabled:boolean;clients:{id:string;name:string;grantId:string;revoked:number}[];grants:AutomationGrant[];tools:{name:string;title:string;provider:string;scopes:string[]}[]}
const settings=ref<Settings>(),error=ref(''),busy=ref(false),name=ref('我的 AI'),grantId=ref('read'),config=ref(''),expiry=ref(0)
const editing=ref(false),grantName=ref('SSH 工作'),editId=ref(''),scopes=ref(['catalog.read','plugins.read']),allTargets=ref(false),targets=ref<string[]>([]),paths=ref('/')
const builtins:Record<string,string>={'catalog.read':'读取授权目录','plugins.read':'查看插件能力','ssh.execute':'执行 SSH 命令','system.read':'读取系统信息','files.read':'读取文件','files.write':'修改文件','history.read':'查看任务输出历史','bookmarks.read':'读取网页收藏'}
const scopeOptions=computed(()=>[...new Set([...Object.keys(builtins),...(settings.value?.tools.flatMap(t=>t.scopes)??[])])])
const targetOptions=computed(()=>servers.value.flatMap(s=>s.connections.filter(c=>c.type==='ssh').map(c=>({id:JSON.stringify([s.id,c.id]),name:s.name+' · '+(c.name||'SSH')}))))
async function run(action:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(e){error.value=(e as Error).message}finally{busy.value=false}}
async function load(){settings.value=await rpc<Settings>('automation.settings')}
function edit(grant?:AutomationGrant){editing.value=true;editId.value=grant?.id??'';grantName.value=grant?.name??'SSH 工作';scopes.value=grant?[...grant.scopes]:['catalog.read','plugins.read'];allTargets.value=grant?.targets===null;targets.value=grant?.targets?.map(t=>JSON.stringify(t))??[];paths.value=grant?.paths.join('\n')??'/'}
async function save(){await run(async()=>{await rpc('automation.grant',{...(editId.value?{id:editId.value}:{}),name:grantName.value,scopes:scopes.value,targets:allTargets.value?null:targets.value.map(t=>JSON.parse(t)),paths:paths.value.split('\n').map(s=>s.trim()).filter(Boolean)},true);editing.value=false;await load()})}
async function pair(){await run(async()=>{const p=await rpc<{config:unknown;expiresAt:number}>('automation.pair',{name:name.value,grantId:grantId.value},true);config.value=JSON.stringify(p.config,null,2);expiry.value=p.expiresAt;await load()})}
function copyConfig(){void run(async()=>{await navigator.clipboard.writeText(config.value)})}
onMounted(()=>run(load))
</script>
<template>
  <section class="automation-panel">
    <button v-if="!embedded" class="text-button" @click="$emit('back')">← 全局设置</button>
    <p>每个 AI 接入一次，即可使用工作台已开放的插件能力。多个 AI 可共用授权模板，也可单独撤销。</p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <template v-if="settings">
      <label class="check-label"><input type="checkbox" :checked="settings.enabled" :disabled="busy" @change="run(async()=>{await rpc('automation.enabled',{enabled:!settings!.enabled},true);await load()})"/>启用 MCP 接入</label>
      <h3>授权模板</h3>
      <div v-for="grant in settings.grants" :key="grant.id" class="automation-row"><span>{{ grant.name }} <small>{{ grant.scopes.length }} 项能力</small></span><button class="button" :disabled="busy" @click="edit(grant)">编辑</button></div>
      <button class="button" :disabled="busy" @click="edit()">新增模板</button>
      <form v-if="editing" class="automation-form" @submit.prevent="save">
        <label>模板名称<input v-model="grantName" required maxlength="80"/></label>
        <fieldset><legend>允许的能力</legend><label v-for="scope in scopeOptions" :key="scope" class="check-label"><input v-model="scopes" type="checkbox" :value="scope"/>{{ builtins[scope]??scope }}</label></fieldset>
        <p v-if="scopes.includes('ssh.execute')" class="field-hint">SSH 执行可运行该远端账号有权执行的命令。下方路径范围仅约束文件工具。</p>
        <label class="check-label"><input v-model="allTargets" type="checkbox"/>全部已保存的服务器入口（含以后新增）</label>
        <fieldset v-if="!allTargets"><legend>允许的 SSH 入口</legend><p v-if="!targetOptions.length">尚无 SSH 入口。</p><label v-for="target in targetOptions" :key="target.id" class="check-label"><input v-model="targets" type="checkbox" :value="target.id"/>{{ target.name }}</label></fieldset>
        <label>文件工具允许的绝对路径（每行一条）<textarea v-model="paths" rows="3" placeholder="/etc/my-service"/></label>
        <div class="form-actions"><button class="button" type="button" @click="editing=false">取消</button><button class="button primary" :disabled="busy">保存</button></div>
      </form>
      <h3>接入一个 AI</h3>
      <div class="automation-form"><label>名称<input v-model="name" maxlength="80"/></label><label>授权模板<select v-model="grantId" aria-label="授权模板"><option v-for="grant in settings.grants" :key="grant.id" :value="grant.id">{{ grant.name }}</option></select></label><button class="button primary" :disabled="busy || !settings.enabled" @click="pair">生成 MCP 配置</button></div>
      <template v-if="config"><p>将配置复制到支持本机 stdio 的 AI 客户端。首次连接需在 {{ new Date(expiry).toLocaleTimeString() }} 前完成；配对成功后配置可继续使用。</p><textarea class="automation-config" :value="config" readonly rows="10" aria-label="MCP 配置"/><button class="button" @click="copyConfig">复制配置</button></template>
      <h3>已接入</h3><p v-if="!settings.clients.filter(c=>!c.revoked).length">尚未接入 AI。</p>
      <div v-for="client in settings.clients.filter(c=>!c.revoked)" :key="client.id" class="automation-row"><span>{{ client.name }} <small>{{ settings.grants.find(g=>g.id===client.grantId)?.name }}</small></span><button class="button" :disabled="busy" @click="run(async()=>{await rpc('automation.revoke',{id:client.id},true);await load()})">撤销</button></div>
      <h3>任务</h3><p v-if="!automationTasks.length">AI 发起 SSH 工作后，这里会显示状态，顶部会出现带 AI 标记的终端标签。</p><div v-for="task in automationTasks" :key="task.id" class="automation-row"><span>{{ task.name }} <small>{{ task.message }}</small></span><button v-if="task.connected" class="button" :disabled="busy" @click="run(async()=>{await rpc('automation.close',{sessionId:task.sessionId},true)})">结束</button></div>
      <details><summary>当前工具（{{ settings.tools.length }}）</summary><ul><li v-for="tool in settings.tools" :key="tool.name">{{ tool.title }} · {{ tool.provider }}</li></ul></details>
    </template>
  </section>
</template>
<style scoped>
.automation-panel{display:grid;gap:14px}.automation-panel p{margin:0;line-height:1.6}.automation-panel h3{margin:12px 0 0}.automation-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.automation-row small{display:block;opacity:.65}.automation-form{display:grid;gap:12px;padding:16px;border:1px solid var(--border);border-radius:12px}.automation-form label:not(.check-label){display:grid;gap:6px}.automation-form input:not([type=checkbox]),.automation-form select,.automation-form textarea,.automation-config{width:100%;padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--page);color:inherit}.automation-form fieldset{display:grid;gap:8px;border:1px solid var(--border);border-radius:8px}.automation-config{font:12px/1.5 Consolas,monospace;resize:vertical}.automation-panel details{overflow-wrap:anywhere}
</style>
