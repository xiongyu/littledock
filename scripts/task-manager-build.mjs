import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'backend', 'native', 'task-manager')
const output = join(source, 'package')
const version = '0.3.1'
const targets = ['win32', 'linux', 'darwin'].flatMap(platform => ['x64', 'arm64'].map(arch => ({
  platform, arch, file: `${platform}-${arch}/webnav-collector${platform === 'win32' ? '.exe' : ''}`,
})))
const args = process.argv.slice(2)
if (args.some(arg => !['--verify', '--test'].includes(arg))) throw new Error('Usage: node scripts/task-manager-build.mjs [--verify | --test]')

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function verify() {
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.protocol !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== targets.length) {
    throw new Error('Invalid task-manager package manifest')
  }
  for (const target of targets) {
    const entries = manifest.artifacts.filter(entry => entry.platform === target.platform && entry.arch === target.arch)
    const entry = entries[0]
    if (entries.length !== 1 || entry.file !== target.file || !Number.isSafeInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`Invalid task-manager artifact: ${target.file}`)
    const path = join(output, entry.file)
    if (!statSync(path).isFile() || statSync(path).size !== entry.size || hash(path) !== entry.sha256) throw new Error(`Task-manager artifact failed integrity verification: ${entry.file}`)
  }
  console.log(`Task-manager ${version}: verified all ${targets.length} platform artifacts`)
}

if (args.includes('--verify')) {
  verify()
} else {
  const portableGo = join(source, '.native-deps', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
  const go = process.env.WEBNAV_GO || (existsSync(portableGo) ? portableGo : 'go')
  const cache = join(source, '.native-deps')
  mkdirSync(cache, { recursive: true })
  const environment = { ...process.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOMODCACHE: join(cache, 'gomod'), GOCACHE: join(cache, 'gocache') }
  function runGo(parameters, extraEnvironment = {}) {
    const result = spawnSync(go, parameters, { cwd: source, env: { ...environment, ...extraEnvironment }, stdio: 'inherit', windowsHide: true })
    if (result.error) throw new Error(`Go 1.26 or later is required; set WEBNAV_GO to its executable. ${result.error.message}`)
    if (result.status !== 0) throw new Error(`Collector build command failed (exit ${result.status})`)
  }
  function captureGo(parameters) {
    const result = spawnSync(go, parameters, { cwd: source, env: environment, encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error(`Unable to read Go dependency metadata: ${result.error?.message ?? result.stderr}`)
    return result.stdout.trim()
  }
  function packageLicenses() {
    const licenseDirectory = join(output, 'licenses')
    mkdirSync(licenseDirectory, { recursive: true })
    function copyLicense(from, to) {
      if (existsSync(to)) chmodSync(to, 0o644)
      writeFileSync(to, readFileSync(from), { mode: 0o644 })
    }
    const goRoot = captureGo(['env', 'GOROOT'])
    copyLicense(join(goRoot, 'LICENSE'), join(licenseDirectory, 'Go-LICENSE'))
    const notices = [`WebNav task-manager ${version}`, '', captureGo(['version']), 'Go runtime license: licenses/Go-LICENSE', '', 'Pinned modules and their original licenses:']
    const modules = captureGo(['list', '-m', '-f', '{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}', 'all']).split(/\r?\n/).filter(Boolean)
    for (const line of modules) {
      const [name, moduleVersion, directory] = line.split('|')
      if (!directory) continue
      const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'].find(file => existsSync(join(directory, file)))
      if (!license) throw new Error(`Missing third-party license for ${name}`)
      const file = `${name.replaceAll('/', '_')}-${license}`
      copyLicense(join(directory, license), join(licenseDirectory, file))
      notices.push(`${name} ${moduleVersion} — licenses/${file}`)
    }
    writeFileSync(join(output, 'THIRD-PARTY-NOTICES.txt'), `${notices.join('\n')}\n`)
  }
  if (args.includes('--test')) {
    runGo(['test', '-count=1', '-timeout=90s', './...'])
  } else {
    mkdirSync(output, { recursive: true })
    const artifacts = []
    for (const target of targets) {
      const destination = join(output, target.file)
      mkdirSync(dirname(destination), { recursive: true })
      const temporary = `${destination}.building`
      runGo(['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', temporary, '.'], {
        GOOS: target.platform === 'win32' ? 'windows' : target.platform,
        GOARCH: target.arch === 'x64' ? 'amd64' : target.arch,
      })
      renameSync(temporary, destination)
      artifacts.push({ ...target, sha256: hash(destination), size: statSync(destination).size })
      console.log(`Built ${target.platform}/${target.arch} (${statSync(destination).size} bytes)`)
    }
    const manifest = { schemaVersion: 1, version, protocol: 1, artifacts }
    packageLicenses()
    writeFileSync(join(output, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(join(output, 'manifest.json.tmp'), join(output, 'manifest.json'))
    verify()
  }
}
