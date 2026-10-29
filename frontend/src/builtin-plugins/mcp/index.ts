import { registerBuiltinFrontend } from '../../plugin-builtins'
import AutomationPanel from '../../components/AutomationPanel.vue'
registerBuiltinFrontend('builtin.mcp', api => { api.menus.registerPoint('terminal'); api.registerSettingsPage('main', { component: AutomationPanel }) })
