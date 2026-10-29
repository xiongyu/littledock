<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.sessions')

import { onMounted, ref } from 'vue'
import { PhPlus, PhTerminalWindow, PhX } from '@phosphor-icons/vue'
import { createBackdropGuard } from '../dialog-backdrop'
defineProps<{ direction: 'horizontal' | 'vertical'; candidates: readonly { sessionId: string; name: string }[]; busy: boolean }>()
const emit = defineEmits<{ close: []; select: [id: string]; create: [] }>()
const dialog = ref<HTMLDialogElement>()
const backdrop = createBackdropGuard(() => emit('close'))
onMounted(() => dialog.value?.showModal())
</script>
<template>
  <dialog ref="dialog" class="management-dialog split-picker" :aria-label="i18nT('mb26cd03be2d7')" v-on="backdrop" @cancel.prevent="emit('close')">
    <header><strong>{{ direction === 'horizontal' ? i18nT('m62ed1b06404f') : i18nT('m3d63360a3d6e') }}</strong><button class="icon-button" :aria-label="i18nT('mda75d1946794')" @click="emit('close')"><PhX :size="18" /></button></header>
    <p>{{ i18nT('m0a4408da179d') }}</p>
    <button v-for="item in candidates" :key="item.sessionId" class="button" @click="emit('select',item.sessionId)"><PhTerminalWindow :size="18" />{{ item.name }}</button>
    <button class="button" :disabled="busy" @click="emit('create')"><PhPlus :size="18" />{{ i18nT('m64eae3fb5c26') }}</button>
  </dialog>
</template>
