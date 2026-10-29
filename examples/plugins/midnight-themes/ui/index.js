// Browser ES module; Vue is shared with the host, no build step or CDN required.
export function activate(api) {
  const { h, ref, onMounted } = api.vue
  api.registerView('themes', {
    emits: ['back'],
    setup(_props, { emit, expose }) {
      const settings = ref(), error = ref(''), busy = ref(false)
      onMounted(async () => { try { settings.value = await api.hostRpc('terminalThemes.watch') } catch { error.value = '配色暂时不可用。' } })
      async function save() {
        if (!settings.value) return false
        busy.value = true
        const { revision, defaultId, themes } = settings.value
        try { settings.value = await api.hostRpc('terminalThemes.save', { settings: { revision, defaultId, themes } }, true); return true }
        catch { error.value = '保存失败，请关闭后重新打开。'; return false }
        finally { busy.value = false }
      }
      expose({ dirty: false, busy, save })
      return () => h('section', [
        h('p', { class: 'panel-intro' }, '午夜配色 · 独立插件视图。已有方案和入口引用继续保留。'),
        settings.value ? h('label', { class: 'form-field' }, [h('span', '默认终端配色'), h('select', { value: settings.value.defaultId, onChange: event => { settings.value.defaultId = event.target.value } }, [
          ...[['forest', '静谧森林'], ['midnight', '午夜蓝'], ['graphite', '石墨灰'], ['paper', '暖纸白']].map(([id, name]) => h('option', { value: id }, name)),
          ...settings.value.themes.map(theme => h('option', { value: theme.id }, theme.name)),
        ])]) : h('p', '正在读取…'),
        error.value ? h('p', { role: 'alert' }, error.value) : null,
        h('div', { class: 'form-actions' }, [h('button', { class: 'button', onClick: () => emit('back') }, '返回设置'), h('button', { class: 'button primary', disabled: busy.value, onClick: save }, '保存配色')]),
      ])
    },
  })
}
