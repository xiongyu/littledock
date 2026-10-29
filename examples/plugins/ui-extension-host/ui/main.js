export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h, ref } = api.vue
  api.ui.registerPoint('summary')
  api.ui.registerPoint('actions')
  api.ui.registerPoint('details')
  api.menus.registerPoint('item')
  api.registerTool('main', { component: {
    props: { active: Boolean },
    setup(props) {
      const menu = ref(), selected = ref('home'), context = { itemId: 'example-item' }
      return () => h('section', { style: 'padding:24px;display:grid;gap:16px' }, [
        h('h1', i18nT('m59360a1de3a1')),
        h('p', i18nT('m1011b8cb289f')),
        h(api.ui.Slot, { point: 'summary', context, isCurrent: () => props.active }),
        h(api.ui.Slot, { point: 'actions', context, isCurrent: () => props.active }),
        h(api.ui.Slot, { point: 'details', context, isCurrent: () => props.active, items: [{ id: 'home', label: i18nT('m2b195835111e') }], active: selected.value, 'onUpdate:active': value => selected.value = value }, { default: () => h('p', i18nT('m9723dfceb0f0')) }),
        h('button', { class: 'button', onContextmenu(event) { event.preventDefault(); menu.value = { x: event.clientX, y: event.clientY } } }, i18nT('m0842b32a1d81')),
        menu.value && h(api.menus.ContextMenu, { ...menu.value, point: 'item', context, isCurrent: () => props.active && !!menu.value, onClose: () => menu.value = undefined }),
      ])
    },
  } })
}
