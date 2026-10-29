import { registerBuiltinFrontend } from '../../plugin-builtins'
import TaskManagerTool from './Tool.vue'
registerBuiltinFrontend('builtin.taskManager', api => {
  api.menus.registerPoint('process')
  api.ui.registerPoint('process-details')
  const fonts = Object.fromEntries(['process.table', 'heading', 'chart', 'caption', 'metric'].map(flag => [flag, api.getFontInfo(flag)]))
  const component = api.vue.defineComponent({
    props: { active: Boolean }, emits: ['status'],
    setup(props, { emit }) { return () => api.vue.h('div', { class: 'task-manager-tool', style: Object.fromEntries(Object.entries(fonts).map(([flag, font]) => [`--tm-font-${flag.replace('.', '-')}`, `${font.size}px`])) }, [api.vue.h(TaskManagerTool, { active: props.active, onStatus: (message: string) => emit('status', message), onSettings: () => api.openSettings() })]) },
  })
  api.registerTool('main', { component })
})
