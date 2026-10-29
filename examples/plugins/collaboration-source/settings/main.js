export function activate(api) {
  const { h } = api.vue
  api.registerSettingsPage('main', { component: { setup: () => () => h('label', { class: 'form-field' }, [h('span', '计数器标题'), h('input', { value: api.config.label || '', onInput: event => { api.config.label = event.target.value }, 'aria-label': '计数器标题' })]) } })
}
