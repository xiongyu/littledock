<script setup lang="ts">
import { PhDesktop, PhGlobeHemisphereWest, PhPencilSimple, PhStar, PhTerminalWindow, PhHardDrives } from '@phosphor-icons/vue'
import SessionPreview from './SessionPreview.vue'
import type { Connection, Server } from '../catalog'
import type { PreviewFrame, PreviewSession } from '../session-preview'

defineProps<{ server: Server; groupName: string; card?: boolean; previewSessions?: readonly PreviewSession[]; lastFrame?: PreviewFrame }>()
defineEmits<{ favorite: [id: string]; connect: [server: Server, connection: Connection]; edit: [server: Server] }>()
</script>

<template>
  <article :class="['server-item', { 'server-card': card }]" :aria-label="server.name">
    <div class="server-identity">
      <span class="server-symbol"><PhDesktop v-if="server.connections.some(c => c.type === 'rdp')" :size="23" /><PhHardDrives v-else :size="23" /></span>
      <div class="server-description"><h3 :title="server.name">{{ server.name }}</h3><span class="server-address" :title="server.host">{{ server.host }}</span><span v-if="card" class="card-group" :title="groupName">{{ groupName }}</span></div>
    </div>
    <span v-if="!card" class="row-group">{{ groupName }}</span>
    <div class="connection-actions">
      <button v-for="connection in server.connections" :key="connection.id" class="protocol-button" @click="$emit('connect', server, connection)" :aria-label="`${server.name} ${connection.name}`" :title="`${connection.name} · ${connection.port}`">
        <PhTerminalWindow v-if="connection.type === 'ssh'" :size="18" /><PhDesktop v-else-if="connection.type === 'rdp'" :size="18" /><PhGlobeHemisphereWest v-else :size="18" />
        <span class="visually-hidden">{{ connection.name }}</span>
      </button>
    </div>
    <div :class="card ? 'card-preview' : 'row-actions'">
      <SessionPreview v-if="card" :server-name="server.name" :sessions="previewSessions" :last-frame="lastFrame" />
      <button :class="['icon-button', 'favorite-button', { 'is-favorite': server.favorite, 'preview-favorite': card }]" :aria-label="`${server.favorite ? '取消收藏' : '收藏'}${server.name}`" :title="server.favorite ? '取消收藏' : '收藏'" :aria-pressed="server.favorite" @click="$emit('favorite', server.id)"><PhStar :size="19" :weight="server.favorite ? 'fill' : 'regular'" /></button>
      <button v-if="!card" class="icon-button" :aria-label="`编辑${server.name}`" title="编辑" @click="$emit('edit', server)"><PhPencilSimple :size="18" /></button>
    </div>
  </article>
</template>
