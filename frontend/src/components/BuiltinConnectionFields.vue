<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { ref } from 'vue'
import { localShells, type Connection } from '@webnav/shared'
import { rpc } from '../backend'
const props=defineProps<{connection:Connection}>()
const emit=defineEmits<{'update:connection':[connection:Connection]}>()
const devices=ref<{serial:string;state:string;model:string}[]>([]),busy=ref(false),error=ref('')
function set(key:string,value:string|number|boolean){emit('update:connection',{...props.connection,pluginSettings:{...props.connection.pluginSettings,[key]:value}})}
async function discover(){busy.value=true;error.value='';try{devices.value=(await rpc<{devices:typeof devices.value}>('plugin.builtin.adb.devices')).devices;if(!devices.value.length)error.value=i18nT('m3d7fd611f537')}catch(cause){error.value=cause instanceof Error?cause.message:i18nT('m77b82c832af8')}finally{busy.value=false}}
</script>
<template>
  <div class="builtin-connection-fields">
    <template v-if="connection.type==='local'">
      <label class="form-field"><span>{{ i18nT('m3acb18222ab0') }}</span><select :value="connection.pluginSettings?.shell??'auto'" :aria-label="i18nT('m3acb18222ab0')" @change="set('shell',($event.target as HTMLSelectElement).value)"><option v-for="(name,key) in localShells" :key="key" :value="key">{{name}}</option></select></label>
      <label class="form-field"><span>{{ i18nT('m3db7b06b5f6d') }}<small>{{ i18nT('m537352400c49') }}</small></span><input :value="connection.pluginSettings?.cwd??''" :aria-label="i18nT('m1b902593a3fb')" maxlength="2048" :placeholder="i18nT('m26c0ccf374c8')" @input="set('cwd',($event.target as HTMLInputElement).value)"/></label>
      <p class="field-hint">{{ i18nT('md6afed8f2dfa') }}</p>
    </template>
    <template v-else-if="connection.type==='adb'">
      <label class="form-field"><span>{{ i18nT('mf803a49c79d9') }}</span><select :value="connection.pluginSettings?.mode??'scrcpy'" :aria-label="i18nT('mbca3173bde21')" @change="set('mode',($event.target as HTMLSelectElement).value)"><option value="scrcpy">{{ i18nT('mfe2952fb76ad') }}</option><option value="screenshot">{{ i18nT('m5c8b20b7dd57') }}</option></select></label>
      <label class="form-field"><span>{{ i18nT('ma43615418478') }}</span><select :value="connection.pluginSettings?.transport??'usb'" :aria-label="i18nT('m9aa2ea25e943')" @change="set('transport',($event.target as HTMLSelectElement).value)"><option value="usb">{{ i18nT('mcf20437476ed') }}</option><option value="tcp">{{ i18nT('md64fc362fbc3') }}</option></select></label>
      <template v-if="connection.pluginSettings?.transport!=='tcp'">
        <label class="form-field"><span>{{ i18nT('me9ee6a387057') }}<small>{{ i18nT('m537352400c49') }}</small></span><input :value="connection.pluginSettings?.serial??''" :aria-label="i18nT('mdbe1b33c96a4')" maxlength="200" :placeholder="i18nT('m570d9d0c7726')" @input="set('serial',($event.target as HTMLInputElement).value)"/></label>
        <button type="button" class="button" :disabled="busy" @click="discover">{{busy?i18nT('m86b6d0d63062'):i18nT('mc71af55ee822')}}</button>
        <button v-for="device in devices" :key="device.serial" type="button" class="button adb-device-choice" :disabled="device.state!=='device'" @click="set('serial',device.serial)">{{device.model||device.serial}} · {{device.state==='device'?i18nT('m521e65ffc7d0'):device.state==='unauthorized'?i18nT('m330fbb6ef88f'):i18nT('mbe1b4f3c6c1c')}}</button>
      </template>
      <label v-if="connection.pluginSettings?.mode==='screenshot'" class="form-field"><span>{{ i18nT('m4b6ae3e45f0f') }}</span><select :value="connection.pluginSettings?.fps??2" :aria-label="i18nT('me4336b8677b9')" @change="set('fps',Number(($event.target as HTMLSelectElement).value))"><option v-for="fps in [1,2,3,4,5]" :key="fps" :value="fps">{{ i18nT('m859d1b14da5c', { p0: (fps) }) }}</option></select></label>
      <template v-else><label class="form-field"><span>{{ i18nT('m214dc9705448') }}</span><select :value="connection.pluginSettings?.maxFps??60" :aria-label="i18nT('m3af3a70d10e8')" @change="set('maxFps',Number(($event.target as HTMLSelectElement).value))"><option v-for="fps in [30,60,90,120]" :key="fps" :value="fps">{{fps}} FPS</option></select></label><label class="form-field"><span>{{ i18nT('m929c56279d78') }}</span><select :value="connection.pluginSettings?.maxSize??1280" :aria-label="i18nT('m809616380415')" @change="set('maxSize',Number(($event.target as HTMLSelectElement).value))"><option v-for="size in [720,1280,1920,2560]" :key="size" :value="size">{{ i18nT('m2f4ff0d06227', { p0: (size) }) }}</option></select></label><label class="form-field"><span>{{ i18nT('m01045c06d718') }}</span><select :value="connection.pluginSettings?.bitRate??8" :aria-label="i18nT('md8bd4b50377d')" @change="set('bitRate',Number(($event.target as HTMLSelectElement).value))"><option v-for="rate in [2,4,8,12,20]" :key="rate" :value="rate">{{rate}} Mbps</option></select></label></template>
      <p class="field-hint">{{ i18nT('m473d11ea5622') }}</p>
      <p v-if="error" class="field-error" role="alert">{{error}}</p>
    </template>
    <template v-else-if="connection.type==='wdb'">
      <label class="check-label"><input type="checkbox" :checked="connection.pluginSettings?.https===true" @change="set('https',($event.target as HTMLInputElement).checked)"/>{{ i18nT('mc1525cccb49e') }}</label>
      <p class="field-hint">{{ i18nT('mf8902ec88b59') }}</p>
    </template>
  </div>
</template>
<style scoped>.builtin-connection-fields{display:grid;gap:12px}.adb-device-choice{justify-content:flex-start;text-align:left;overflow-wrap:anywhere}.field-hint{font-size:12px;line-height:1.7;margin:0;color:var(--muted)}</style>
