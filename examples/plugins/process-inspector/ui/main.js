// No debugger is launched. This demonstrates the complete UI extension connection.
export function activate(api) {
  const { h, ref } = api.vue
  const sameProcess = (a,b) => ['monitorId','bootId','pid','startedAt','targetKind','serverId','connectionId'].every(key => a[key] === b[key])
  api.menus.registerItem('inspect', {
    when: context => context.startedAt > 0,
    run(context) {
      const instance = api.ui.find({ plugin: 'builtin.taskManager', point: 'process-details' }).find(item => sameProcess(item.context, context))
      if (!instance || !api.ui.activate(instance.id, 'process-details')) throw Error('进程详情已失效，请重新选择进程。')
    },
  })
  api.ui.registerItem('process-details', { component: {
    props: ['context'],
    setup(props) {
      return () => h('div', { class: 'example-process-inspector' }, [h('h3', '进程诊断示例'), h('p', `${props.context.name} · PID ${props.context.pid}`), h('p', `目标：${props.context.targetKind} · ${props.context.platform}`), h('p', '已完成菜单 → 查找当前详情实例 → 打开扩展标签。此示例没有附加调试器。')])
    },
  } })
  api.ui.registerItem('host-summary', { component: { props: ['context'], setup: props => () => h('p', `跨插件面板：${props.context.itemId}`) } })
  api.ui.registerItem('host-action', { component: { setup() { const count = ref(0); return () => h('button', { class: 'button', onClick: () => count.value++ }, `示例操作 ${count.value}`) } } })
  api.ui.registerItem('host-details', { component: { setup: () => () => h('p', '另一个插件提供的标签内容') } })
  api.menus.registerItem('host-inspect', { run(context) { const instance = api.ui.find({ plugin: 'example.ui-extension-host', point: 'details' }).find(item => item.context.itemId === context.itemId); if (instance) api.ui.activate(instance.id, 'host-details') } })
}
