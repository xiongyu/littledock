import { Context } from 'cordis'
import { MaintenanceService } from './core/maintenance.ts'
import { UpdateService, type UpdateControl } from './desktop/update-bridge.ts'
import { AutomationService } from './core/automation/service.ts'
import { McpGateway } from './plugins/mcp/index.ts'
import { BrowserExtensionService } from './plugins/browser-extension.ts'
import { ConfigSyncService } from './plugins/config-sync/index.ts'
import type { RemoteFactory } from './plugins/config-sync/git.ts'
import { LocalTerminalPlugin } from './plugins/local/index.ts'
import { DeviceSessionService } from './plugins/device-sessions.ts'
import { AdbPlugin } from './plugins/adb/index.ts'
import { WdbPlugin } from './plugins/wdb/index.ts'
import { PluginManager } from './plugin-system/manager.ts'
import { PluginService } from './plugin-system/runtime.ts'
import { TerminalThemeService } from './plugins/terminal-themes.ts'
import { SshInspectorService } from './plugins/ssh-inspector.ts'
import { SshFilesService } from './plugins/ssh-files/index.ts'
import { RemoteEditorService } from './plugins/remote-editor/index.ts'
import { TaskManagerService } from './plugins/task-manager/coordinator.ts'
import type { TaskManagerConfig } from './plugins/task-manager/contract.ts'
import type { EditorPackageCache } from './plugins/remote-editor/packages.ts'
import { StorageService } from './plugins/storage.ts'
import { CredentialService } from './plugins/credentials.ts'
import { AuthService } from './plugins/auth.ts'
import { TerminalHistoryService } from './plugins/terminal-history.ts'
import { ConnectorService, SessionService } from './plugins/sessions.ts'
import { TransportService } from './plugins/transport.ts'
import { RdpService } from './plugins/rdp-local.ts'
import type { RdpLauncher } from './plugins/rdp-local.ts'
import { WebBookmarkService } from './plugins/web-bookmarks.ts'
import type { WebCapture } from './plugins/web-capture.ts'
import { DesktopSessionService } from './plugins/desktop-sessions.ts'
import { FreeRdpPlugin } from './plugins/rdp/index.ts'
import type { RdpLauncher as EmbeddedRdpLauncher } from './plugins/rdp/native-session.ts'

/** Internal shared-Worker assembly; production entry points use startApplication. */
export async function createApp(config:{directory:string;port:number;frontendRoot:string;devOrigin?:string;rdpLauncher?:RdpLauncher;credentialClock?:()=>number;webCapture?:WebCapture;embeddedRdpLauncher?:EmbeddedRdpLauncher;rdpEnabled?:boolean;editorCache?:Pick<EditorPackageCache,'ensure'>;pluginMarket?:string;disablePlugins?:boolean;bundledPluginsDirectory?:string;syncRemoteFactory?:RemoteFactory;updateControl?:UpdateControl;taskManagerConfig?:Omit<TaskManagerConfig,'directory'>;runtimeGateway?:{token:string};onTransportReady?:(ctx:Context)=>void}) {
  const manager=new PluginManager(config.directory,config.pluginMarket,config.disablePlugins,config.bundledPluginsDirectory);await manager.initialize()
  const ctx=new Context()
  ctx.plugin(MaintenanceService);ctx.plugin(UpdateService,config.updateControl)
  ctx.plugin(StorageService,{directory:config.directory});ctx.plugin(CredentialService,{now:config.credentialClock});ctx.plugin(AuthService,{port:config.port})
  ctx.plugin(ConnectorService);ctx.plugin(PluginService,{manager})
  await ctx.plugins.provide('terminalThemes',ctx=>{ctx.plugin(TerminalThemeService)})
  await ctx.plugins.provide('terminalHistory',ctx=>{ctx.plugin(TerminalHistoryService)})
  await ctx.plugins.provide('sessions',ctx=>{ctx.plugin(SessionService)})
  await ctx.plugins.provide('rdp',ctx=>{ctx.plugin(RdpService,{launcher:config.rdpLauncher})})
  await ctx.plugins.provide('webBookmarks',ctx=>{ctx.plugin(WebBookmarkService,{capture:config.webCapture})})
  ctx.plugin(BrowserExtensionService,{port:config.port})
  await ctx.plugins.provide('configSync',ctx=>{ctx.plugin(ConfigSyncService,{factory:config.syncRemoteFactory})})
  await ctx.plugins.provide('desktops',ctx=>{ctx.plugin(DesktopSessionService)})
  ctx.plugin(DeviceSessionService)
  await ctx.plugins.provide('local',ctx=>{ctx.plugin(LocalTerminalPlugin)})
  await ctx.plugins.provide('adb',ctx=>{ctx.plugin(AdbPlugin)})
  await ctx.plugins.provide('wdb',ctx=>{ctx.plugin(WdbPlugin)})
  await ctx.plugins.provide('freeRdp',ctx=>{ctx.plugin(FreeRdpPlugin,{directory:config.directory,launch:config.embeddedRdpLauncher,enabled:config.rdpEnabled ?? process.env.WEBNAV_RDP_ENABLED !== '0'})})
  ctx.plugin(TransportService,config)
  await ctx.plugins.provide('sshInspector',ctx=>{ctx.plugin(SshInspectorService)})
  await ctx.plugins.provide('sshFiles',ctx=>{ctx.plugin(SshFilesService)})
  await ctx.plugins.provide('taskManager',ctx=>{ctx.plugin(TaskManagerService,{...config.taskManagerConfig,directory:config.directory,execution:manager.builtinDetails.find(p=>p.id==='builtin.taskManager')!.manifest.execution?.backend??'shared'})})
  await ctx.plugins.provide('remoteEditor',ctx=>{ctx.plugin(RemoteEditorService,{directory:config.directory,enabled:process.env.WEBNAV_EDITOR_ENABLED!=='0',cache:config.editorCache})})
  ctx.plugin(AutomationService,{port:config.port})
  ctx.plugin(McpGateway,{port:config.port})
  await ctx.start();await ctx.transport.ready;config.onTransportReady?.(ctx);await ctx.plugins.load()
  return ctx
}
