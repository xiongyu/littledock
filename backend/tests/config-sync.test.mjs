import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { Context } from 'cordis'
import { createApp } from '../src/app.ts'
import { StorageService } from '../src/plugins/storage.ts'
import { CredentialService } from '../src/plugins/credentials.ts'
import { TerminalThemeService } from '../src/plugins/terminal-themes.ts'
import { WebBookmarkService } from '../src/plugins/web-bookmarks.ts'
import { ConfigSyncService } from '../src/plugins/config-sync/index.ts'
import { GitSyncRemote, parseSyncSettings } from '../src/plugins/config-sync/git.ts'
import { decrypt, deriveKey, encrypt, freshKeyInfo, parseEnvelope } from '../src/plugins/config-sync/crypto.ts'
import { applySnapshot, canonical, capture, localStamp, mergeSnapshots, parseSnapshot } from '../src/plugins/config-sync/snapshot.ts'

const settings = { provider: 'github', repository: 'https://github.com/example/sync.git', branch: 'webnav-sync', spaceId: 'a'.repeat(32), username: '', includeSecrets: true, includePlugins: false, autoSync: false }
const password = 'test-only-sync-password-123', account = '同步测试'
const entry = (id, name = id, type = 'ssh') => ({ id, name, host: '127.0.0.1', groupId: '', tags: [], note: '', favorite: false, connections: [{ id: 'c', type, name: type, port: 22, username: 'test' }] })
const catalog = (...servers) => ({ schemaVersion: 1, groups: [], servers })
const contexts=new Map()
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'webnav-sync-test-')); t.after(async () => { for(const ctx of contexts.get(t)??[])await ctx.stop(); await rm(path, { recursive: true, force: true }) }); return path }
async function services(t, root, remoteFactory) {
  const ctx = new Context(); ctx.plugin(StorageService, { directory: root }); ctx.plugin(CredentialService); ctx.plugin(TerminalThemeService); ctx.plugin(WebBookmarkService, { capture: async () => { throw new Error('no capture') } })
  ctx.set('plugins', { manager: { registry: { installed: [], revision: 0 } } }); ctx.plugin(ConfigSyncService, { factory: remoteFactory }); await ctx.start(); contexts.set(t,[...(contexts.get(t)??[]),ctx]); return ctx
}
function factory(root, repo, faults = {}) { return async (settings, token, signal) => { const git = await new GitSyncRemote(root, settings, token, signal, repo).initialize(); if (faults.publish) { const original = git.publish.bind(git); git.publish = async (...args) => { await original(...args); if (faults.publish) { faults.publish = false; throw new Error('simulated lost response') } } }; return git } }
async function setup(t) {
  const root = await folder(t), repo = join(root, 'remote.git'); await mkdir(repo); execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore', windowsHide: true })
  const faults = {}, a = await services(t, join(root, 'a'), factory(join(root, 'ga'), repo, faults)), b = await services(t, join(root, 'b'), factory(join(root, 'gb'), repo))
  for (const ctx of [a,b]) ctx.configSync.configure({ settings, expected: 'null', saveToken: false })
  return { root, repo, a, b, faults }
}

test('portable plugin references omit host-bundled packages and retain independent Git plugins', async t => {
  const root = await folder(t), ctx = await services(t, root)
  ctx.plugins.manager.registry.installed = [
    { source: 'bundled', manifest: { id: 'webnav.system-optimizer' }, repository: 'bundled:webnav.system-optimizer', commit: 'a'.repeat(64) },
    { manifest: { id: 'example.independent' }, repository: 'https://example.com/plugin.git', commit: 'b'.repeat(40) },
  ]
  const snapshot = capture(ctx, { ...settings, includeSecrets: false, includePlugins: true })
  assert.deepEqual(snapshot.plugins, [{ id: 'example.independent', repository: 'https://example.com/plugin.git', commit: 'b'.repeat(40) }])
})
async function unlock(ctx, create = false) { return ctx.configSync.unlock({ account, password, create, minutes: 0 }) }
async function sync(ctx, input = {}) { const preview = await ctx.configSync.preview('owner', input); assert.equal(preview.conflicts, 0); await ctx.configSync.apply('owner', { token: preview.token }); return preview }

