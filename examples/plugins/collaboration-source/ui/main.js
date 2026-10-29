export function activate(api) {
  const { h, ref, onMounted } = api.vue
  const font = api.getFontInfo('value')
  api.registerTool('main', { component: {
    setup() {
      const value = ref('—'), error = ref('')
      async function refresh() { try { value.value = (await api.rpc('read')).value } catch (cause) { error.value = cause.message } }
      onMounted(refresh)
      return () => h('section', { class: 'collaboration-example' }, [h('header', [h('h1', api.config.label || '协作计数器'), h('button', { onClick: () => api.openSettings(), 'aria-label': '计数器设置' }, '设置')]), h('p', { style: { fontSize: `${font.size}px` } }, String(value.value)), h('button', { onClick: refresh }, '读取当前值'), h('p', { role: 'status' }, error.value)])
    },
  } })
}
