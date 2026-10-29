export function activate(api) {
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
        h('h1', '界面扩展示例'),
        h('p', '这是独立插件自己声明的区域。安装“进程诊断示例”后，会出现来自另一个插件的内容。'),
        h(api.ui.Slot, { point: 'summary', context, isCurrent: () => props.active }),
        h(api.ui.Slot, { point: 'actions', context, isCurrent: () => props.active }),
        h(api.ui.Slot, { point: 'details', context, isCurrent: () => props.active, items: [{ id: 'home', label: '默认标签' }], active: selected.value, 'onUpdate:active': value => selected.value = value }, { default: () => h('p', '插件自身的默认内容') }),
        h('button', { class: 'button', onContextmenu(event) { event.preventDefault(); menu.value = { x: event.clientX, y: event.clientY } } }, '右键打开示例菜单'),
        menu.value && h(api.menus.ContextMenu, { ...menu.value, point: 'item', context, isCurrent: () => props.active && !!menu.value, onClose: () => menu.value = undefined }),
      ])
    },
  } })
}