test('encryption binds account, password, header and space; rejects hostile KDF profiles and malformed envelopes', async () => {
  const info = freshKeyInfo(), key = await deriveKey(account, password, info)
  const clear = { secret: 'test-only-private-password', host: '127.0.0.1' }, text = encrypt(key, info, settings.spaceId, clear)
  assert.deepEqual(decrypt(key, settings.spaceId, text), clear); assert.ok(!text.includes(clear.secret)); assert.ok(!text.includes(account))
  const other = await deriveKey(account+'x', password, info); assert.throws(() => decrypt(other, settings.spaceId, text), { code: 'SYNC_DECRYPT' }); other.fill(0)
  assert.throws(() => decrypt(key, 'b'.repeat(32), text), { code: 'SYNC_FORMAT' })
  const envelope = JSON.parse(text), header = JSON.parse(envelope.header); header.epoch = 'b'.repeat(32); envelope.header = JSON.stringify(header)
  assert.throws(() => decrypt(key, settings.spaceId, JSON.stringify(envelope)), { code: 'SYNC_DECRYPT' })
  header.profile = 'argon2id-99999m'; envelope.header = JSON.stringify(header); assert.throws(() => parseEnvelope(JSON.stringify(envelope),settings.spaceId),{code:'SYNC_FORMAT'})
  assert.notEqual(encrypt(key,info,settings.spaceId,clear),text); await assert.rejects(deriveKey(account,'short',info)); key.fill(0)
})

test('provider settings reject credential URLs, arbitrary hosts, branch injection and invalid spaces', () => {
  assert.equal(parseSyncSettings(settings).repository,settings.repository)
  for (const override of [{repository:'https://github.com.evil.invalid/a/b'},{repository:'https://token@github.com/a/b'},{branch:'../main'},{spaceId:'../secrets'},{repository:'file:///tmp/repo'}]) assert.throws(()=>parseSyncSettings({...settings,...override}))
})

test('two independent devices restore encrypted secrets, merge different records, resolve conflicts and preserve local bindings', async t => {
  const { a, b, repo } = await setup(t)
  a.storage.replace(catalog(entry('one'), entry('two'), {...entry('local','Local','local'),connections:[{id:'c',type:'local',name:'Local',port:1,pluginSettings:{shell:'auto',cwd:'C:\\private-folder'}}]}),0)
  await a.credentials.save({serverId:'one',connectionId:'c',kind:'password',secret:'connection-secret-only-for-tests'})
  a.webBookmarks.save({bookmark:{id:'site',name:'测试站点',url:'https://example.com/'},expectedVersion:0,login:{username:'demo',password:'bookmark-secret-only-for-tests'}})
  await unlock(a,true); await sync(a)
  const raw=execFileSync('git',['--git-dir',repo,'show',`webnav-sync:spaces/${settings.spaceId}/snapshot.wnsync`],{encoding:'utf8',windowsHide:true})
  assert.ok(!raw.includes('connection-secret')); assert.ok(!raw.includes('private-folder')); assert.ok(!raw.includes('example.com'))
  await b.credentials.changeMode('master','local-master-password'); await unlock(b); await sync(b)
  assert.equal((await b.credentials.resolve('one','c')).password,'connection-secret-only-for-tests'); assert.equal(b.credentials.bookmarkLogin('site').password,'bookmark-secret-only-for-tests')
  assert.equal(b.storage.snapshot().snapshot.servers[2].connections[0].pluginSettings.cwd,undefined); assert.equal(b.configSync.status().bindings.length,1)
  let value=a.storage.snapshot(); value.snapshot.servers[0].name='from-a';a.storage.replace(value.snapshot,value.revision)
  value=b.storage.snapshot();value.snapshot.servers[1].name='from-b';b.storage.replace(value.snapshot,value.revision)
  await sync(a);await sync(b);await sync(a);assert.deepEqual(a.storage.snapshot().snapshot.servers.slice(0,2).map(s=>s.name),['from-a','from-b'])
  value=a.storage.snapshot();value.snapshot.servers[0].name='conflict-a';a.storage.replace(value.snapshot,value.revision)
  value=b.storage.snapshot();value.snapshot.servers[0].name='conflict-b';b.storage.replace(value.snapshot,value.revision)
  await sync(a);const preview=await b.configSync.preview('owner',{});assert.ok(preview.conflicts);await assert.rejects(b.configSync.apply('other',{token:preview.token}),{code:'PREVIEW_EXPIRED'})
  await sync(b,{choices:Object.fromEntries(preview.changes.filter(c=>c.conflict).map(c=>[c.key,'remote']))});assert.equal(b.storage.snapshot().snapshot.servers[0].name,'conflict-a')
  assert.equal(a.storage.snapshot().snapshot.servers[2].connections[0].pluginSettings.cwd,'C:\\private-folder')
})

