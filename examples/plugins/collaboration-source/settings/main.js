export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h } = api.vue
  api.registerSettingsPage('main', { component: { setup: () => () => h('label', { class: 'form-field' }, [h('span', i18nT('m394be2aae7b9')), h('input', { value: api.config.label || '', onInput: event => { api.config.label = event.target.value }, 'aria-label': i18nT('m394be2aae7b9') })]) } })
}
