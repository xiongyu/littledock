// Isolated loopback fixture. Never reads or replaces the user's WebNav directory.
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { once } from 'node:events'
import ssh2 from 'ssh2'
import { createApp } from '../src/app.ts'
import { inspectorFixture } from './ssh-inspector-fixture.mjs'
import { writableSftp,seedRemoteFiles } from './writable-sftp-fixture.mjs'
import { linuxOutput } from './ssh-inspector-fixture.mjs'
import { remoteEditorUiHelper } from './remote-editor-ui-helper.mjs'

const directory = await mkdtemp(join(tmpdir(), 'webnav-terminal-ui-'))
const editorTest=process.env.WEBNAV_TEST_EDITOR==='1'
const writableFiles=process.env.WEBNAV_TEST_FILES==='1'||editorTest,fileRoot=join(directory,'remote')
if(writableFiles)await seedRemoteFiles(fileRoot)
const editor=editorTest?await remoteEditorUiHelper(directory,fileRoot):undefined
const host = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const clients = new Set(), stats = { connections: 0, active: 0, input: [], sizes: [] }
const mock = new ssh2.Server({ hostKeys: [host.privateKey] }, client => {
  clients.add(client); stats.connections++; stats.active++
  editor?.forward(client)
  client.on('error', () => {})
  client.on('close', () => { clients.delete(client); stats.active-- })
  client.on('authentication', context => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', accept => {
    const session = accept()
    if(writableFiles){writableSftp(session,fileRoot);session.on('exec',(accept,_reject,info)=>{const channel=accept();void(async()=>{if(editor&&await editor.exec(channel,info.command))return;channel.write(linuxOutput);channel.exit(0);channel.end()})().catch(()=>{channel.exit(1);channel.end()})})}
    else inspectorFixture(session,stats,process.env.WEBNAV_TEST_WINDOWS==='1'?'windows':'linux')
    session.on('pty', (accept, _reject, info) => { stats.sizes.push([info.cols, info.rows]); accept() })
    session.on('window-change', (accept, _reject, info) => { stats.sizes.push([info.cols, info.rows]); stats.sizes = stats.sizes.slice(-20); accept?.() })
    session.on('shell', accept => {
      const stream = accept()
      stream.write('\x1b[32mfixture@loopback\x1b[0m ~/workspace $\r\n\x1b[36mTerminal workspace test\x1b[0m\r\n')
      for (let index = 1; index <= 40; index++) stream.write(`Saved output ${index}\r\n`)
      let cwd='/home/fixture',line=''
      const prompt=()=>stream.write(writableFiles?`\r\n\x1b]7;file://loopback${cwd}\x07fixture@loopback:${cwd}$ `:'ready> ')
      prompt()
      stream.on('data', data => { stats.input.push(data.toString('hex')); stats.input = stats.input.slice(-20); stream.write(data);if(writableFiles)for(const character of data.toString()){if(character==='\r'||character==='\n'){if(line.startsWith('cd ')){const arg=line.slice(3).trim();cwd=arg==='..'?cwd.replace(/\/[^/]+$/,''):arg.startsWith('/')?arg:cwd+'/'+arg}line='';prompt()}else line+=character} })
    })
  }))
})
mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
const sshPort = mock.address().port
const ctx = await createApp({ directory, port: 3043, frontendRoot: resolve('frontend/dist'), rdpEnabled: false, editorCache:editor?.cache })
const servers = ['Alpha', 'Beta'].map(name => ({ id: name.toLowerCase(), name: `SSH ${name}`, host: '127.0.0.1', groupId: '', tags: ['本机模拟'], note: '', favorite: false, connections: [{ id: 'ssh', name: 'SSH', type: 'ssh', port: sshPort, username: 'fixture', terminalThemeId: name === 'Beta' ? 'midnight' : undefined }] }))
ctx.storage.replace({ schemaVersion: 1, groups: [], servers }, 0)
for (const server of servers) await ctx.credentials.save({serverId:server.id, connectionId:'ssh', kind:'password', secret:'fixture'})
const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(host.privateKey).getPublicSSH()).digest('base64').replace(/=+$/, '')
ctx.storage.db.prepare('INSERT INTO hostkeys VALUES (?,?)').run(JSON.stringify(['127.0.0.1',sshPort]), fingerprint)
let closing = false
async function close() {
  if (closing) return; closing = true; clearInterval(timer)
  await ctx.stop(); for (const client of clients) client.end(); mock.close(); editor?.close()
  const name = relative(tmpdir(), directory)
  if (/^webnav-terminal-ui-[\w-]+$/.test(name)) await rm(directory, { recursive: true, force: true })
  process.exit(0)
}
const timer = setInterval(async () => {
  try { await access(join(directory, 'stop')); await close(); return } catch {}
  await writeFile(join(directory, 'stats.json'), JSON.stringify(stats))
}, 500)
process.on('SIGINT', close); process.on('SIGTERM', close)
console.log(JSON.stringify({ origin: 'http://127.0.0.1:3043', directory }))