test('conditional Git writes reject concurrent replacement and preserve unrelated files/history', async t => {
  const { root,repo }=await setup(t), signal=new AbortController().signal
  const a=await factory(join(root,'extra-a'),repo)(settings,'',signal),b=await factory(join(root,'extra-b'),repo)(settings,'',signal);t.after(()=>a.close());t.after(()=>b.close())
  const ca=await a.prepare(null,'first'),cb=await b.prepare(null,'other');await a.publish(null,ca);await assert.rejects(b.publish(null,cb),{code:'SYNC_CONFLICT'})
  assert.equal((await b.read()).text,'first');assert.equal(await b.contains(ca),true)
  assert.equal((await a.history()).versions.length,1)
})

test('Git credential helper supplies only the scoped HTTPS token over IPC',async t=>{
  const root=await folder(t),repo=join(root,'remote');await mkdir(repo);execFileSync('git',['init','--bare',repo],{stdio:'ignore',windowsHide:true})
  const remote=await factory(join(root,'git'),repo)(settings,'synthetic-repository-token',new AbortController().signal)
  try {
    const output=await remote.run(['credential','fill'],'protocol=https\nhost=github.com\npath=example/sync.git\n\n')
    assert.ok(output.includes('password=synthetic-repository-token'))
    await assert.rejects(remote.run(['credential','fill'],'protocol=https\nhost=evil.invalid\npath=example/sync.git\n\n'))
    assert.ok(!(await readFile(join(root,'git', (await import('../src/plugins/config-sync/crypto.ts')).digest(settings.repository+'/'+settings.branch),'config'),'utf8')).includes('synthetic-repository-token'))
  }finally{await remote.close()}
})

test('upload response loss is recovered without duplicate submission; newer local edits survive', async t=>{
  const {a,b,faults,repo}=await setup(t);a.storage.replace(catalog(entry('one')),0);await unlock(a,true);await sync(a);await unlock(b);await sync(b)
  let value=a.storage.snapshot();value.snapshot.servers.push(entry('remote-new'));a.storage.replace(value.snapshot,value.revision);await sync(a)
  value=b.storage.snapshot();value.snapshot.servers[0].name='local-change';b.storage.replace(value.snapshot,value.revision)
  const bFactory=factory(join(await folder(t),'fault'),repo,{publish:true});b.configSync.factory=bFactory
  const p=await b.configSync.preview('owner',{});await assert.rejects(b.configSync.apply('owner',{token:p.token}));assert.equal(b.configSync.status().pending,true)
  value=b.storage.snapshot();value.snapshot.servers[0].note='changed during outage';b.storage.replace(value.snapshot,value.revision)
  await b.configSync.recover({});assert.equal(b.configSync.status().pending,false)
  const recoveryPreview=await b.configSync.preview('owner',{});await sync(b,{choices:Object.fromEntries(recoveryPreview.changes.filter(c=>c.conflict).map(c=>[c.key,'local']))})
  assert.ok(b.storage.snapshot().snapshot.servers.some(s=>s.id==='remote-new'));assert.equal(b.storage.snapshot().snapshot.servers[0].note,'changed during outage')
})

test('password rotation, history restore, lock and unselected secrets keep their boundaries',async t=>{
  const {a,b}=await setup(t);a.storage.replace(catalog(entry('one')),0);await a.credentials.save({serverId:'one',connectionId:'c',kind:'password',secret:'saved-secret'});await unlock(a,true);await sync(a)
  const old=(await a.configSync.history({})).versions[0].version
  await a.configSync.rotate({account:'new-account',password:'new-password-long-enough',acceptHistory:true});a.configSync.lock()
  await assert.rejects(unlock(a));await a.configSync.unlock({account:'new-account',password:'new-password-long-enough',minutes:0})
  const p=await a.configSync.preview('owner',{mode:'restore',version:old,oldAccount:account,oldPassword:password});await a.configSync.apply('owner',{token:p.token})
  b.configSync.configure({settings:{...settings,includeSecrets:false},expected:canonical(settings),saveToken:false});await b.configSync.unlock({account:'new-account',password:'new-password-long-enough',minutes:0});await sync(b)
  assert.equal(b.credentials.describe('one','c').configured,false)
  let value=b.storage.snapshot();value.snapshot.servers[0].note='no secrets device';b.storage.replace(value.snapshot,value.revision);await sync(b);await sync(a);assert.equal((await a.credentials.resolve('one','c')).password,'saved-secret')
  a.credentials.lock();assert.equal(a.configSync.status().unlocked,true) // No local master: locking local mode does not revoke access.
  a.configSync.lock();assert.equal(a.configSync.status().unlocked,false);await assert.rejects(a.configSync.preview('owner',{}),{code:'SYNC_LOCKED'})
})

