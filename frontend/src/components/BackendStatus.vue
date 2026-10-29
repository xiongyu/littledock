<script setup lang="ts">
import { pluginI18n } from '../i18n.ts'
const { t: i18nT } = pluginI18n('core')

import { backendError, backendOrigin, catalogLoaded, connectionState } from '../backend'
</script>
<template>
  <section v-if="connectionState !== 'ready' || backendError" class="backend-status" role="status">
    <template v-if="connectionState === 'offline'"><span>{{ i18nT('md8d0a4beaa63', { p0: (catalogLoaded ? i18nT('m1ab49637a4e4') : i18nT('m900e3647bce1')) }) }}</span><a :href="backendOrigin + '/'">{{ i18nT('mc1005d0d35f2') }}</a><span>{{ i18nT('m41b6f7e12b83') }}</span></template>
    <template v-else-if="connectionState === 'connecting'">{{ i18nT('mb224e54783af') }}</template>
    <span v-if="backendError">{{ backendError }}</span>
  </section>
</template>
