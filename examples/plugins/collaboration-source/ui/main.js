export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h, ref, onMounted } = api.vue
  const font = api.getFontInfo('value')
  api.registerTool('main', { component: {
    setup() {
      const value = ref('—'), error = ref('')
      async function refresh() { try { value.value = (await api.rpc('read')).value } catch (cause) { error.value = cause.message } }
      onMounted(refresh)
      return () => h('section', { class: 'collaboration-example' }, [h('header', [h('h1', api.config.label || i18nT('m5201427b3831')), h('button', { onClick: () => api.openSettings(), 'aria-label': i18nT('m7873c4d026fd') }, i18nT('mdf3d58c7d84b'))]), h('p', { style: { fontSize: `${font.size}px` } }, String(value.value)), h('button', { onClick: refresh }, i18nT('mb3ff92049bec')), h('p', { role: 'status' }, error.value)])
    },
  } })
}
