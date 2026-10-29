<script setup lang="ts">
import TaskManagerPanel from '../../components/TaskManagerPanel.vue'
import { pluginViews } from '../../plugins'
import { PhGearSix } from '@phosphor-icons/vue'
defineProps<{ active: boolean }>()
defineEmits<{ status: [message: string]; settings: [] }>()
</script>
<template><div class="task-manager-settings-link"><button class="icon-button" aria-label="任务管理器设置" title="任务管理器设置" @click="$emit('settings')"><PhGearSix :size="20" /></button></div><component :is="pluginViews['task-manager'] ?? TaskManagerPanel" :active="active" @status="$emit('status', $event)" /></template>
<style scoped>.task-manager-settings-link{display:flex;justify-content:flex-end;padding:8px 24px 0}</style>
