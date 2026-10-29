import { defineComponent, h, type PropType } from 'vue'
import type { PluginMenuContext } from '@webnav/shared'
import type { PluginMenusApi, PluginMenuLocalItem, PluginUiApi } from './plugin-menu-api'
import { menuBinding, type PluginMenuScope } from './plugin-menus'
import { pluginUi, type PluginUiScope } from './plugin-ui'
import ContextMenu from './components/ContextMenu.vue'
import PluginUiSlot from './components/PluginUiSlot.vue'

export function createUiApi(menus: PluginMenuScope, ui: PluginUiScope): { menus: PluginMenusApi; ui: PluginUiApi } {
  const base = { point: { type: String, required: true as const }, context: { type: Object as PropType<PluginMenuContext>, required: true as const }, isCurrent: { type: Function as PropType<() => boolean>, required: true as const } }
  const Menu = defineComponent({
    props: { ...base, x: { type: Number, required: true }, y: { type: Number, required: true }, items: { type: Array as PropType<PluginMenuLocalItem[]>, default: () => [] }, execute: Function as PropType<(id: string) => unknown>, owner: Object as PropType<Document>, label: String },
    emits: ['close'], setup(props, { emit }) { return () => h(ContextMenu, { ...props, x: props.x!, y: props.y!, extension: menuBinding(menus.plugin, props.point, () => props.context, () => !menus.disposed && props.isCurrent()), onClose: () => emit('close') }) },
  })
  const Slot = defineComponent({
    props: { ...base, items: Array as PropType<{ id: string; label: string }[]>, active: String }, emits: ['update:active'],
    setup(props, { emit, slots }) { return () => h(PluginUiSlot, { ...props, plugin: ui.plugin, isCurrent: () => !ui.disposed && props.isCurrent(), 'onUpdate:active': id => emit('update:active', id) }, slots) },
  })
  return {
    menus: { registerPoint(id) { menus.registerPoint(id); ui.registerPoint(id, true) }, registerItem: (id, handler) => menus.registerItem(id, handler), ContextMenu: Menu },
    ui: { registerPoint: id => ui.registerPoint(id), registerItem: (id, item) => ui.registerItem(id, item), listPoints: query => ui.disposed ? [] : pluginUi.listPoints(query), find: query => ui.disposed ? [] : pluginUi.find(query), activate: (instance, item) => pluginUi.activate(ui, instance, item), Slot },
  }
}
