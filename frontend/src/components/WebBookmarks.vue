<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('builtin.webBookmarks')

import { ref } from 'vue'
import { PhPlus, PhArrowClockwise } from '@phosphor-icons/vue'
import type { BookmarkSnapshot, WebBookmark } from '@webnav/shared'
import { applyBookmarks, bookmarks, bookmarksLoaded, bookmarksError, connectionState, rpc, synchronizeBookmarks } from '../backend'
import WebBookmarkCard from './WebBookmarkCard.vue'
import WebBookmarkDialog from './WebBookmarkDialog.vue'

const emit = defineEmits<{ notify: [message: string] }>()
const dialog = ref<{ bookmark?: WebBookmark; reveal?: boolean }>()
async function refresh(bookmark: WebBookmark) {
  try { applyBookmarks(await rpc<BookmarkSnapshot>('bookmarks.refresh', { id: bookmark.id }, true)) }
  catch (cause) { emit('notify', cause instanceof Error ? cause.message : i18nT('mba09979243b0')) }
}
</script>

<template>
  <section class="web-bookmarks" aria-labelledby="web-bookmarks-title">
    <div class="section-title"><h2 id="web-bookmarks-title">{{ i18nT('meb57124b0263') }}</h2><span v-if="bookmarksLoaded">{{ bookmarks.length }}</span></div>
    <p v-if="bookmarksError" class="bookmark-load-error" role="alert">{{ bookmarksError }}<button class="icon-button small" :title="i18nT('mf8d8f529e4f7')" :aria-label="i18nT('mf8d8f529e4f7')" @click="synchronizeBookmarks"><PhArrowClockwise :size="17" /></button></p>
    <p v-else-if="!bookmarksLoaded" class="bookmark-help" role="status">{{ i18nT('m65a23a180e35') }}</p>
    <div v-if="bookmarksLoaded" class="web-bookmarks-grid">
      <WebBookmarkCard v-for="bookmark in bookmarks" :key="bookmark.id" :bookmark="bookmark" @edit="dialog = { bookmark }" @reveal="dialog = { bookmark, reveal: true }" @refresh="refresh(bookmark)" />
      <button class="web-bookmark-add" :aria-label="i18nT('me02fe0c55fe3')" :title="i18nT('me02fe0c55fe3')" :disabled="connectionState !== 'ready' || bookmarks.length >= 200" @click="dialog = {}"><PhPlus :size="25" /><span>{{ i18nT('m6181670fef73') }}</span></button>
    </div>
    <WebBookmarkDialog v-if="dialog" :bookmark="dialog.bookmark" :reveal="dialog.reveal" @close="dialog = undefined" @notify="emit('notify', $event)" />
  </section>
</template>
