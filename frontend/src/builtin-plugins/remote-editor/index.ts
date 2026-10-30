import { registerBuiltinFrontend } from '../../plugin-builtins'
import { closeRemoteEditor, openRemoteEditor } from '../../remote-editor'

registerBuiltinFrontend('builtin.remoteEditor', api => {
  for (const id of ['open-terminal', 'open-workspace']) api.menus.registerItem(id, {
    when: context => context.protocol === 'ssh' && context.ai !== true,
    enabled: context => context.ready === true && typeof context.sessionId === 'string' && !!context.sessionId,
    run: context => openRemoteEditor(String(context.sessionId), '', typeof context.name === 'string' ? context.name : api.i18n.t('target.currentSsh'), true),
  })
  api.onDispose(closeRemoteEditor)
})
