import { registerBuiltinFrontend } from '../../plugin-builtins'
registerBuiltinFrontend('builtin.sshFiles', api => api.menus.registerPoint('entry'))
