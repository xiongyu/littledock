// Browser ES module; Vue is shared with the host, no build step or CDN required.
export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h, ref, onMounted } = api.vue
  api.registerView('themes', {
    emits: ['back'],
    setup(_props, { emit, expose }) {
      const settings = ref(), error = ref(''), busy = ref(false)
      onMounted(async () => { try { settings.value = await api.hostRpc('terminalThemes.watch') } catch { error.value = i18nT('m2980abd49c0f') } })
      async function save() {
        if (!settings.value) return false
        busy.value = true
        const { revision, defaultId, themes } = settings.value
        try { settings.value = await api.hostRpc('terminalThemes.save', { settings: { revision, defaultId, themes } }, true); return true }
        catch { error.value = i18nT('m93860d3b6733'); return false }
        finally { busy.value = false }
      }
      expose({ dirty: false, busy, save })
      return () => h('section', [
        h('p', { class: 'panel-intro' }, i18nT('m67b17be4b4c7')),
        settings.value ? h('label', { class: 'form-field' }, [h('span', i18nT('m9e407b1749b0')), h('select', { value: settings.value.defaultId, onChange: event => { settings.value.defaultId = event.target.value } }, [
          ...[['forest', i18nT('m9230ef5911bb')], ['midnight', i18nT('me63f8aeeffd7')], ['graphite', i18nT('mbdf7aab1f621')], ['paper', i18nT('mefbf9b7f716b')]].map(([id, name]) => h('option', { value: id }, name)),
          ...settings.value.themes.map(theme => h('option', { value: theme.id }, theme.name)),
        ])]) : h('p', i18nT('m86b6d0d63062')),
        error.value ? h('p', { role: 'alert' }, error.value) : null,
        h('div', { class: 'form-actions' }, [h('button', { class: 'button', onClick: () => emit('back') }, i18nT('md00bfe7c685c')), h('button', { class: 'button primary', disabled: busy.value, onClick: save }, i18nT('m0335851b1bc0'))]),
      ])
    },
  })
}
