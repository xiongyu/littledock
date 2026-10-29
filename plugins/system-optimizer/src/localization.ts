import type { PluginWorkerApi } from '../../../backend/src/plugin-api.ts'

/** Bound once per plugin Worker before constructing the engine or native adapter. */
export let i18n: PluginWorkerApi['i18n']
export function initializeMessages(messages: PluginWorkerApi['i18n']) { i18n = messages }
