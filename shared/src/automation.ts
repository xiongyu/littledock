/** Optional, static AI contract. No handlers or secrets are allowed in manifests. */
export type AutomationSchema = Record<string, unknown>
export interface AutomationTool {
  id: string; version: 1; title: string; description: string
  inputSchema: AutomationSchema; outputSchema: AutomationSchema
  access: 'read' | 'write' | 'execute' | 'control'; scopes: string[]
  execution: 'request' | 'job'
  binding: { kind: 'plugin' | 'service' | 'connector'; capability?: string }
  contract?: { id: string; version: 1 }
}
export interface AutomationDeclaration { version: 1; description: string; tools: AutomationTool[] }
export interface AutomationGrant {
  id: string; name: string; scopes: string[]
  /** null explicitly grants all saved SSH targets. Otherwise exact [serverId, connectionId] pairs. */
  targets: [string, string][] | null; paths: string[]
}
export type AutomationTaskState = 'running' | 'waiting_user' | 'finishing' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'interrupted'
export interface AutomationTaskView {
  id: string; sessionId: string; clientName: string; name: string; serverId: string; connectionId: string
  state: AutomationTaskState; message: string; connected: boolean; createdAt: number; expiresAt: number
  controller: 'ai' | 'user' | 'none'; controlEpoch: number
}
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('自动化声明必须是对象。'); return v as Record<string, unknown> }
function text(v: unknown, max: number) { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f]/.test(v)) throw new Error('自动化声明文本无效。'); return v }
/** JSON Schema is compiled again at registration. External references and unbounded schema depth are forbidden. */
export function parseAutomationSchema(v: unknown): AutomationSchema {
  const schema = obj(v)
  if (schema.type !== 'object' || JSON.stringify(schema).length > 32768) throw new Error('工具 schema 必须是有界的 object。')
  const visit = (value: unknown, depth: number) => {
    if (depth > 16) throw new Error('工具 schema 嵌套过深。')
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', '$id', '__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('工具 schema 不允许引用或危险字段。')
      visit(child, depth + 1)
    }
  }
  visit(schema, 0); return structuredClone(schema)
}
export function parseAutomationDeclaration(v: unknown): AutomationDeclaration {
  const d = obj(v)
  if (d.version !== 1 || !Array.isArray(d.tools) || d.tools.length > 40) throw new Error('自动化声明版本或工具数量无效。')
  const tools = d.tools.map(item => {
    const t = obj(item), id = text(t.id, 80), binding = obj(t.binding)
    if (!/^[a-z][a-zA-Z0-9_.-]*$/.test(id) || t.version !== 1 || !['read','write','execute','control'].includes(String(t.access)) || !['request','job'].includes(String(t.execution))) throw new Error('自动化工具契约无效。')
    if (!['plugin','service','connector'].includes(String(binding.kind)) || (binding.kind !== 'plugin' && typeof binding.capability !== 'string')) throw new Error('自动化提供者绑定无效。')
    if (!Array.isArray(t.scopes) || !t.scopes.length || t.scopes.length > 10) throw new Error('工具需要声明权限。')
    const scopes = t.scopes.map(s => text(s, 100))
    const tool: AutomationTool = { id, version: 1, title: text(t.title, 100), description: text(t.description, 2000), inputSchema: parseAutomationSchema(t.inputSchema), outputSchema: parseAutomationSchema(t.outputSchema), access: t.access as AutomationTool['access'], execution: t.execution as AutomationTool['execution'], scopes, binding: { kind: binding.kind as AutomationTool['binding']['kind'], ...(binding.capability ? { capability: text(binding.capability, 120) } : {}) } }
    if (t.contract !== undefined) { const c = obj(t.contract); if (c.version !== 1) throw new Error('工具契约版本无效。'); tool.contract = { id: text(c.id, 100), version: 1 } }
    return tool
  })
  if (new Set(tools.map(t => t.id)).size !== tools.length) throw new Error('自动化工具 ID 重复。')
  return { version: 1, description: text(d.description, 2000), tools }
}
