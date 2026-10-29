import { PhDesktop, PhGlobeHemisphereWest, PhMonitor, PhTerminalWindow, PhAndroidLogo, PhLaptop, PhBroadcast } from '@phosphor-icons/vue'
import { getRdpClient } from '@webnav/shared'
import type { Connection, Protocol } from './catalog'
import { computed } from 'vue'
import { pluginConnectors } from './plugin-registry.ts'

const builtins = {
  local: { icon: PhLaptop, port: 1 }, adb: { icon: PhAndroidLogo, port: 5555 }, wdb: { icon: PhBroadcast, port: 27880 },
  ssh: { icon: PhTerminalWindow, port: 22 }, rdp: { icon: PhDesktop, port: 3389 },
  vnc: { icon: PhMonitor, port: 5900 }, web: { icon: PhGlobeHemisphereWest, port: 443 },
}
export const connectorViews: Record<Protocol, { icon: typeof PhDesktop; port: number }> = new Proxy(builtins, { get(target, key: string) { if(key in target)return target[key as keyof typeof target];const plugin=Object.entries(pluginConnectors).find(([id])=>id.endsWith('/'+key.replace(/^plugin:/,'')))?.[1];return {icon:PhGlobeHemisphereWest,port:plugin?.port??443} } })
export const connectionTypes = computed<Protocol[]>(() => [...Object.keys(builtins) as Protocol[], ...new Set(Object.keys(pluginConnectors).map(id => id.slice(id.indexOf('/')+1)).filter(type => !(type in builtins)).map(type => `plugin:${type}` as Protocol))])
export function opensInWorkspace(connection: Connection) { return ['ssh','local','adb','wdb','vnc'].includes(connection.type) || (connection.type === 'rdp' && getRdpClient(connection) === 'browser') }
