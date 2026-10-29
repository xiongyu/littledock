<script setup lang="ts">
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
  <dialog ref="dialog" class="management-dialog split-picker" aria-label="选择第二个 SSH 终端" v-on="backdrop" @cancel.prevent="emit('close')">
    <header><strong>{{ direction === 'horizontal' ? '左右分屏' : '上下分屏' }}</strong><button class="icon-button" aria-label="取消分屏选择" @click="emit('close')"><PhX :size="18" /></button></header>
    <p>选择另一个 SSH 终端</p>
    <button v-for="item in candidates" :key="item.sessionId" class="button" @click="emit('select',item.sessionId)"><PhTerminalWindow :size="18" />{{ item.name }}</button>
    <button class="button" :disabled="busy" @click="emit('create')"><PhPlus :size="18" />新建同一连接</button>
  </dialog>
</template>
