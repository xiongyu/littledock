<script setup lang="ts">
import { backendError, backendOrigin, catalogLoaded, connectionState } from '../backend'
</script>
<template>
  <section v-if="connectionState !== 'ready' || backendError" class="backend-status" role="status">
    <template v-if="connectionState === 'offline'"><span>{{ catalogLoaded ? '本地服务已断开，当前显示上次加载的目录。' : '尚未连接本地服务，目录还未加载。' }} 正在自动重试。</span><a :href="backendOrigin + '/'">打开本机服务入口</a><span>项目根目录运行：pnpm dev（同时启动前后端）</span></template>
    <template v-else-if="connectionState === 'connecting'">正在连接本地服务…</template>
    <span v-if="backendError">{{ backendError }}</span>
  </section>
</template>
