import { readFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseCatalogImport, type CatalogDocument } from '@webnav/shared'
import { AppError } from '../core/errors.ts'

export type KeyReference = { serverId: string; connectionId: string; path: string }
export function parseSshConfig(text: string, home: string) {
  const blocks: { aliases: string[]; options: Map<string, string> }[] = []
  let current = { aliases: ['*'], options: new Map<string, string>() }; blocks.push(current)
  const warnings = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue
    const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/); if (!match) continue
    const name = match[1]!.toLowerCase()
    const parts = match[2]!.match(/"[^"]*"|'[^']*'|[^\s#]+/g)?.map(token => token.replace(/^("|')|("|')$/g, '')) ?? []
    if (name === 'include' || name === 'match') throw new AppError('IMPORT_UNSUPPORTED', 'SSH 配置包含 Include / Match，需先展开对应配置，未执行任何命令。')
    if (name === 'host') { current = { aliases: parts, options: new Map() }; blocks.push(current) }
    else if (parts[0] && !current.options.has(name)) current.options.set(name, parts.join(' '))
  }
  const aliases = [...new Set(blocks.flatMap(block => block.aliases).filter(alias => !/[*!?]/.test(alias)))]
  const endpoints = new Map<string, { host: string; port: number; user: string; aliases: string[]; path?: string }>()
  for (const alias of aliases) {
    const options = new Map<string, string>()
    for (const block of blocks) {
      const match = (pattern: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(alias)
      if (!block.aliases.some(item => !item.startsWith('!') && match(item)) || block.aliases.some(item => item.startsWith('!') && match(item.slice(1)))) continue
      for (const [key,value] of block.options) if (!options.has(key)) options.set(key, value)
    }
    if (options.has('proxycommand') || options.has('proxyjump')) { warnings.add(`未导入需要跳板或代理的入口：${alias}`); continue }
    const host = options.get('hostname') ?? alias, port = Number(options.get('port') ?? 22), user = options.get('user') ?? process.env.USERNAME ?? process.env.USER ?? ''
    const identity = options.get('identityfile')
    if (identity?.includes('%') || host.includes('%')) { warnings.add(`未导入含变量的入口：${alias}`); continue }
    const path = identity ? resolve(identity.replace(/^~(?=[/\\])/, home)) : undefined
    const endpoint = JSON.stringify([host, port, user, path])
    const previous = endpoints.get(endpoint)
    if (previous) previous.aliases.push(alias)
    else endpoints.set(endpoint, { host, port, user, aliases: [alias], path })
  }
  const catalog: CatalogDocument = { schemaVersion: 1, groups: [{ id: 'ssh-local', name: '本机 SSH' }], servers: [] }, references: KeyReference[] = []
  for (const entry of endpoints.values()) {
    const subnet = /^(10\.\d+\.\d+|192\.168\.\d+)\.\d+$/.exec(entry.host)?.[1]
    const groupId = subnet ? `ssh-net-${subnet.replaceAll('.', '-')}` : 'ssh-other'
    if (!catalog.groups.some(group => group.id === groupId)) catalog.groups.push({ id: groupId, name: subnet ? `${subnet}.*` : '其他地址', parentId: 'ssh-local' })
    const id = 'ssh-' + createHash('sha256').update(JSON.stringify([entry.host, entry.port, entry.user, entry.path])).digest('hex').slice(0, 20)
    const name = entry.aliases.find(alias => alias !== entry.host) ?? entry.host
    catalog.servers.push({ id, name, host: entry.host, groupId, tags: ['SSH'], note: `SSH 别名：${entry.aliases.join('、')}`, favorite: false, connections: [{ id: 'ssh', type: 'ssh', name: 'SSH', port: entry.port, username: entry.user, saveHistory: true }] })
    if (entry.path) references.push({ serverId: id, connectionId: 'ssh', path: entry.path })
  }
  return { catalog: parseCatalogImport(catalog), references, aliases: aliases.length, warnings: [...warnings] }
}
export async function readLocalSshConfig() {
  const home = homedir(), path = join(home, '.ssh', 'config')
  let text: string
  try { text = await readFile(path, 'utf8') } catch { throw new AppError('NOT_FOUND', '未找到本机 ~/.ssh/config。') }
  if (Buffer.byteLength(text) > 1024 * 1024) throw new AppError('INVALID_ARGUMENT', 'SSH 配置过大。')
  const result = parseSshConfig(text, home)
  for (const reference of result.references) { try { await access(reference.path) } catch { result.warnings.push('存在无法读取的私钥路径，请在认证设置中调整。'); break } }
  return result
}
