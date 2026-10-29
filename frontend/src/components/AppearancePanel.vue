<script setup lang="ts">
import { pluginI18n, currentLocale, localeChoices, setLocale } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.appearance')

import { ref } from 'vue'
import BackgroundMedia from './BackgroundMedia.vue'
import { PhCheck, PhImage, PhArrowCounterClockwise, PhTrash } from '@phosphor-icons/vue'
import { scenicBackgroundFor } from '../appearance'
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
    <section class="settings-section">
      <label class="form-field"><span>{{ i18nT('language.label') }}</span><select :aria-label="i18nT('language.label')" :value="currentLocale" @change="setLocale(($event.target as HTMLSelectElement).value)"><option v-for="locale in localeChoices" :key="locale.id" :value="locale.id">{{ locale.label }}</option></select></label>
      <p class="field-hint">{{ i18nT('language.description') }}</p>
    </section>
    <p class="panel-intro">{{ i18nT('m70dcc2728c86') }}</p>
    <details class="settings-section"><summary>{{ i18nT('m3eea9e8cc4d7') }}</summary><PluginFontSettings /></details>
    <section class="settings-section">
      <h3>{{ i18nT('mbf36f5473314') }}</h3>
      <div class="skin-grid">
        <button v-for="skin in appearance.availableSkins.value" :key="skin.id" :class="['skin-option', { selected: appearance.settings.value.skin === skin.id, 'scenic-skin-option': !!scenicBackgroundFor(skin.id) }]" :aria-pressed="appearance.settings.value.skin === skin.id" @click="appearance.selectSkin(skin.id)">
          <span class="skin-sample" :style="{ background: skin.background, '--sample-accent': skin.accent }"><img v-if="scenicBackgroundFor(skin.id)" class="scenic-skin-thumbnail" :src="scenicBackgroundFor(skin.id)?.right" alt="" loading="lazy"/><i></i><span><b></b><b></b><b></b></span><PhCheck v-if="appearance.settings.value.skin === skin.id" :size="17" /></span>
          <strong>{{ skin.name }}</strong><small>{{ skin.description }}</small>
        </button>
      </div>
    </section>
    <section class="settings-section">
      <h3>{{ i18nT('m781b07fdcb56') }}</h3>
      <label class="color-setting"><span><strong>{{ i18nT('mf84e05423960') }}</strong><small>{{ i18nT('m4737fbb7af94') }}</small></span><span class="color-input"><code>{{ appearance.settings.value.accent.toUpperCase() }}</code><input type="color" :aria-label="i18nT('mf84e05423960')" v-model="appearance.settings.value.accent" /></span></label>
    </section>
    <section class="settings-section">
      <h3>{{ i18nT('ma013f337e8e0') }}</h3>
      <div class="segmented background-target" :aria-label="i18nT('m1dbca945c32d')"><button :class="{ active: side === 'left' }" :aria-pressed="side === 'left'" @click="side = 'left'">{{ i18nT('m457e846cfae1') }}</button><button :class="{ active: side === 'right' }" :aria-pressed="side === 'right'" @click="side = 'right'">{{ i18nT('md57fe9357c83') }}</button></div>
      <label class="color-setting"><span><strong>{{ i18nT('m42db87c0a960', { p0: (side === 'left' ? i18nT('m6a24b14f33c7') : i18nT('m1cf1d4d0b24b')) }) }}</strong><small>{{ i18nT('m1592bcc824d1') }}</small></span><span class="color-input"><code>{{ appearance.settings.value[side].color.toUpperCase() }}</code><input type="color" :aria-label="i18nT('m42db87c0a960', { p0: (side === 'left' ? i18nT('m6a24b14f33c7') : i18nT('m1cf1d4d0b24b')) })" v-model="appearance.settings.value[side].color" /></span></label>
      <input ref="input" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" :aria-label="i18nT('m1a250edaa622')" @change="upload($event, appearance)" />
      <button :class="['image-uploader', { 'has-image': appearance.backgroundMedia.value[side] }]" :disabled="appearance.imageBusy.value" @click="input?.click()">
        <BackgroundMedia v-if="appearance.backgroundMedia.value[side]" :media="appearance.backgroundMedia.value[side]!" preview />
        <span><PhImage :size="25" /><strong>{{ appearance.imageBusy.value ? i18nT('m9d2e3d5ad46b') : appearance.backgroundMedia.value[side] ? i18nT('ma0e8be24d19d') : i18nT('mb8507fcb580d') }}</strong><small>{{ i18nT('m2b5c59b34e25') }}</small></span>
      </button>
      <p v-if="appearance.imageError.value" class="field-error" role="alert">{{ appearance.imageError.value }}</p>
      <template v-if="appearance.backgroundMedia.value[side]">
        <button class="button subtle" :disabled="appearance.imageBusy.value" @click="appearance.removeBackground(side)"><PhTrash :size="16" />{{ i18nT('m3a411d2b3aca') }}</button>
      </template>
      <p class="field-hint">{{ i18nT('m64b312940405') }}</p>
    </section>
    <p v-if="appearance.storageError.value" class="field-error" role="alert">{{ appearance.storageError.value }}</p>
    <button class="button full-width" :disabled="appearance.imageBusy.value" @click="appearance.reset"><PhArrowCounterClockwise :size="17" />{{ i18nT('m1ffb176f0f75') }}</button>
  </div>
</template>
