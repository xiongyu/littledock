/** Bound once per plugin Worker before constructing the engine or native adapter. */
export let i18n;
export function initializeMessages(messages) { i18n = messages; }
