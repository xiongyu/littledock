<script setup lang="ts">
const { t: i18nT } = pluginI18n('core')

import * as vue from 'vue'
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type Component } from 'vue'
import { PhGearSix, PhFloppyDisk, PhArrowClockwise } from '@phosphor-icons/vue'
import type { PluginField, PluginFontInfo, PluginState } from '@webnav/shared'
import { rpc, connectionState } from '../backend'
import { pluginState } from '../plugins'
import { pluginDeadline } from '../plugin-lifecycle'
import { pluginSettingsViews } from '../plugin-settings-registry'
import { createPluginFontScope } from '../plugin-fonts'
import { pluginCloseGuards } from '../plugin-workspace'
import PluginFontSettings from './PluginFontSettings.vue'
import { pluginI18n, cachePluginLocales, pluginText } from '../i18n.ts'

const props = defineProps<{ pluginId: string; section?: string; active: boolean }>()
interface SettingsSnapshot { id: string; name: string; commit: string; installedCommit: string; revision: number; builtin: boolean; running: boolean; enabled: boolean; safeMode: boolean; fields: PluginField[]; fonts: PluginFontInfo[]; config: Record<string, string | number | boolean>; entry?: string; styles: string[]; pending?: { reason: string } }
const snapshot = shallowRef<SettingsSnapshot>(), customPage = shallowRef<Component>()
const draft = reactive<Record<string, string | number | boolean>>({}), baseline = ref(''), error = ref(''), notice = ref(''), loading = ref(true), saving = ref(false)
const section = ref(props.section ?? 'general'), externalDirty = ref(false)
const saveBlocked = ref(false)
const dirty = computed(() => externalDirty.value || (!!snapshot.value && JSON.stringify(draft) !== baseline.value))
const canSave = computed(() => !!snapshot.value && !snapshot.value.builtin && snapshot.value.commit === snapshot.value.installedCommit && connectionState.value === 'ready' && dirty.value && !saving.value && !saveBlocked.value)
const closeDialog = ref<HTMLDialogElement>(); let decideClose: ((value: boolean) => void) | undefined
let disposed = false, generation = 0, closePromise: Promise<boolean> | undefined, cleanups: (() => unknown | Promise<unknown>)[] = [], fontScope: ReturnType<typeof createPluginFontScope> | undefined
const tabKey = `plugin-settings:${props.pluginId}`
watch(() => props.section, value => { if (value) section.value = value })
async function release() {
  const previous = cleanups.splice(0); fontScope?.dispose(); fontScope = undefined
  try { await pluginDeadline(Promise.allSettled(previous.map(async fn => fn())), 5000, i18nT('m1b9e2890db74')) } catch { /* Closing the view must not hold the host queue. */ }
}
async function load() {
  const token = ++generation; loading.value = true; error.value = ''; customPage.value = undefined
  await release()
  try {
    const result = await rpc<SettingsSnapshot>('plugins.settings', { id: props.pluginId })
    if (disposed || token !== generation) return
    const bundle = await rpc('plugins.locales', { id: result.id, commit: result.commit })
    if (disposed || token !== generation) return
    if (bundle && !result.builtin) cachePluginLocales(result.id, result.commit, bundle)
    snapshot.value = result; saveBlocked.value = false; for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, result.config); baseline.value = JSON.stringify(draft); externalDirty.value = false
    fontScope = createPluginFontScope(result.id, result.name); for (const font of result.fonts) fontScope.registerFontInfo(font); fontScope.commit()
    if (result.commit !== result.installedCommit) notice.value = i18nT('m786368a86a1e')
    else notice.value = result.pending?.reason ?? (!result.enabled ? i18nT('m24afb89288c5') : '')
    if (result.builtin) customPage.value = pluginSettingsViews[props.pluginId]
    else if (result.entry && !result.safeMode) {
      let accepting = true, live = true
      cleanups.push(() => { live = false })
      const requireLive = () => { if (!live || disposed || token !== generation) throw new Error(i18nT('m3bdbcdcdfdb5')) }
      const scopedDraft = new Proxy(draft, { set: (target, key, value) => { requireLive(); return Reflect.set(target, key, value) }, deleteProperty: (target, key) => { requireLive(); return Reflect.deleteProperty(target, key) } })
      const requireOpen = () => { if (!accepting || disposed || token !== generation) throw new Error(i18nT('m4be5635885c3')) }
      try {
        await pluginDeadline((async () => {
          const module: unknown = await import(/* @vite-ignore */ result.entry!)
          requireOpen()
          const activate = (module as { activate?: unknown }).activate
          if (typeof activate !== 'function') throw new Error(i18nT('m07e5613fdd54'))
          await activate({ apiVersion: 1, vue, i18n: pluginI18n(result.id), hostState: vue.readonly(connectionState), config: scopedDraft,
            registerSettingsPage: (id: string, definition: { component: Component }) => { requireOpen(); if (id !== 'main' || customPage.value || !definition.component) throw new Error(i18nT('m37eeea7f11cb')); customPage.value = markRaw(definition.component) },
            registerFontInfo: (font: PluginFontInfo) => { requireOpen(); return fontScope!.registerFontInfo(font) }, getFontInfo: (flag: string) => { requireLive(); return fontScope!.getFontInfo(flag) },
            onDispose: (cleanup: () => unknown) => { requireOpen(); if (typeof cleanup !== 'function') throw new Error(i18nT('m919ea184d5be')); cleanups.push(cleanup) },
            setDirty: (value: boolean) => { if (live && !disposed && token === generation) externalDirty.value = value === true },
            rpc: (name: string, params: Record<string, unknown> = {}, mutate = false) => { if (!live || disposed || token !== generation || !result.running) return Promise.reject(new Error(i18nT('mc1b32489be7b'))); return rpc(`plugin.${result.id}.${name}`, params, mutate) },
          })
          requireOpen(); if (!customPage.value) throw new Error(i18nT('m7d01f91b58a5'))
          for (const href of result.styles) {
            await new Promise<void>((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.onload = () => resolve(); link.onerror = () => reject(new Error(i18nT('m1913f121eb47'))); cleanups.push(() => link.remove()); document.head.append(link) })
          }
        })(), 15000, i18nT('mb9d24ce97eea'))
      } catch (cause) { live = false; customPage.value = undefined; error.value = cause instanceof Error ? cause.message : i18nT('m907805b672e6') }
      finally { accepting = false }
    }
  } catch (cause) { if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : i18nT('mea09308fc147') }
  finally { if (!disposed && token === generation) loading.value = false }
}
async function save() {
  if (!canSave.value || !snapshot.value) return false
  saving.value = true; error.value = ''; const original = JSON.stringify(draft), current = snapshot.value
  try {
    const state = await rpc<PluginState>('plugins.change', { id: props.pluginId, action: 'configure', expectedRevision: current.revision, expectedCommit: current.commit, config: { ...draft } }, true)
    if (disposed) return false
    pluginState.value = state; baseline.value = original; externalDirty.value = false; snapshot.value = { ...current, revision: state.revision }
    notice.value = state.pending.find(item => item.id === props.pluginId)?.reason ?? (state.installed.find(p => p.manifest.id === props.pluginId)?.running ? i18nT('m16f9ea9b6c5f') : i18nT('m003d6b5d51ed'))
    return true
  } catch (cause) { if (!disposed) { saveBlocked.value = true; error.value = (cause instanceof Error ? cause.message : i18nT('mcf1487e7aa89')) + i18nT('md9eb25669484') } return false }
  finally { saving.value = false }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
function finishClose(value: boolean) { closeDialog.value?.close(); decideClose?.(value); decideClose = undefined; closePromise = undefined }
async function saveAndClose() { if (await save()) finishClose(true) }
async function reload() { if (!dirty.value || await guard()) await load() }
function guard(): Promise<boolean> { if (!dirty.value) return Promise.resolve(true); if (closePromise) return closePromise; closeDialog.value?.showModal(); return closePromise = new Promise(resolve => { decideClose = resolve }) }
onMounted(() => { pluginCloseGuards.set(tabKey, guard); window.addEventListener('beforeunload', beforeUnload); void load() })
onBeforeUnmount(() => { disposed = true; generation++; decideClose?.(false); pluginCloseGuards.delete(tabKey); window.removeEventListener('beforeunload', beforeUnload); for (const key of Object.keys(draft)) delete draft[key]; void release() })
</script>
<template>
  <div class="plugin-settings-page">
    <header class="plugin-settings-heading"><div><span>{{ i18nT('mb1bc554af446') }}</span><h1><PhGearSix :size="24" />{{ snapshot ? pluginText(pluginId, 'metadata.name', snapshot.name) : i18nT('m9e23e40b8220') }}</h1></div><button class="icon-button" :title="i18nT('m5d3bf702b137')" :aria-label="i18nT('m0e14b35ae986')" :disabled="loading || saving" @click="reload"><PhArrowClockwise :size="20" /></button></header>
    <p v-if="notice" class="plugin-settings-notice" role="status">{{ notice }}</p><p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">{{ i18nT('m69ede7ee4172') }}</p>
    <template v-else-if="snapshot">
      <nav class="segmented" :aria-label="i18nT('m25a8066a412a')"><button :class="{active:section !== 'fonts'}" @click="section = 'general'">{{ i18nT('m06bbbecb67da') }}</button><button :class="{active:section === 'fonts'}" @click="section = 'fonts'">{{ i18nT('ma422a12c5159') }}</button></nav>
      <PluginFontSettings v-if="section === 'fonts'" :plugin-id="pluginId" />
      <section v-else class="plugin-settings-card"><header><h2>{{ i18nT('ma9ea0d81d268', { p0: pluginText(pluginId, 'metadata.name', snapshot.name) }) }}</h2></header><div class="plugin-settings-body">
        <component v-if="customPage" :is="customPage" :embedded="true" :config="draft" :section="section" :active="active" />
        <template v-else><label v-for="field in snapshot.fields" :key="field.key" class="form-field"><span>{{ pluginText(pluginId, `configFields.${field.key}.label`, field.label) }}</span><input v-if="field.type === 'boolean'" type="checkbox" :checked="draft[field.key] === true" @change="draft[field.key] = ($event.target as HTMLInputElement).checked" /><input v-else :type="field.type === 'number' ? 'number' : 'text'" :value="draft[field.key]" :required="field.required" maxlength="4096" @input="draft[field.key] = field.type === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value" /></label><p v-if="!snapshot.fields.length" class="field-hint">{{ i18nT('mcb3845d75e70') }}</p></template>
      </div><footer v-if="snapshot.fields.length"><span>{{ dirty ? i18nT('mc2277872cdce') : i18nT('m74c6a32565e5') }}</span><button class="button primary" :disabled="!canSave" @click="save"><PhFloppyDisk :size="18" />{{ saving ? i18nT('m6bdb4435095e') : i18nT('m6e584e3d5ce6') }}</button></footer></section>
    </template>
    <dialog ref="closeDialog" @cancel.prevent="finishClose(false)"><h2>{{ i18nT('m84d6bc820a4f') }}</h2><p>{{ i18nT('md3313b5ccbb3') }}</p><div class="settings-close-actions"><button class="button" @click="finishClose(false)">{{ i18nT('mfd4b9e3b6c68') }}</button><button class="button" @click="finishClose(true)">{{ i18nT('m9b7824cefa1e') }}</button><button class="button primary" :disabled="!canSave" @click="saveAndClose">{{ i18nT('med8bcd6d9ed6') }}</button></div></dialog>
  </div>
</template>
<style scoped>
.plugin-settings-page{max-width:1120px;margin:auto;padding:28px;font-size:var(--font-body)}.plugin-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.plugin-settings-heading span{color:var(--muted);font-size:var(--font-caption)}.plugin-settings-heading h1{display:flex;align-items:center;gap:12px;font-size:var(--font-heading);margin:8px 0}.plugin-settings-card{border:1px solid var(--border);border-radius:16px;margin-top:20px;overflow:hidden;background:var(--surface)}.plugin-settings-card>header{padding:18px 22px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.plugin-settings-card h2{margin:0;font-size:var(--font-heading)}.plugin-settings-body{padding:22px;display:grid;gap:18px}.plugin-settings-card footer{padding:16px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px}.plugin-settings-card footer span,.plugin-settings-notice{font-size:var(--font-caption);color:var(--muted)}.settings-close-actions{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:600px){.plugin-settings-page{padding:16px}.plugin-settings-card>header,.plugin-settings-body,.plugin-settings-card footer{padding:16px}}
</style>
