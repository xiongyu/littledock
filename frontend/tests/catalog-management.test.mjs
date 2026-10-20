import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_CATALOG_BYTES, parseCatalogImport, serializeCatalog, validHost, validateGroups, validateServer } from '../src/catalog-management.ts'
import { orderedGroups } from '../src/catalog.ts'
import { exampleGroups, exampleServers } from './fixtures/catalog.ts'

const document = () => structuredClone({ schemaVersion: 1, groups: exampleGroups, servers: exampleServers })

test('configuration roundtrips with same-protocol entries and URL paths', () => {
  const data = document()
  data.servers[0].connections.push({ id: 'ssh-admin', type: 'ssh', name: '管理员', port: 2222, username: 'admin', saveHistory: false })
  data.servers[0].connections.find(connection => connection.type === 'web').url = 'https://example.com/admin?mode=test'
  assert.deepEqual(parseCatalogImport(JSON.parse(JSON.stringify(data))), data)
})
test('import rejects secret fields, unsupported versions and malformed types', () => {
  for (const mutate of [data => { data.schemaVersion = 2 }, data => { data.servers[0].password = 'secret' }, data => { data.servers[0].connections[0].privateKey = 'secret' }, data => { data.servers[0].connections[0].type = ['ssh'] }, data => { data.groups[0].parentId = 0 }]) {
    const data = document(); mutate(data); assert.throws(() => parseCatalogImport(data))
  }
})
test('import rejects broken group references, cycles, duplicate identities and names', () => {
  for (const mutate of [data => { data.groups[0].parentId = data.groups[0].id }, data => { data.groups[0].parentId = 'missing' }, data => { data.servers[0].groupId = 'missing' }, data => { data.servers[1].id = data.servers[0].id }, data => { data.groups[1].name = data.groups[0].name }]) {
    const data = document(); mutate(data); assert.throws(() => parseCatalogImport(data))
  }
})
test('group reparenting rejects cycles and excessive nesting; ordering keeps descendants', () => {
  assert.throws(() => validateGroups([{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]))
  assert.throws(() => validateGroups(Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, ...(i ? { parentId: `g${i - 1}` } : {}) }))))
  const groups = [{ id: 'c', name: 'C', parentId: 'b' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }]
  assert.deepEqual(orderedGroups(groups).map(group => [group.id, group.depth]), [['a', 0], ['b', 1], ['c', 2]])
})
test('server addresses accept IPv4, IPv6 and hostnames without command syntax or ports', () => {
  for (const host of ['127.0.0.1', '2001:db8::1', '[::1]', 'server-01.example.com', 'localhost']) assert.equal(validHost(host), true, host)
  for (const host of ['999.1.1.1', '1.2.3', 'https://example.com', 'host:22', '[::1]:22', 'host/path', 'host;whoami', '-host', 'a..b']) assert.equal(validHost(host), false, host)
})
test('unsafe web targets and invalid ports fail before a server is accepted', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com', 'http://exa\nmple.com']) {
    const data = document(); data.servers[0].connections.find(connection => connection.type === 'web').url = url
    assert.throws(() => validateServer(data.servers[0], data.groups))
  }
  for (const port of [0, 65536, 22.5, NaN]) {
    const data = document(); data.servers[0].connections[0].port = port
    assert.throws(() => validateServer(data.servers[0], data.groups))
  }
})
test('failed import does not mutate supplied catalog', () => {
  const data = document(); data.servers[1].groupId = 'missing'
  const before = structuredClone(data)
  assert.throws(() => parseCatalogImport(data))
  assert.deepEqual(data, before)
})

test('group IDs cannot collide with system navigation', () => {
  for (const id of ['all', 'manage', 'recent', 'favorites']) {
    assert.throws(() => parseCatalogImport({ schemaVersion: 1, groups: [{ id, name: '分组' }], servers: [] }), /系统页面/)
  }
})

test('export stays within the import budget for a large accepted catalog', () => {
  const data = document()
  data.servers = Array.from({ length: 2000 }, (_, i) => ({ ...structuredClone(data.servers[0]), id: `s${i}` }))
  const accepted = parseCatalogImport(data)
  const exported = serializeCatalog(accepted.groups, accepted.servers)
  assert.ok(new TextEncoder().encode(exported).byteLength <= MAX_CATALOG_BYTES)
  assert.deepEqual(parseCatalogImport(JSON.parse(exported)), accepted)
  data.servers.push({ ...data.servers[0], id: 's2000' })
  assert.throws(() => serializeCatalog(data.groups, data.servers), /2,000/)
})

test('count and text capacity are enforced before local changes are applied', () => {
  assert.throws(() => validateGroups(Array.from({ length: 201 }, (_, i) => ({ id: `g${i}`, name: `组${i}` }))), /200/)
  const data = document()
  data.servers = Array.from({ length: 1800 }, (_, i) => ({ ...structuredClone(data.servers[0]), id: `s${i}`, note: '长'.repeat(500) }))
  assert.throws(() => serializeCatalog(data.groups, data.servers), /1 MiB/)
  assert.throws(() => parseCatalogImport(data), /1 MiB/)
})
