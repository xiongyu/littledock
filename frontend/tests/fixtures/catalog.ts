import type { Group, Connection, Server } from '../../src/catalog.ts'

// 文档专用地址和虚构名称，仅用于界面设计，不尝试连接。
export const exampleGroups: Group[] = [
  { id: 'production', name: '生产环境' },
  { id: 'development', name: '开发环境' },
  { id: 'homelab', name: '家庭实验室' },
  { id: 'compute', name: '计算节点', parentId: 'homelab' },
  { id: 'storage', name: '存储与网络', parentId: 'homelab' },
]

const ssh: Connection = { id: 'ssh', type: 'ssh', name: 'SSH', port: 22, username: 'developer', saveHistory: true }
const rdp: Connection = { id: 'rdp', type: 'rdp', name: 'RDP', port: 3389, username: 'Administrator' }
const web: Connection = { id: 'web', type: 'web', name: '管理面板', port: 443 }

const serverSeeds: Server[] = [
  { id: 'gateway', name: '生产网关', host: '192.0.2.10', groupId: 'production', tags: ['网关', 'Linux'], note: '生产网络的统一入口', favorite: true, connections: [{ ...ssh }, { ...web }] },
  { id: 'app-01', name: '应用节点 01', host: '192.0.2.21', groupId: 'production', tags: ['应用', 'Linux'], note: '主应用节点', favorite: false, connections: [{ ...ssh }] },
  { id: 'database', name: '数据存储', host: '192.0.2.32', groupId: 'production', tags: ['数据库'], note: '业务数据节点', favorite: false, connections: [{ ...ssh }] },
  { id: 'build', name: 'Windows 构建机', host: '192.0.2.45', groupId: 'production', tags: ['Windows', '构建'], note: '编译与构建环境', favorite: false, connections: [{ ...rdp }] },
  { id: 'workstation', name: '开发工作站', host: '198.51.100.24', groupId: 'development', tags: ['开发', 'Windows'], note: '日常开发工作站', favorite: true, connections: [{ ...ssh }, { ...rdp }] },
  { id: 'staging', name: '测试环境', host: '198.51.100.36', groupId: 'development', tags: ['测试'], note: '联调与验收环境', favorite: false, connections: [{ ...ssh }, { ...web, name: '网页' }] },
  { id: 'runner', name: 'CI Runner', host: '198.51.100.48', groupId: 'development', tags: ['CI', '构建'], note: '持续集成执行器', favorite: false, connections: [{ ...ssh }] },
  { id: 'nas', name: '家庭 NAS', host: '203.0.113.8', groupId: 'storage', tags: ['存储', '家庭'], note: '文件与照片归档', favorite: true, connections: [{ ...ssh }, { ...web }] },
  { id: 'lab', name: '实验节点', host: '203.0.113.16', groupId: 'compute', tags: ['容器', 'Linux'], note: '新服务的试验空间', favorite: false, connections: [{ ...ssh }, { ...web, name: '网页' }] },
  { id: 'router', name: '软路由', host: '203.0.113.1', groupId: 'storage', tags: ['网络'], note: '家庭网络管理', favorite: false, connections: [{ ...ssh }, { ...web }] },
]

export const exampleServers: Server[] = serverSeeds.map(server => ({ ...server, connections: server.connections.map(connection => connection.type === 'web' ? { ...connection, url: `https://${server.host}/` } : connection) }))
