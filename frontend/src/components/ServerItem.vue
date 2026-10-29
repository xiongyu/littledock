<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { PhDesktop, PhPencilSimple, PhStar, PhHardDrives } from '@phosphor-icons/vue'
import SessionPreview from './SessionPreview.vue'
import { connectorViews } from '../connectors'
import type { Connection, Server } from '../catalog'
import type { PreviewFrame, PreviewSession } from '../session-preview'

defineProps<{ server: Server; groupName: string; card?: boolean; previewSessions?: readonly PreviewSession[]; lastFrame?: PreviewFrame }>()
defineEmits<{ favorite: [id: string]; connect: [server: Server, connection: Connection]; edit: [server: Server] }>()
</script>

<template>
  <article :class="['server-item', { 'server-card': card }]" :aria-label="server.name">
    <div class="server-identity">
      <span class="server-symbol"><PhDesktop v-if="server.connections.some(c => c.type === 'rdp' || c.type === 'vnc')" :size="23" /><PhHardDrives v-else :size="23" /></span>
      <div class="server-description"><h3 :title="server.name">{{ server.name }}</h3><span class="server-address" :title="server.host">{{ server.host }}</span><span v-if="card" class="card-group" :title="groupName">{{ groupName }}</span></div>
    </div>
    <span v-if="!card" class="row-group">{{ groupName }}</span>
    <div class="connection-actions">
      <button v-for="connection in server.connections" :key="connection.id" class="protocol-button" @click="$emit('connect', server, connection)" :aria-label="`${server.name} ${connection.name}`" :title="`${connection.name} · ${connection.port}`">
        <component :is="connectorViews[connection.type]!.icon" :size="18" />
        <span class="visually-hidden">{{ connection.name }}</span>
      </button>
    </div>
    <div :class="card ? 'card-preview' : 'row-actions'">
      <SessionPreview v-if="card" :server-name="server.name" :sessions="previewSessions" :last-frame="lastFrame" />
      <button :class="['icon-button', 'favorite-button', { 'is-favorite': server.favorite, 'preview-favorite': card }]" :aria-label="`${server.favorite ? i18nT('mdca60869e7d2') : i18nT('m60a53514eb92')}${server.name}`" :title="server.favorite ? i18nT('mdca60869e7d2') : i18nT('m60a53514eb92')" :aria-pressed="server.favorite" @click="$emit('favorite', server.id)"><PhStar :size="19" :weight="server.favorite ? 'fill' : 'regular'" /></button>
      <button v-if="!card" class="icon-button" :aria-label="i18nT('mba50ba8e6057', { p0: (server.name) })" :title="i18nT('m051836569928')" @click="$emit('edit', server)"><PhPencilSimple :size="18" /></button>
    </div>
  </article>
</template>
