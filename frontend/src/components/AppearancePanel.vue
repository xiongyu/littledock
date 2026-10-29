<script setup lang="ts">
import { ref } from 'vue'
import { PhCheck, PhImage, PhArrowCounterClockwise, PhTrash } from '@phosphor-icons/vue'
import { skins, scenicBackgrounds } from '../appearance'
import type { BackgroundSide, useAppearance } from '../appearance'
import PluginFontSettings from './PluginFontSettings.vue'

defineProps<{ appearance: ReturnType<typeof useAppearance> }>()
const input = ref<HTMLInputElement>()
const side = ref<BackgroundSide>('right')
function upload(event: Event, appearance: ReturnType<typeof useAppearance>) {
  const target = event.target as HTMLInputElement
  void appearance.setBackground(side.value, target.files?.[0])
  target.value = ''
}
</script>

<template>
  <div class="appearance-panel">
    <p class="panel-intro">给工作台换一种心情。外观会保存在这个浏览器。</p>
    <details class="settings-section"><summary>字体与可读性 · 按插件调整</summary><PluginFontSettings /></details>
    <section class="settings-section">
      <h3>主题皮肤</h3>
      <div class="skin-grid">
        <button v-for="skin in appearance.availableSkins.value" :key="skin.id" :class="['skin-option', { selected: appearance.settings.value.skin === skin.id, 'scenic-skin-option': skin.id === 'mist-lake' }]" :aria-pressed="appearance.settings.value.skin === skin.id" @click="appearance.selectSkin(skin.id)">
          <span class="skin-sample" :style="{ background: skin.background, '--sample-accent': skin.accent }"><img v-if="skin.id === 'mist-lake'" class="scenic-skin-thumbnail" :src="scenicBackgrounds.right" alt="" loading="lazy"/><i></i><span><b></b><b></b><b></b></span><PhCheck v-if="appearance.settings.value.skin === skin.id" :size="17" /></span>
          <strong>{{ skin.name }}</strong><small>{{ skin.description }}</small>
        </button>
      </div>
    </section>
    <section class="settings-section">
      <h3>自定义颜色</h3>
      <label class="color-setting"><span><strong>强调色</strong><small>按钮、选中项和交互反馈</small></span><span class="color-input"><code>{{ appearance.settings.value.accent.toUpperCase() }}</code><input type="color" aria-label="强调色" v-model="appearance.settings.value.accent" /></span></label>
    </section>
    <section class="settings-section">
      <h3>独立背景</h3>
      <div class="segmented background-target" aria-label="选择背景区域"><button :class="{ active: side === 'left' }" :aria-pressed="side === 'left'" @click="side = 'left'">左侧导航栏</button><button :class="{ active: side === 'right' }" :aria-pressed="side === 'right'" @click="side = 'right'">右侧工作区</button></div>
      <label class="color-setting"><span><strong>{{ side === 'left' ? '左侧' : '右侧' }}底色</strong><small>纯色是默认背景</small></span><span class="color-input"><code>{{ appearance.settings.value[side].color.toUpperCase() }}</code><input type="color" :aria-label="`${side === 'left' ? '左侧' : '右侧'}底色`" v-model="appearance.settings.value[side].color" /></span></label>
      <input ref="input" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择背景图片" @change="upload($event, appearance)" />
      <button :class="['image-uploader', { 'has-image': appearance.backgroundImages.value[side] }]" :disabled="appearance.imageBusy.value" @click="input?.click()">
        <img v-if="appearance.backgroundImages.value[side]" :src="appearance.backgroundImages.value[side]" :alt="`${side === 'left' ? '左侧' : '右侧'}背景图片`" />
        <span><PhImage :size="25" /><strong>{{ appearance.imageBusy.value ? '正在保存图片…' : appearance.backgroundImages.value[side] ? '更换背景图片' : '选择一张喜欢的背景' }}</strong><small>JPG / PNG / WebP，最大 5 MB</small></span>
      </button>
      <p v-if="appearance.imageError.value" class="field-error" role="alert">{{ appearance.imageError.value }}</p>
      <template v-if="appearance.backgroundImages.value[side]">
        <button class="button subtle" :disabled="appearance.imageBusy.value" @click="appearance.removeBackground(side)"><PhTrash :size="16" />移除这一侧的图片</button>
      </template>
      <p class="field-hint">两侧分别保存。风景皮肤附带左右背景，也可各自替换；上传图片只保存在本机浏览器。</p>
    </section>
    <p v-if="appearance.storageError.value" class="field-error" role="alert">{{ appearance.storageError.value }}</p>
    <button class="button full-width" :disabled="appearance.imageBusy.value" @click="appearance.reset"><PhArrowCounterClockwise :size="17" />恢复默认外观</button>
  </div>
</template>
