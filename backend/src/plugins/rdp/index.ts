import { Service, type Context } from 'cordis'
import { getRdpClient } from '@webnav/shared'
import { AppError } from '../../core/errors.ts'
import { launchFreeRdp, type RdpLauncher } from './native-session.ts'

/** Built-in Cordis RDP plugin. The shared desktop service owns tickets/WS; this plugin owns native sessions. */
export class FreeRdpPlugin extends Service {
  static inject = ['desktops', 'connectors', 'storage']
  constructor(ctx: Context, config: { directory: string; launch?: RdpLauncher; enabled?: boolean }) {
    super(ctx, 'freeRdp', true)
    const launch = config.launch ?? launchFreeRdp
    const removeProvider = ctx.desktops.register('rdp', options => {
      if (config.enabled === false) throw new AppError('PLUGIN_DISABLED', '网页 RDP 插件未启用。')
      return launch({ ...options, directory: config.directory })
    })
    const removeConnector = ctx.connectors.register('rdp', (owner, server, connection) => {
      if (getRdpClient(ctx.storage.connection(server, connection).connection) === 'native') return ctx.connectors.open('rdp-native', owner, server, connection)
      if (config.enabled === false) throw new AppError('PLUGIN_DISABLED', '网页 RDP 插件未启用。')
      return ctx.desktops.create(owner, server, connection)
    })
    ctx.on('dispose', () => { removeConnector(); removeProvider() })
  }
}
