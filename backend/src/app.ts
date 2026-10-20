import { Context } from 'cordis'
import { StorageService } from './plugins/storage.ts'
import { CredentialService } from './plugins/credentials.ts'
import { AuthService } from './plugins/auth.ts'
import { TerminalHistoryService } from './plugins/terminal-history.ts'
import { ConnectorService, SessionService } from './plugins/sessions.ts'
import { TransportService } from './plugins/transport.ts'
import { RdpService } from './plugins/rdp-local.ts'
import type { RdpLauncher } from './plugins/rdp-local.ts'

export async function createApp(config:{directory:string;port:number;frontendRoot:string;devOrigin?:string;rdpLauncher?:RdpLauncher;credentialClock?:()=>number}) {
  const ctx=new Context()
  ctx.plugin(StorageService,{directory:config.directory});ctx.plugin(CredentialService,{now:config.credentialClock});ctx.plugin(AuthService,{port:config.port})
  ctx.plugin(TerminalHistoryService);ctx.plugin(ConnectorService);ctx.plugin(SessionService);ctx.plugin(RdpService,{launcher:config.rdpLauncher});ctx.plugin(TransportService,config)
  await ctx.start();await ctx.transport.ready
  return ctx
}
