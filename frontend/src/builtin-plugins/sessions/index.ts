import { registerBuiltinFrontend } from '../../plugin-builtins'
registerBuiltinFrontend('builtin.sessions', api => { api.menus.registerPoint('terminal'); api.menus.registerPoint('workspace') })
