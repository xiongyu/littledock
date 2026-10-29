import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_CATALOG_BYTES, parseCatalogImport, serializeCatalog, validHost, validateGroups, validateServer } from '../src/catalog-management.ts'
import { orderedGroups } from '../src/catalog.ts'
import { opensInWorkspace } from '../src/connectors.ts'
import { getRdpClient } from '@webnav/shared'
import { exampleGroups, exampleServers } from './fixtures/catalog.ts'

const document = () => structuredClone({ schemaVersion: 1, groups: exampleGroups, servers: exampleServers })

test('embedded RDP and VNC roundtrip; legacy RDP opens in the workspace without rewriting configuration', () => {
  const legacy = { id: 'old', type: 'rdp', name: 'RDP', port: 3389 }
  assert.equal(getRdpClient(legacy), 'browser'); assert.equal(opensInWorkspace(legacy), true)
  assert.equal(opensInWorkspace({ ...legacy, rdpClient: 'browser' }), true)
  assert.equal(getRdpClient({ ...legacy, rdpClient: 'native' }), 'native'); assert.equal(opensInWorkspace({ ...legacy, rdpClient: 'native' }), false)
  assert.equal('rdpClient' in legacy, false)
  const data = document(), connection = { id: 'browser-rdp', type: 'rdp', name: '网页桌面', port: 3389, username: 'test', rdpClient: 'browser', rdpDisplay: { mode: 'windowed', width: 1920, height: 1080 }, rdpOptions: { domain: 'LAB', security: 'nla', certificate: 'tofu' } }
  data.servers[0].connections.push(connection, { id: 'vnc', type: 'vnc', name: 'VNC', port: 5900 })
  const result = parseCatalogImport(JSON.parse(serializeCatalog(data.groups, data.servers)))
  assert.deepEqual(result, data)
  for (const options of [{ security: ['nla'] }, { certificate: ['verify'] }, { domain: 'bad\nvalue' }, { password: 'secret' }]) {
    const invalid = document(); invalid.servers[0].connections.push({ ...connection, rdpOptions: options }); assert.throws(() => parseCatalogImport(invalid))
  }
  const invalid = document(); invalid.servers[0].connections.push({ ...connection, rdpClient: ['browser'] }); assert.throws(() => parseCatalogImport(invalid))
})

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

test('RDP display settings roundtrip independently and old entries remain unchanged', () => {
  const data = document(), server = data.servers.find(server => server.connections.some(connection => connection.type === 'rdp'))
  const original = structuredClone(server.connections[0])
  server.connections = [original, ...[
    { mode: 'windowed', width: 1920, height: 1080 },
    { mode: 'windowed', width: 1512, height: 982 },
    { mode: 'fullscreen' }, { mode: 'multimon' },
  ].map((rdpDisplay, index) => ({ ...original, id: `display-${index}`, rdpDisplay }))]
  const restored = parseCatalogImport(JSON.parse(serializeCatalog(data.groups, data.servers)))
  assert.deepEqual(restored, data)
  assert.equal('rdpDisplay' in restored.servers.find(item => item.id === server.id).connections[0], false)
})

test('RDP display rejects malformed, conflicting and wrong-protocol options before saving or importing', () => {
  for (const rdpDisplay of [
    null, [], 'fullscreen', {}, { mode: 'span' }, { mode: 'fullscreen', width: 1920 },
    { mode: 'multimon', height: 1080 }, { mode: 'windowed' },
    { mode: 'windowed', width: '1920', height: 1080 },
    { mode: 'windowed', width: 199, height: 1080 }, { mode: 'windowed', width: 1920, height: 8193 },
    { mode: 'windowed', width: 1920.5, height: 1080 }, { mode: 'windowed', width: NaN, height: 1080 },
    { mode: 'windowed', width: 1920, height: 1080, args: '/admin' },
  ]) {
    const data = document(), server = data.servers.find(server => server.connections[0].type === 'rdp')
    server.connections[0].rdpDisplay = rdpDisplay
    assert.throws(() => validateServer(server, data.groups))
    assert.throws(() => parseCatalogImport(data))
  }
  const data = document()
  data.servers[0].connections[0].rdpDisplay = { mode: 'fullscreen' }
  assert.throws(() => validateServer(data.servers[0], data.groups))
  assert.throws(() => parseCatalogImport(data))
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
