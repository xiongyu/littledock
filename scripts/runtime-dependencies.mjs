import { cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

/** Materialize the already-installed production graph as ordinary files (no junctions in ZIPs). */
export async function copyRuntimeDependencies(project, destination) {
  const nodes = new Map()
  async function find(name, from) {
    for (const directory of createRequire(join(from, 'package.json')).resolve.paths(name) ?? []) {
      try { const path = await realpath(join(directory, name)); await readFile(join(path, 'package.json')); return path } catch { }
    }
    throw new Error(`运行依赖 ${name} 缺失，请先按锁文件安装并验证。`)
  }
  async function scan(source) {
    source = await realpath(source)
    if (nodes.has(source)) return nodes.get(source)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')), node = { source, manifest, dependencies: new Map() }
    nodes.set(source, node)
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
      let path
      try { path = await find(name, source) } catch (error) { if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue; throw error }
      node.dependencies.set(name, await scan(path))
    }
    return node
  }
  const graph = await scan(project), hoisted = new Map(graph.dependencies)
  for (const node of nodes.values()) for (const [name, dependency] of node.dependencies) if (!hoisted.has(name)) hoisted.set(name, dependency)
  await mkdir(destination, { recursive: true })
  let copies = 0
  async function materialize(node, path, scopes, ancestors) {
    if (++copies > 300 || ancestors.length > 20) throw new Error('依赖图不能安全展开为便携目录。')
    await mkdir(path, { recursive: true })
    if (node.manifest.name === '@webnav/shared') {
      await cp(join(node.source, 'package.json'), join(path, 'package.json'))
      await cp(join(node.source, 'dist'), join(path, 'dist'), { recursive: true })
    } else await cp(node.source, path, { recursive: true, dereference: true, filter: source => resolve(source) !== resolve(node.source, 'node_modules') })
    const local = new Map()
    for (const [name, dependency] of node.dependencies) {
      const resolved = scopes.find(scope => scope.has(name))?.get(name)
      if (resolved !== dependency) local.set(name, dependency)
    }
    for (const [name, dependency] of local) {
      if (ancestors.includes(dependency)) throw new Error('依赖包含冲突版本的循环，不能发布。')
      await materialize(dependency, join(path, 'node_modules', name), [local, ...scopes], [...ancestors, node])
    }
  }
  for (const [name, node] of hoisted) await materialize(node, join(destination, name), [hoisted], [])
  return [...nodes.values()].filter(node=>node!==graph).map(node=>({name:node.manifest.name,version:node.manifest.version})).sort((a,b)=>a.name.localeCompare(b.name))
}
