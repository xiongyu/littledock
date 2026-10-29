export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h, ref, onMounted } = api.vue
  const font = api.getFontInfo('value')
  api.registerTool('main', { component: {
    setup() {
      const value = ref('—'), status = ref(i18nT('m2d1341db7717')), busy = ref(false)
      async function read() { try { const state = await api.rpc('state'); value.value = state.available ? state.value.value : '—'; status.value = state.available ? i18nT('m8eb2c7871f85', { p0: (state.provider), p1: (state.revision) }) : i18nT('m2ac51b7645ff') } catch (cause) { status.value = cause.message } }
      async function add() { busy.value = true; try { await api.rpc('add', { operationId: crypto.randomUUID(), amount: 1 }, true); await read() } catch (cause) { status.value = cause.message } finally { busy.value = false } }
      onMounted(read)
      return () => h('section', { class: 'collaboration-example' }, [h('header', [h('h1', i18nT('mc4533e7b19e7')), h('button', { onClick: () => api.openSettings({ section: 'fonts' }), 'aria-label': i18nT('m18d4f498988d') }, i18nT('mdf3d58c7d84b'))]), h('p', { style: { fontSize: `${font.size}px` } }, String(value.value)), h('button', { onClick: add, disabled: busy.value }, i18nT('m9a82ab6212ed')), h('button', { onClick: read }, i18nT('m802a407c7743')), h('p', { role: 'status' }, status.value)])
    },
  } })
}
