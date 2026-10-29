<script setup lang="ts">
import type { TerminalTheme } from '@webnav/shared'
import { pluginI18n } from '../i18n.ts'

const { t: i18nT } = pluginI18n('builtin.terminalThemes')
defineProps<{ theme: TerminalTheme }>()
</script>

<template>
  <div class="terminal-theme-preview" :style="{ background: theme.colors.background, color: theme.colors.foreground }" :aria-label="i18nT('m41fa6af5de9e')">
    <div><span :style="{ color: theme.colors.green }">user@server</span><span :style="{ color: theme.colors.blue }"> ~/workspace</span> $ ls</div>
    <div><span :style="{ color: theme.colors.cyan }">documents/</span> README.md <span :style="{ color: theme.colors.yellow }">warning</span> <span :style="{ color: theme.colors.red }">error</span></div>
    <div><span :style="{ background: theme.colors.selectionBackground }">Selected text</span> <span :style="{ background: theme.colors.cursor }">&nbsp;</span></div>
  </div>
</template>
