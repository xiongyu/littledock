import { shallowReactive, type Component } from 'vue'

// Registry data has no browser or transport startup side effects.
export const pluginConnectors = shallowReactive<Record<string, {
  pluginId: string
  name: string
  port: number
  form?: Component
  open?: (serverId: string, connectionId: string) => Promise<void>
}>>({})
