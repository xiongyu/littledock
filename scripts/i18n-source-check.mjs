import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(new URL('../frontend/package.json', import.meta.url))
const ts = require('typescript'), sfc = require('vue/compiler-sfc'), dom = createRequire(require.resolve('vue'))('@vue/compiler-dom')
const han = value => /\p{Script=Han}/u.test(value), errors = [], files = []
async function walk(directory) { for (const item of await readdir(join(root, directory), { withFileTypes: true })) { const path = directory + '/' + item.name; if (item.isDirectory()) { if (!['node_modules', 'locales', 'runtime', 'dist', 'windows'].includes(item.name)) await walk(path) } else if (/\.(ts|vue|js)$/.test(path) && !path.endsWith('.d.ts')) files.push(path) } }
await walk('frontend/src'); await walk('plugins'); await walk('examples/plugins')
let checked = 0
for (const file of files) {
  if (file.includes('/i18n') || (!file.startsWith('frontend/') && !file.endsWith('/src/frontend.ts') && !file.includes('/ui/') && !file.includes('/settings/'))) continue
  const content = await readFile(join(root, file), 'utf8'); let namespace = content.match(/pluginI18n\('([^']+)'\)/)?.[1], directory = dirname(join(root, file))
  if (!file.startsWith('frontend/')) { while (directory !== dirname(directory)) { try { namespace = JSON.parse(await readFile(join(directory, 'webnav.plugin.json'), 'utf8')).id; break } catch (error) { if (error.code !== 'ENOENT') throw error }; directory = dirname(directory) } }
  const catalogRoot = namespace === 'core' ? join(root, 'frontend/src') : namespace?.startsWith('builtin.') ? join(root, 'backend/plugins', namespace) : directory
  const dictionary = namespace ? JSON.parse(await readFile(join(catalogRoot, 'locales/zh-CN.json'), 'utf8')) : {}
  const report = (offset, reason) => errors.push(`${file}:${content.slice(0, offset).split('\n').length}: ${reason}`)
  function script(code, offset = 0) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
      if (ts.isPropertyAssignment(node)) { visit(node.initializer); return }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && han(node.text)) report(offset + node.getStart(source), 'Wrap UI text in the plugin translator')
      if (ts.isTemplateExpression(node) && han(node.head.text + node.templateSpans.map(span => span.literal.text).join(''))) report(offset + node.getStart(source), 'Use a translation with named parameters')
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'i18nT') {
        const key = node.arguments[0]; if (key && ts.isStringLiteral(key) && !Object.hasOwn(dictionary, key.text)) report(offset + node.getStart(source), `Unknown ${namespace} translation key: ${key.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (file.endsWith('.vue')) {
    const { descriptor } = sfc.parse(content)
    for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) script(block.content, block.loc.start.offset)
    if (descriptor.template) {
      const offset = descriptor.template.loc.start.offset
      function visit(node) {
        if (node.type === 2 && han(node.content)) report(offset + node.loc.start.offset, 'Wrap template text in the plugin translator')
        if (node.type === 5) script(node.content.content, offset + node.content.loc.start.offset)
        if (node.type === 1) for (const property of node.props) {
          if (property.type === 6 && property.value && han(property.value.content)) report(offset + property.loc.start.offset, 'Translate visible attribute text')
          else if (property.type === 7 && property.exp) script(property.exp.content, offset + property.exp.loc.start.offset)
        }
        for (const child of node.children ?? []) visit(child)
      }
      visit(dom.baseParse(descriptor.template.content))
    }
  } else script(content)
  checked++
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 } else console.log(`Checked translation calls and UI literals in ${checked} source files.`)
