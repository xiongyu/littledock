<script setup lang="ts">
import { pluginI18n, displayLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.sshInspector')

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { PhCpu, PhArrowClockwise, PhX, PhHardDrives, PhDesktop, PhMemory, PhClock } from '@phosphor-icons/vue'
import type { SshSystemInfo } from '@webnav/shared'
import { connectionState, rpc } from '../backend'
import { formatBytes } from '../workspace-preferences'
const props=defineProps<{sessionId:string;name:string;host:string;ready:boolean}>()
const emit=defineEmits<{close:[]}>()
const info=ref<SshSystemInfo>(),error=ref(''),busy=ref(false)
let generation=0,timer:ReturnType<typeof setTimeout>|undefined
const uptime=computed(()=>{const seconds=info.value?.uptime??0;return seconds>=86400?Math.floor(seconds/86400)+i18nT('m5ab7e0f9b728')+Math.floor(seconds%86400/3600)+i18nT('m8f82ece04f3a'):Math.floor(seconds/3600)+i18nT('mf8af263789a7')+Math.floor(seconds%3600/60)+i18nT('m40de54344d22')})
const sampledTime=computed(()=>info.value?new Date(info.value.sampledAt).toLocaleTimeString(displayLocale(),{hour12:false}):'')
const memoryPercent=computed(()=>info.value?.memoryTotal?Math.round(info.value.memoryUsed/info.value.memoryTotal*100):null)
async function refresh(){
  if(busy.value||!props.ready||connectionState.value!=='ready')return
  clearTimeout(timer);const version=generation,id=props.sessionId;busy.value=true
  try{const result=await rpc<SshSystemInfo>('ssh.system',{sessionId:id});if(version===generation){info.value=result;error.value=''}}
  catch(cause){if(version===generation)error.value=cause instanceof Error?cause.message:i18nT('m5215599023ee')}
  finally{if(version===generation){busy.value=false;if(!error.value)timer=setTimeout(()=>{void refresh()},5000)}}
}
watch(()=>[props.sessionId,props.ready,connectionState.value],()=>{generation++;clearTimeout(timer);info.value=undefined;error.value='';busy.value=false;void refresh()},{immediate:true})
onBeforeUnmount(()=>{generation++;clearTimeout(timer)})
</script>
<template>
  <aside class="ssh-system-panel" :aria-label="i18nT('m3fa4b23d8bce')">
    <header class="inspector-header"><PhCpu :size="16"/><strong>{{ i18nT('m3fa4b23d8bce') }}</strong><button class="icon-button small" :aria-label="i18nT('m21b5706a1c20')" :title="i18nT('maee887434131')" :disabled="busy||!ready||connectionState!=='ready'" @click="refresh"><PhArrowClockwise :size="16"/></button><button class="icon-button small" :aria-label="i18nT('m99a2b18b26db')" :title="i18nT('m99a2b18b26db')" @click="emit('close')"><PhX :size="16"/></button></header>
    <div class="system-panel-body">
      <div class="system-identity">
        <div class="system-host-icon"><PhDesktop :size="23"/><i :class="{connected:ready}" :title="ready?i18nT('m5be0323e8adc'):i18nT('m3d52574ce150')"></i></div>
        <div class="system-host-name"><strong :title="info?.hostname||name">{{ info?.hostname||name }}</strong><code>{{ host }}</code></div>
        <p class="system-platform">{{ info?.platform||'SSH' }}</p>
      </div>
      <p v-if="!ready" class="inspector-state">{{ i18nT('m07f1b2611c59') }}</p><p v-else-if="error" class="inspector-state" role="status">{{ error }}</p><p v-else-if="!info" class="inspector-state">{{ i18nT('mbe500e63e8b3') }}</p>
      <template v-if="info">
        <div class="system-uptime"><PhClock :size="14"/><span>{{ i18nT('m1add43f79816') }}</span><strong>{{ uptime }}</strong></div>
        <section class="system-metric system-cpu" aria-label="CPU">
          <div class="system-metric-heading"><PhCpu :size="17"/><h3>CPU</h3><small>{{ i18nT('m4f86cfd6e0f2', { p0: (info.cpuCount) }) }}</small><strong class="system-metric-value">{{ info.cpuPercent===null?'—':info.cpuPercent.toFixed(1) }}<span v-if="info.cpuPercent!==null">%</span></strong></div>
          <progress :value="info.cpuPercent??0" max="100" :aria-label="i18nT('m1c82e5547854')"/>
          <small v-if="info.cpuPercent===null" class="system-metric-caption">{{ i18nT('m1d0c54153e9b') }}</small>
          <div v-else-if="info.load" class="system-metric-caption"><span>{{ i18nT('mbf480c5da6f5') }}</span><code>{{ info.load }}</code></div>
        </section>
        <section class="system-metric system-memory" :aria-label="i18nT('m7d8f8c37ec78')">
          <div class="system-metric-heading"><PhMemory :size="17"/><h3>{{ i18nT('m7d8f8c37ec78') }}</h3><strong class="system-metric-value">{{ memoryPercent??'—' }}<span v-if="memoryPercent!==null">%</span></strong></div>
          <progress :value="info.memoryUsed" :max="info.memoryTotal||1" :aria-label="i18nT('mace212ad8fd3')"/>
          <div class="system-metric-caption"><span>{{ i18nT('m95a192122756') }}</span><span>{{ formatBytes(info.memoryUsed) }} / {{ formatBytes(info.memoryTotal) }}</span></div>
        </section>
        <section class="system-storage" :aria-label="i18nT('mde7b72a3f852')">
          <h3 class="system-section-label"><PhHardDrives :size="17"/>{{ i18nT('mde7b72a3f852') }}<small>{{ info.disks.length }}</small></h3>
          <div v-for="disk in info.disks" :key="disk.path" class="system-disk">
            <div class="system-disk-heading"><code :title="disk.path">{{ disk.path }}</code><strong>{{ disk.total?Math.round(disk.used/disk.total*100)+'%':'—' }}</strong></div>
            <progress :value="disk.used" :max="disk.total||1" :aria-label="disk.path+i18nT('m0b90f20aef60')"/>
            <div class="system-metric-caption"><span>{{ i18nT('mca5c5ba2b9f5', { p0: (formatBytes(Math.max(0,disk.total-disk.used))) }) }}</span><span>{{ i18nT('mca67782535d9', { p0: (formatBytes(disk.total)) }) }}</span></div>
          </div>
          <p v-if="!info.disks.length" class="system-metric-caption">{{ i18nT('mc188e212e766') }}</p>
        </section>
      </template>
    </div>
    <footer v-if="info" class="system-updated"><i :class="{stale:!!error||!ready}"></i><span>{{ error?i18nT('m89db7bea591f'):i18nT('m0b65c79cc51f')+sampledTime }}</span><span v-if="busy">{{ i18nT('m465c03b272ea') }}</span></footer>
  </aside>
</template>
