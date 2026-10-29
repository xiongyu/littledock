<script setup lang="ts">
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
  try { await pluginDeadline(Promise.allSettled(previous.map(async fn => fn())), 5000, '设置清理超时。') } catch { /* Closing the view must not hold the host queue. */ }
}
async function load() {
  const token = ++generation; loading.value = true; error.value = ''; customPage.value = undefined
  await release()
  try {
    const result = await rpc<SettingsSnapshot>('plugins.settings', { id: props.pluginId })
    if (disposed || token !== generation) return
    snapshot.value = result; saveBlocked.value = false; for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, result.config); baseline.value = JSON.stringify(draft); externalDirty.value = false
    fontScope = createPluginFontScope(result.id, result.name); for (const font of result.fonts) fontScope.registerFontInfo(font); fontScope.commit()
    if (result.commit !== result.installedCommit) notice.value = '当前运行版本与已安装版本不同；请先完成版本切换，再保存业务配置。'
    else notice.value = result.pending?.reason ?? (!result.enabled ? '插件已停用。保存配置不会启用插件。' : '')
    if (result.builtin) customPage.value = pluginSettingsViews[props.pluginId]
    else if (result.entry && !result.safeMode) {
      let accepting = true, live = true
      cleanups.push(() => { live = false })
      const requireLive = () => { if (!live || disposed || token !== generation) throw new Error('设置页面已经关闭。') }
      const scopedDraft = new Proxy(draft, { set: (target, key, value) => { requireLive(); return Reflect.set(target, key, value) }, deleteProperty: (target, key) => { requireLive(); return Reflect.deleteProperty(target, key) } })
      const requireOpen = () => { if (!accepting || disposed || token !== generation) throw new Error('设置注册作用域已经关闭。') }
      try {
        await pluginDeadline((async () => {
          const module: unknown = await import(/* @vite-ignore */ result.entry!)
          requireOpen()
          const activate = (module as { activate?: unknown }).activate
          if (typeof activate !== 'function') throw new Error('设置入口未导出 activate。')
          await activate({ apiVersion: 1, vue, hostState: vue.readonly(connectionState), config: scopedDraft,
            registerSettingsPage: (id: string, definition: { component: Component }) => { requireOpen(); if (id !== 'main' || customPage.value || !definition.component) throw new Error('设置注册无效。'); customPage.value = markRaw(definition.component) },
            registerFontInfo: (font: PluginFontInfo) => { requireOpen(); return fontScope!.registerFontInfo(font) }, getFontInfo: (flag: string) => { requireLive(); return fontScope!.getFontInfo(flag) },
            onDispose: (cleanup: () => unknown) => { requireOpen(); if (typeof cleanup !== 'function') throw new Error('清理方法无效。'); cleanups.push(cleanup) },
            setDirty: (value: boolean) => { if (live && !disposed && token === generation) externalDirty.value = value === true },
            rpc: (name: string, params: Record<string, unknown> = {}, mutate = false) => { if (!live || disposed || token !== generation || !result.running) return Promise.reject(new Error('插件业务尚未运行。')); return rpc(`plugin.${result.id}.${name}`, params, mutate) },
          })
          requireOpen(); if (!customPage.value) throw new Error('设置入口没有注册页面。')
          for (const href of result.styles) {
            await new Promise<void>((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.onload = () => resolve(); link.onerror = () => reject(new Error('设置样式加载失败。')); cleanups.push(() => link.remove()); document.head.append(link) })
          }
        })(), 15000, '设置页面加载超时，可继续使用基础配置。')
      } catch (cause) { live = false; customPage.value = undefined; error.value = cause instanceof Error ? cause.message : '自定义设置加载失败。' }
      finally { accepting = false }
    }
  } catch (cause) { if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : '配置读取失败。' }
  finally { if (!disposed && token === generation) loading.value = false }
}
async function save() {
  if (!canSave.value || !snapshot.value) return false
  saving.value = true; error.value = ''; const original = JSON.stringify(draft), current = snapshot.value
  try {
    const state = await rpc<PluginState>('plugins.change', { id: props.pluginId, action: 'configure', expectedRevision: current.revision, expectedCommit: current.commit, config: { ...draft } }, true)
    if (disposed) return false
    pluginState.value = state; baseline.value = original; externalDirty.value = false; snapshot.value = { ...current, revision: state.revision }
    notice.value = state.pending.find(item => item.id === props.pluginId)?.reason ?? (state.installed.find(p => p.manifest.id === props.pluginId)?.running ? '配置已保存并生效。' : '配置已保存；插件保持停用。')
    return true
  } catch (cause) { if (!disposed) { saveBlocked.value = true; error.value = (cause instanceof Error ? cause.message : '保存失败。') + ' 请重新读取配置核对后再保存。' } return false }
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
    <header class="plugin-settings-heading"><div><span>插件设置</span><h1><PhGearSix :size="24" />{{ snapshot?.name ?? '正在读取插件…' }}</h1></div><button class="icon-button" title="重新读取配置" aria-label="重新读取插件配置" :disabled="loading || saving" @click="reload"><PhArrowClockwise :size="20" /></button></header>
    <p v-if="notice" class="plugin-settings-notice" role="status">{{ notice }}</p><p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在加载设置…</p>
    <template v-else-if="snapshot">
      <nav class="segmented" aria-label="插件设置分组"><button :class="{active:section !== 'fonts'}" @click="section = 'general'">功能设置</button><button :class="{active:section === 'fonts'}" @click="section = 'fonts'">字体与外观</button></nav>
      <PluginFontSettings v-if="section === 'fonts'" :plugin-id="pluginId" />
      <section v-else class="plugin-settings-card"><header><h2>{{ snapshot.name }} · 功能设置</h2></header><div class="plugin-settings-body">
        <component v-if="customPage" :is="customPage" :embedded="true" :config="draft" :section="section" :active="active" />
        <template v-else><label v-for="field in snapshot.fields" :key="field.key" class="form-field"><span>{{ field.label }}</span><input v-if="field.type === 'boolean'" type="checkbox" :checked="draft[field.key] === true" @change="draft[field.key] = ($event.target as HTMLInputElement).checked" /><input v-else :type="field.type === 'number' ? 'number' : 'text'" :value="draft[field.key]" :required="field.required" maxlength="4096" @input="draft[field.key] = field.type === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value" /></label><p v-if="!snapshot.fields.length" class="field-hint">此插件没有独立的功能配置项。</p></template>
      </div><footer v-if="snapshot.fields.length"><span>{{ dirty ? '有未保存的修改' : '配置已同步' }}</span><button class="button primary" :disabled="!canSave" @click="save"><PhFloppyDisk :size="18" />{{ saving ? '正在保存…' : '保存配置' }}</button></footer></section>
    </template>
    <dialog ref="closeDialog" @cancel.prevent="finishClose(false)"><h2>保留修改？</h2><p>当前插件设置尚未保存。</p><div class="settings-close-actions"><button class="button" @click="finishClose(false)">继续编辑</button><button class="button" @click="finishClose(true)">放弃修改</button><button class="button primary" :disabled="!canSave" @click="saveAndClose">保存并关闭</button></div></dialog>
  </div>
</template>
<style scoped>
.plugin-settings-page{max-width:1120px;margin:auto;padding:28px;font-size:var(--font-body)}.plugin-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}.plugin-settings-heading span{color:var(--muted);font-size:var(--font-caption)}.plugin-settings-heading h1{display:flex;align-items:center;gap:12px;font-size:var(--font-heading);margin:8px 0}.plugin-settings-card{border:1px solid var(--border);border-radius:16px;margin-top:20px;overflow:hidden;background:var(--surface)}.plugin-settings-card>header{padding:18px 22px;background:color-mix(in srgb,var(--accent) 12%,var(--surface))}.plugin-settings-card h2{margin:0;font-size:var(--font-heading)}.plugin-settings-body{padding:22px;display:grid;gap:18px}.plugin-settings-card footer{padding:16px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px}.plugin-settings-card footer span,.plugin-settings-notice{font-size:var(--font-caption);color:var(--muted)}.settings-close-actions{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:600px){.plugin-settings-page{padding:16px}.plugin-settings-card>header,.plugin-settings-body,.plugin-settings-card footer{padding:16px}}
</style>
