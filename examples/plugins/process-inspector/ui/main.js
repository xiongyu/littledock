// No debugger is launched. This demonstrates the complete UI extension connection.
export function activate(api) {
  const { t: i18nT } = api.i18n

  const { h, ref } = api.vue
  const sameProcess = (a,b) => ['monitorId','bootId','pid','startedAt','targetKind','serverId','connectionId'].every(key => a[key] === b[key])
  api.menus.registerItem('inspect', {
    when: context => context.startedAt > 0,
    run(context) {
      const instance = api.ui.find({ plugin: 'builtin.taskManager', point: 'process-details' }).find(item => sameProcess(item.context, context))
      if (!instance || !api.ui.activate(instance.id, 'process-details')) throw Error(i18nT('m335abbda3f50'))
    },
  })
  api.ui.registerItem('process-details', { component: {
    props: ['context'],
    setup(props) {
      return () => h('div', { class: 'example-process-inspector' }, [h('h3', i18nT('mb708d75911ca')), h('p', `${props.context.name} · PID ${props.context.pid}`), h('p', i18nT('mba398612bb32', { p0: (props.context.targetKind), p1: (props.context.platform) })), h('p', i18nT('m7d799f0a638f'))])
    },
  } })
  api.ui.registerItem('host-summary', { component: { props: ['context'], setup: props => () => h('p', i18nT('m03719879130a', { p0: (props.context.itemId) })) } })
  api.ui.registerItem('host-action', { component: { setup() { const count = ref(0); return () => h('button', { class: 'button', onClick: () => count.value++ }, i18nT('ma6ffab078764', { p0: (count.value) })) } } })
  api.ui.registerItem('host-details', { component: { setup: () => () => h('p', i18nT('m6bf7d902ff0e')) } })
  api.menus.registerItem('host-inspect', { run(context) { const instance = api.ui.find({ plugin: 'example.ui-extension-host', point: 'details' }).find(item => item.context.itemId === context.itemId); if (instance) api.ui.activate(instance.id, 'host-details') } })
}