test('atomic local apply rolls back catalog, bookmarks, credentials and anchor on failure',async t=>{
  const {a}=await setup(t);a.storage.replace(catalog(entry('one')),0);await a.credentials.save({serverId:'one',connectionId:'c',kind:'password',secret:'keep-me'})
  const snapshot=capture(a,settings);snapshot.catalog.servers[0].name='not-committed';const before=a.storage.snapshot()
  assert.throws(()=>applySnapshot(a,snapshot,settings,localStamp(a),()=>{throw new Error('disk failure')}));assert.deepEqual(a.storage.snapshot(),before);assert.equal((await a.credentials.resolve('one','c')).password,'keep-me')
  await a.credentials.changeMode('master','master-password');a.credentials.saveSyncToken('repository-token');a.storage.replace(a.storage.snapshot().snapshot,a.storage.snapshot().revision);assert.equal(a.credentials.syncToken(),'repository-token');assert.ok(!JSON.stringify(a.credentials.exportSyncSecrets()).includes('repository-token'))
  await a.credentials.changeMode('local','');assert.equal(a.credentials.hasSyncToken(),false)
})

test('a persisted unknown upload recovers after restart, and replayed old ciphertext is rejected',async t=>{
  const {root,repo,a,faults}=await setup(t);a.storage.replace(catalog(entry('one')),0);await unlock(a,true);faults.publish=true
  const p=await a.configSync.preview('owner',{});await assert.rejects(a.configSync.apply('owner',{token:p.token}));assert.equal(a.configSync.status().pending,true)
  assert.throws(()=>a.configSync.configure({settings:{...settings,spaceId:'b'.repeat(32)},expected:canonical(settings),saveToken:false}),{code:'SYNC_PENDING'})
  a.configSync.configure({settings,expected:canonical(settings),saveToken:false,token:'replacement-token'});assert.equal(a.configSync.status().pending,true)
  await a.stop();const resumed=await services(t,join(root,'a'),factory(join(root,'ga'),repo));assert.equal(resumed.configSync.status().unlocked,false);await unlock(resumed);await resumed.configSync.recover({});assert.equal(resumed.configSync.status().pending,false)
  const first=(await resumed.configSync.history({})).versions[0].version
  const value=resumed.storage.snapshot();value.snapshot.servers[0].note='new state';resumed.storage.replace(value.snapshot,value.revision);await sync(resumed)
  execFileSync('git',['--git-dir',repo,'update-ref','refs/heads/webnav-sync',first],{stdio:'ignore',windowsHide:true})
  await assert.rejects(resumed.configSync.preview('owner',{}),{code:'SYNC_ROLLBACK'});assert.equal(resumed.storage.snapshot().snapshot.servers[0].note,'new state')
  await resumed.credentials.changeMode('master','master-password-for-lock');resumed.credentials.lock();assert.equal(resumed.configSync.status().unlocked,false)
})

test('sync WS guards operation IDs and exposes no credentials in status or plugin metadata',async t=>{
  const root=await folder(t),listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r))
  const ui=join(root,'ui');await mkdir(ui);await (await import('node:fs/promises')).writeFile(join(ui,'index.html'),'<html>test</html>')
  const ctx=await createApp({directory:join(root,'data'),port,frontendRoot:ui});contexts.set(t,[ctx])
  const origin=`http://127.0.0.1:${port}`,cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0],ws=new WebSocket(origin.replace('http','ws')+'/ws',{origin,headers:{cookie}})
  const [hello]=await once(ws,'message');const epoch=JSON.parse(hello.toString()).epoch;let id=0
  const call=(method,params,operationId)=>new Promise((resolve,reject)=>{const current=String(++id);const handler=raw=>{const m=JSON.parse(raw.toString());if(m.id!==current)return;ws.off('message',handler);m.ok?resolve(m.result):reject(Object.assign(new Error(m.error.message),m.error))};ws.on('message',handler);ws.send(JSON.stringify({v:1,type:'request',epoch,id:current,method,params,operationId}))})
  try {
    const p={settings,expected:'null',saveToken:false,token:'synthetic-ws-token'}
    await assert.rejects(call('configSync.configure',p),{code:'INVALID_ARGUMENT'})
    const result=await call('configSync.configure',p,'same-operation');assert.ok(!JSON.stringify(result).includes('synthetic-ws-token'))
    await assert.rejects(call('configSync.configure',p,'same-operation'),{code:'SYNC_ALREADY_REQUESTED'})
    await assert.rejects(call('configSync.configure',{...p,token:'different'},'same-operation'),{code:'OPERATION_CONFLICT'})
    const plugins=await call('plugins.state',{});assert.ok(plugins.builtins.some(p=>p.id==='builtin.configSync'));assert.ok(!JSON.stringify(plugins).includes('synthetic-ws-token'))
  } finally {ws.terminate()}
})
