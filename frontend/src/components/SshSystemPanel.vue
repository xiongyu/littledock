<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { PhCpu, PhArrowClockwise, PhX, PhHardDrives, PhDesktop, PhMemory, PhClock } from '@phosphor-icons/vue'
import type { SshSystemInfo } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
import { formatBytes } from '../workspace-preferences'
const props=defineProps<{sessionId:string;name:string;host:string;ready:boolean}>()
const emit=defineEmits<{close:[]}>()
const info=ref<SshSystemInfo>(),error=ref(''),busy=ref(false)
let generation=0,timer:ReturnType<typeof setTimeout>|undefined
const uptime=computed(()=>{const seconds=info.value?.uptime??0;return seconds>=86400?Math.floor(seconds/86400)+' 天 '+Math.floor(seconds%86400/3600)+' 小时':Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分钟'})
const sampledTime=computed(()=>info.value?new Date(info.value.sampledAt).toLocaleTimeString('zh-CN',{hour12:false}):'')
const memoryPercent=computed(()=>info.value?.memoryTotal?Math.round(info.value.memoryUsed/info.value.memoryTotal*100):null)
async function refresh(){
  if(busy.value||!props.ready||connectionState.value!=='ready')return
  clearTimeout(timer);const version=generation,id=props.sessionId;busy.value=true
  try{const result=await rpc<SshSystemInfo>('ssh.system',{sessionId:id});if(version===generation){info.value=result;error.value=''}}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:'读取失败。'}
  finally{if(version===generation){busy.value=false;if(!error.value)timer=setTimeout(()=>{void refresh()},5000)}}
}
watch(()=>[props.sessionId,props.ready,connectionState.value],()=>{generation++;clearTimeout(timer);info.value=undefined;error.value='';busy.value=false;void refresh()},{immediate:true})
onBeforeUnmount(()=>{generation++;clearTimeout(timer)})
</script>
<template>
  <aside class="ssh-system-panel" aria-label="系统信息">
    <header class="inspector-header"><PhCpu :size="16"/><strong>系统信息</strong><button class="icon-button small" aria-label="刷新系统信息" title="刷新" :disabled="busy||!ready||connectionState!=='ready'" @click="refresh"><PhArrowClockwise :size="16"/></button><button class="icon-button small" aria-label="关闭系统信息" title="关闭系统信息" @click="emit('close')"><PhX :size="16"/></button></header>
    <div class="system-panel-body">
      <div class="system-identity">
        <div class="system-host-icon"><PhDesktop :size="23"/><i :class="{connected:ready}" :title="ready?'已连接':'未连接'"></i></div>
        <div class="system-host-name"><strong :title="info?.hostname||name">{{ info?.hostname||name }}</strong><code>{{ host }}</code></div>
        <p class="system-platform">{{ info?.platform||'SSH' }}</p>
      </div>
      <p v-if="!ready" class="inspector-state">等待 SSH 连接就绪</p><p v-else-if="error" class="inspector-state" role="status">{{ error }}</p><p v-else-if="!info" class="inspector-state">正在读取系统信息…</p>
      <template v-if="info">
        <div class="system-uptime"><PhClock :size="14"/><span>已运行</span><strong>{{ uptime }}</strong></div>
        <section class="system-metric system-cpu" aria-label="CPU">
          <div class="system-metric-heading"><PhCpu :size="17"/><h3>CPU</h3><small>{{ info.cpuCount }} 核</small><strong class="system-metric-value">{{ info.cpuPercent===null?'—':info.cpuPercent.toFixed(1) }}<span v-if="info.cpuPercent!==null">%</span></strong></div>
          <progress :value="info.cpuPercent??0" max="100" aria-label="CPU 使用率"/>
          <small v-if="info.cpuPercent===null" class="system-metric-caption">正在采样</small>
          <div v-else-if="info.load" class="system-metric-caption"><span>平均负载</span><code>{{ info.load }}</code></div>
        </section>
        <section class="system-metric system-memory" aria-label="内存">
          <div class="system-metric-heading"><PhMemory :size="17"/><h3>内存</h3><strong class="system-metric-value">{{ memoryPercent??'—' }}<span v-if="memoryPercent!==null">%</span></strong></div>
          <progress :value="info.memoryUsed" :max="info.memoryTotal||1" aria-label="内存使用率"/>
          <div class="system-metric-caption"><span>已用 / 总量</span><span>{{ formatBytes(info.memoryUsed) }} / {{ formatBytes(info.memoryTotal) }}</span></div>
        </section>
        <section class="system-storage" aria-label="磁盘">
          <h3 class="system-section-label"><PhHardDrives :size="17"/>磁盘 <small>{{ info.disks.length }}</small></h3>
          <div v-for="disk in info.disks" :key="disk.path" class="system-disk">
            <div class="system-disk-heading"><code :title="disk.path">{{ disk.path }}</code><strong>{{ disk.total?Math.round(disk.used/disk.total*100)+'%':'—' }}</strong></div>
            <progress :value="disk.used" :max="disk.total||1" :aria-label="disk.path+' 使用率'"/>
            <div class="system-metric-caption"><span>可用 {{ formatBytes(Math.max(0,disk.total-disk.used)) }}</span><span>共 {{ formatBytes(disk.total) }}</span></div>
          </div>
          <p v-if="!info.disks.length" class="system-metric-caption">未提供磁盘信息</p>
        </section>
      </template>
    </div>
    <footer v-if="info" class="system-updated"><i :class="{stale:!!error||!ready}"></i><span>{{ error?'更新暂停':'更新于 '+sampledTime }}</span><span v-if="busy">读取中</span></footer>
  </aside>
</template>
