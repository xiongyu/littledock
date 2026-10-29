// Build a self-contained portable distribution and a signed online-update artifact.
import { parseArgs } from 'node:util'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, writeFile, cp, readdir, lstat, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, resolve, dirname, relative, isAbsolute, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { atomicJson, fileHash, giteeReleaseRepository, releaseVersion, sourceConfig, DATA_VERSION, LAUNCHER_VERSION } from '../backend/src/desktop/update-files.ts'
import { copyRuntimeDependencies } from './runtime-dependencies.mjs'
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(new URL('../backend/package.json', import.meta.url))
const { ZipFile } = require('yazl')
const { values } = parseArgs({ options: { version: { type: 'string' }, output: { type: 'string' }, feed: { type: 'string' }, key: { type: 'string' }, notes: { type: 'string' }, 'keygen': { type: 'boolean' }, 'skip-build': { type: 'boolean' }, channel: { type: 'string', default: 'stable' } }, strict: true })
if (values.keygen) {
  if (!values.key) throw new Error('请用 --key 指定仓库之外的新签名私钥路径。')
  const path = resolve(values.key), rel = relative(root, path)
  if (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel)) throw new Error('签名私钥必须保存在仓库之外。')
  const pair = generateKeyPairSync('ed25519'); await mkdir(dirname(path), { recursive: true })
  await writeFile(path, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
  await writeFile(path + '.public', pair.publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o600 })
  console.log('签名密钥已创建；私钥不进入安装包或仓库。'); process.exit(0)
}
if (!values.version || !values.output || !values.feed || !values.key) throw new Error('需要 --version、--output、--feed 与 --key；私钥应位于仓库外。')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前发布脚本只验收 Windows x64，请在对应平台构建。')
if (process.versions.node.split('.')[0] !== '24') throw new Error('请使用已验证的 Node.js 24 构建，原生模块必须与随包 Node 匹配。')
const keyPath = resolve(values.key), keyRelative = relative(root, keyPath)
if (keyRelative.split(/[\\/]/)[0] !== '..' && !isAbsolute(keyRelative)) throw new Error('签名私钥必须保存在仓库之外。')
const version = releaseVersion(values.version), output = resolve(values.output), privateKey = createPrivateKey(await readFile(keyPath))
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('发布签名必须使用 Ed25519。')
const source = sourceConfig({ feed: values.feed, publicKey: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString(), channel: values.channel })
const giteeRepository = giteeReleaseRepository(source.feed)
const run = (command, args, cwd = root) => new Promise((resolveDone, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit', shell: false })
  child.on('error', reject); child.on('exit', code => code === 0 ? resolveDone() : reject(new Error('发布准备命令失败。')))
})
// Locate the real pnpm executable once; never invoke shell-interpolated command strings.
let pnpm = process.env.npm_execpath
if (!pnpm || !/\.(exe|c?js|mjs)$/.test(pnpm)) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const candidate of [join(directory, 'pnpm.exe'), join(directory, 'node_modules/pnpm/pnpm.exe'), join(directory, 'node_modules/pnpm/bin/pnpm.cjs'), join(directory, 'node_modules/pnpm/bin/pnpm.mjs')]) {
      if (await lstat(candidate).then(s=>s.isFile()).catch(()=>false)) { pnpm=candidate; break }
    }
    if (pnpm && /\.(exe|c?js|mjs)$/.test(pnpm)) break
  }
}
if (!pnpm) throw new Error('无法找到 pnpm，请通过 pnpm release:build 运行。')
const pnpmCommand = /\.exe$/.test(pnpm) ? [pnpm, []] : [process.execPath, [pnpm]]
if (!values['skip-build']) await run(pnpmCommand[0], [...pnpmCommand[1], 'build'])
if (!values['skip-build']) await run(pnpmCommand[0], [...pnpmCommand[1], 'collector:build'])
await run(process.execPath, [join(root, 'scripts/task-manager-build.mjs'), '--verify'])
await mkdir(dirname(output), { recursive: true }); await mkdir(output, { recursive: false })
const portable = join(output, 'LittleDock'), release = join(portable, 'releases', version), backend = join(release, 'backend')
await mkdir(release, { recursive: true })
await mkdir(backend,{recursive:true})
await cp(join(root,'backend/package.json'),join(backend,'package.json'))
for(const path of ['dist','plugins','native/rdp/package','native/task-manager/package'])await cp(join(root,'backend',path),join(backend,path),{recursive:true})
const dependencies=await copyRuntimeDependencies(join(root,'backend'),join(backend,'node_modules'))
await atomicJson(join(release,'runtime-dependencies.json'),{node:process.versions.node,lockfileSha256:await fileHash(join(root,'pnpm-lock.yaml')),dependencies})
await cp(join(root, 'frontend/dist'), join(release, 'frontend/dist'), { recursive: true })
await cp(join(root, 'plugins'), join(release, 'plugins'), { recursive: true })
const shared = join(backend, 'node_modules/@webnav/shared/dist/plugins.js')
await writeFile(shared, (await readFile(shared, 'utf8')).replace(/export const WEBNAV_VERSION = '[^']+'/, `export const WEBNAV_VERSION = '${version}'`))
await mkdir(join(release, 'runtime'), { recursive: true }); await cp(process.execPath, join(release, 'runtime/node.exe'))
const info = { schemaVersion: 1, version, platform: process.platform, arch: process.arch, dataVersion: DATA_VERSION, minLauncherVersion: LAUNCHER_VERSION }
await atomicJson(join(release, 'release.json'), info)
await run(join(release, 'runtime/node.exe'), ['--input-type=module', '-e', "import Database from 'better-sqlite3'; import * as pty from 'node-pty'; import {WEBNAV_VERSION} from '@webnav/shared'; const db=new Database(':memory:');db.close();if(!pty.spawn||!WEBNAV_VERSION)process.exit(1)"], backend)
async function zipDirectory(directory, destination) {
  const zip = new ZipFile(), done = pipeline(zip.outputStream, createWriteStream(destination, { flags: 'wx' }))
  async function visit(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name), name = prefix + entry.name, metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error('发布目录包含链接，请检查依赖部署：' + name)
      if (entry.isDirectory()) await visit(path, name + '/')
      else if (entry.isFile()) zip.addFile(path, name)
    }
  }
  await visit(directory); zip.end(); await done
}
const artifactName = `webnav-${version}-${process.platform}-${process.arch}.zip`, artifact = join(output, artifactName)
await zipDirectory(release, artifact)
const { size } = await lstat(artifact), publishedAt = Date.now()
const manifest = { ...info, url: new URL(giteeRepository ? `${giteeRepository}/releases/download/v${version}/${artifactName}` : artifactName, source.feed).href, size, sha256: await fileHash(artifact), notes: values.notes ? await readFile(resolve(values.notes), 'utf8') : '', publishedAt, expiresAt: publishedAt + 90 * 86400_000 }
if (manifest.notes.length > 4000) throw new Error('更新说明不能超过 4000 个字符。')
const payload = Buffer.from(JSON.stringify(manifest)), signature = sign(null, Buffer.concat([Buffer.from('webnav-update-v1\0'), payload]), privateKey).toString('base64')
const envelope = { payload: payload.toString('base64'), signature }
await atomicJson(join(output, 'feed.json'), envelope)
if (giteeRepository) await writeFile(join(output, 'release-description.md'), `小站 LittleDock ${version}\n\n${manifest.notes}\n\n下载便携包后解压，双击 LittleDock.vbs。已有安装版可在全局设置中更新。\n\n自动更新校验信息（请完整保留此代码块）：\n\n\`\`\`text\nWEBNAV_UPDATE_V1:${Buffer.from(JSON.stringify(envelope)).toString('base64')}\n\`\`\`\n`)
await atomicJson(join(portable, 'installation.json'), { schemaVersion: 1, current: version })
await atomicJson(join(portable, 'update-source.json'), source)
await mkdir(join(portable, 'runtime')); await cp(process.execPath, join(portable, 'runtime/node.exe'))
await atomicJson(join(portable, 'runtime/initial.json'), { version, sha256: await fileHash(process.execPath) })
// The initial portable ZIP needs one copy of Node. Bootstrap materializes the first release's runtime atomically.
await unlink(join(release, 'runtime/node.exe'))
await cp(join(root, 'backend/src/desktop/windows'), join(portable, 'launcher/windows'), { recursive: true })
for (const name of ['launch.mjs', 'Start-WebNav.ps1', 'WebNav.vbs', 'LittleDock.vbs']) await cp(join(root, 'scripts/distribution', name), join(portable, name))
await writeFile(join(portable, '使用说明.txt'), '双击 LittleDock.vbs 启动。退出请使用托盘。开机启动需在托盘显式勾选；已有勾选会迁移到此固定入口。\r\n安装更新在网页全局设置 → 工作台更新中操作。请勿移动正在运行的目录。\r\n首次从源码版迁移，请先完整退出旧工作台。用户数据继续使用原数据目录。\r\n')
const portableName = `LittleDock-${version}-windows-x64-portable.zip`
await zipDirectory(portable, join(output, portableName))
if (giteeRepository && (size > 100_000_000 || (await lstat(join(output, portableName))).size > 100_000_000)) throw new Error('附件超过 Gitee 普通仓库 100 MB 限制，请先减小发布包。')
await atomicJson(join(output, 'publish-plan.json'), { version, artifacts: [artifactName, `LittleDock-${version}-windows-x64-portable.zip`], feed: source.feed, order: ['版本包', 'feed.json'], uploaded: false })
console.log('正式版目录、便携安装包、签名更新包及发布清单已生成。尚未上传。')
