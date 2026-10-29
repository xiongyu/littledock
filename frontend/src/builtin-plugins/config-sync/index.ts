import { registerBuiltinFrontend } from '../../plugin-builtins'
import ConfigSyncPanel from '../../components/ConfigSyncPanel.vue'
registerBuiltinFrontend('builtin.configSync', api => api.registerSettingsPage('main', { component: ConfigSyncPanel }))
