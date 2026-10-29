export function activate(api) {
  const { h, ref, onMounted } = api.vue
  const font = api.getFontInfo('value')
  api.registerTool('main', { component: {
    setup() {
      const value = ref('—'), status = ref('正在读取'), busy = ref(false)
      async function read() { try { const state = await api.rpc('state'); value.value = state.available ? state.value.value : '—'; status.value = state.available ? `来自 ${state.provider} · 版本 ${state.revision}` : '计数器插件尚未启用' } catch (cause) { status.value = cause.message } }
      async function add() { busy.value = true; try { await api.rpc('add', { operationId: crypto.randomUUID(), amount: 1 }, true); await read() } catch (cause) { status.value = cause.message } finally { busy.value = false } }
      onMounted(read)
      return () => h('section', { class: 'collaboration-example' }, [h('header', [h('h1', '协作观察器'), h('button', { onClick: () => api.openSettings({ section: 'fonts' }), 'aria-label': '观察器设置' }, '设置')]), h('p', { style: { fontSize: `${font.size}px` } }, String(value.value)), h('button', { onClick: add, disabled: busy.value }, '通过另一插件 +1'), h('button', { onClick: read }, '刷新状态'), h('p', { role: 'status' }, status.value)])
    },
  } })
}
