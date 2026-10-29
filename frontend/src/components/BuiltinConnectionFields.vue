<script setup lang="ts">
import { ref } from 'vue'
import { localShells, type Connection } from '@webnav/shared'
import { rpc } from '../backend'
const props=defineProps<{connection:Connection}>()
const emit=defineEmits<{'update:connection':[connection:Connection]}>()
const devices=ref<{serial:string;state:string;model:string}[]>([]),busy=ref(false),error=ref('')
function set(key:string,value:string|number|boolean){emit('update:connection',{...props.connection,pluginSettings:{...props.connection.pluginSettings,[key]:value}})}
async function discover(){busy.value=true;error.value='';try{devices.value=(await rpc<{devices:typeof devices.value}>('plugin.builtin.adb.devices')).devices;if(!devices.value.length)error.value='未发现设备，请连接 USB 并允许 USB 调试。'}catch(cause){error.value=cause instanceof Error?cause.message:'读取设备失败。'}finally{busy.value=false}}
</script>
<template>
  <div class="builtin-connection-fields">
    <template v-if="connection.type==='local'">
      <label class="form-field"><span>本机 Shell</span><select :value="connection.pluginSettings?.shell??'auto'" aria-label="本机 Shell" @change="set('shell',($event.target as HTMLSelectElement).value)"><option v-for="(name,key) in localShells" :key="key" :value="key">{{name}}</option></select></label>
      <label class="form-field"><span>工作目录 <small>可选</small></span><input :value="connection.pluginSettings?.cwd??''" aria-label="本地工作目录" maxlength="2048" placeholder="留空使用当前用户主目录" @input="set('cwd',($event.target as HTMLInputElement).value)"/></label>
      <p class="field-hint">在运行 WebNav 的本机打开终端。Windows 默认 PowerShell，macOS 默认 Zsh，Linux 默认 Bash；未安装时可改选其他 Shell。</p>
    </template>
    <template v-else-if="connection.type==='adb'">
      <label class="form-field"><span>控制模式</span><select :value="connection.pluginSettings?.mode??'scrcpy'" aria-label="ADB 控制模式" @change="set('mode',($event.target as HTMLSelectElement).value)"><option value="scrcpy">增强控制 · scrcpy 高帧率</option><option value="screenshot">基础控制 · ADB 截图</option></select></label>
      <label class="form-field"><span>设备连接</span><select :value="connection.pluginSettings?.transport??'usb'" aria-label="ADB 连接方式" @change="set('transport',($event.target as HTMLSelectElement).value)"><option value="usb">USB / 已连接的设备</option><option value="tcp">网络 ADB（服务器地址与端口）</option></select></label>
      <template v-if="connection.pluginSettings?.transport!=='tcp'">
        <label class="form-field"><span>设备序列号 <small>可选</small></span><input :value="connection.pluginSettings?.serial??''" aria-label="ADB 设备序列号" maxlength="200" placeholder="只有一台已授权设备时自动选择" @input="set('serial',($event.target as HTMLInputElement).value)"/></label>
        <button type="button" class="button" :disabled="busy" @click="discover">{{busy?'正在读取…':'读取本机设备'}}</button>
        <button v-for="device in devices" :key="device.serial" type="button" class="button adb-device-choice" :disabled="device.state!=='device'" @click="set('serial',device.serial)">{{device.model||device.serial}} · {{device.state==='device'?'已授权':device.state==='unauthorized'?'请在手机允许调试':'离线'}}</button>
      </template>
      <label v-if="connection.pluginSettings?.mode==='screenshot'" class="form-field"><span>截图频率</span><select :value="connection.pluginSettings?.fps??2" aria-label="ADB 截图频率" @change="set('fps',Number(($event.target as HTMLSelectElement).value))"><option v-for="fps in [1,2,3,4,5]" :key="fps" :value="fps">{{fps}} 帧 / 秒（上限）</option></select></label>
      <template v-else><label class="form-field"><span>最大帧率</span><select :value="connection.pluginSettings?.maxFps??60" aria-label="scrcpy 最大帧率" @change="set('maxFps',Number(($event.target as HTMLSelectElement).value))"><option v-for="fps in [30,60,90,120]" :key="fps" :value="fps">{{fps}} FPS</option></select></label><label class="form-field"><span>最长边</span><select :value="connection.pluginSettings?.maxSize??1280" aria-label="scrcpy 画面大小" @change="set('maxSize',Number(($event.target as HTMLSelectElement).value))"><option v-for="size in [720,1280,1920,2560]" :key="size" :value="size">{{size}} 像素</option></select></label><label class="form-field"><span>视频码率</span><select :value="connection.pluginSettings?.bitRate??8" aria-label="scrcpy 视频码率" @change="set('bitRate',Number(($event.target as HTMLSelectElement).value))"><option v-for="rate in [2,4,8,12,20]" :key="rate" :value="rate">{{rate}} Mbps</option></select></label></template>
      <p class="field-hint">增强模式自动推送附带的官方 scrcpy server，提供连续视频、触摸拖动和键盘控制，关闭时回收本次服务。需要 Android Platform Tools 和设备调试授权；部分手机还需开启“USB 调试（安全设置）”。无线调试需先完成 adb pair。</p>
      <p v-if="error" class="field-error" role="alert">{{error}}</p>
    </template>
    <template v-else-if="connection.type==='wdb'">
      <label class="check-label"><input type="checkbox" :checked="connection.pluginSettings?.https===true" @change="set('https',($event.target as HTMLInputElement).checked)"/>使用 HTTPS（目标需提供受信任证书）</label>
      <p class="field-hint">连接完整模式的 WDB Agent 网页端口，默认 27880。请填写 WDB 网页管理员，与 Windows / AxisAuto 账号独立。新登录会替换该设备的其他网页登录；初始只查看画面，开启控制后接收键鼠。保留已有 AxisAuto 回连配置。</p>
    </template>
  </div>
</template>
<style scoped>.builtin-connection-fields{display:grid;gap:12px}.adb-device-choice{justify-content:flex-start;text-align:left;overflow-wrap:anywhere}.field-hint{font-size:12px;line-height:1.7;margin:0;color:var(--muted)}</style>
