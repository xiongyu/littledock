import test from 'node:test'
import assert from 'node:assert/strict'
import { joinPane, paneIds, removePane, replacePane, filterLayout, layoutGeometry, setSplitRatio, constrainSplitRatio } from '../src/terminal-workspace.ts'
import { builtInTerminalThemes, defaultTerminalThemes, parseTerminalThemes, resolveTerminalTheme, parseCatalogImport } from '@webnav/shared'

const entry = sessionId => ({ sessionId, protocol: 'ssh' })
const group = id => ({ id: 'group-'+id, layout: { kind: 'pane', sessionId: id }, focusedId: id })
function threePanes() {
  const entries=['a','b','c'].map(entry)
  let groups=joinPane(['a','b','c'].map(group),entries,'a','b','horizontal','outer')
  return joinPane(groups,entries,'a','c','vertical','inner')
}
test('nested SSH panes share one tab; splitting the left pane preserves the right pane', () => {
  const groups=threePanes()
  assert.equal(groups.length,1); assert.equal(groups[0].id,'group-a')
  assert.deepEqual(paneIds(groups[0].layout),['a','c','b'])
  const {panes,handles}=layoutGeometry(groups[0].layout,1006,806)
  assert.deepEqual(panes.get('a'),{left:0,top:0,width:500,height:400})
  assert.deepEqual(panes.get('c'),{left:0,top:406,width:500,height:400})
  assert.deepEqual(panes.get('b'),{left:506,top:0,width:500,height:806})
  assert.equal(handles.length,2)
  setSplitRatio(groups[0].layout,'inner',25)
  assert.equal(layoutGeometry(groups[0].layout,1006,806).panes.get('a').height,200)
  assert.deepEqual(layoutGeometry(groups[0].layout,1006,806).panes.get('b'),panes.get('b'))
})
test('moving a pane between groups collapses the source; closing siblings preserves IDs and ratios', () => {
  let groups=threePanes()
  setSplitRatio(groups[0].layout,'outer',65)
  groups=joinPane([...groups,group('d')],['a','b','c','d'].map(entry),'d','c','horizontal','moved')
  assert.equal(groups.length,2); assert.deepEqual(paneIds(groups[0].layout),['a','b'])
  assert.equal(groups[0].layout.ratio,65);assert.deepEqual(paneIds(groups[1].layout),['d','c'])
  groups[0].layout=replacePane(groups[0].layout,'a','new-a')
  assert.equal(groups[0].layout.ratio,65); assert.deepEqual(paneIds(groups[0].layout),['new-a','b'])
  groups=removePane(groups,'new-a');assert.deepEqual(paneIds(groups[0].layout),['b'])
  for(const id of paneIds(groups[1].layout))groups=removePane(groups,id)
  assert.equal(groups.length,1);assert.deepEqual(paneIds(groups[0].layout),['b'])
  groups=removePane(groups,'b');assert.deepEqual(groups,[])
})
test('floating and detached panes retain group membership while visible layout fills the space', () => {
  const root=threePanes()[0].layout
  const visible=filterLayout(root,id=>id==='b')
  assert.deepEqual(layoutGeometry(visible,320,200).panes.get('b'),{left:0,top:0,width:320,height:200})
  assert.deepEqual(paneIds(root),['a','c','b'])
  assert.equal(filterLayout(root,()=>false),undefined)
  for(const size of [0,4,200,1000])for(const rect of layoutGeometry(root,size,size).panes.values()){
    assert.ok(rect.width>=0&&rect.height>=0)
    assert.ok(rect.left+rect.width<=size&&rect.top+rect.height<=size)
  }
})
test('minimizing a nested pane leaves its title and expands the sibling, then restores the original ratio',()=>{
  const root=threePanes()[0].layout
  setSplitRatio(root,'inner',40)
  const original=layoutGeometry(root,1006,806)
  const collapsed=layoutGeometry(root,1006,806,new Set(['c']))
  assert.equal(collapsed.panes.get('c').height,36);assert.equal(collapsed.panes.get('a').height,764)
  assert.deepEqual(collapsed.panes.get('b'),original.panes.get('b'))
  assert.equal(collapsed.handles.length,1)
  const side=layoutGeometry(root,1006,806,new Set(['b']))
  assert.equal(side.panes.get('b').width,36);assert.equal(side.panes.get('a').width,964)
  assert.deepEqual(layoutGeometry(root,1006,806).panes,original.panes)
  for(const size of [0,4,20,100])for(const rect of layoutGeometry(root,size,size,new Set(['a','b','c'])).panes.values())assert.ok(rect.width>=0&&rect.height>=0&&rect.left+rect.width<=size&&rect.top+rect.height<=size)
})
test('split targets reject desktops, detached panes, existing siblings and stale sessions', () => {
  const entries = ['a', 'b'].map(entry)
  entries.push({ sessionId: 'rdp', protocol: 'rdp' }, { sessionId: 'outside', protocol: 'ssh', detached: true })
  const groups=['a','b','rdp','outside'].map(group)
  for(const second of ['a','rdp','outside','missing'])assert.throws(()=>joinPane(groups,entries,'a',second,'horizontal','split'))
  const joined=joinPane(groups,entries,'a','b','horizontal','split')
  assert.throws(()=>joinPane(joined,entries,'a','b','vertical','again'))
  assert.throws(()=>joinPane(groups,entries,'missing','b','horizontal','split'))
  assert.equal(constrainSplitRatio(-5), 20); assert.equal(constrainSplitRatio(200), 80); assert.equal(constrainSplitRatio(NaN), 50)
})
test('terminal palettes validate all colors, retain a safe fallback, and reject duplicate IDs', () => {
  const custom = { ...structuredClone(builtInTerminalThemes[0]), id: 'custom', name: 'Custom' }
  const settings = { revision: 0, defaultId: 'custom', themes: [custom] }
  assert.deepEqual(parseTerminalThemes(settings), settings)
  assert.equal(resolveTerminalTheme(settings, 'deleted').id, 'custom')
  assert.equal(resolveTerminalTheme(defaultTerminalThemes()).id, 'forest')
  assert.throws(() => parseTerminalThemes({ ...settings, themes: [custom, custom] }))
  assert.throws(() => parseTerminalThemes({ ...settings, defaultId: 'missing' }))
  assert.throws(() => parseTerminalThemes({ ...settings, themes: [{ ...custom, colors: { ...custom.colors, red: 'url(https://example.invalid)' } }] }))
  assert.throws(() => parseTerminalThemes({ ...settings, themes: [{ ...custom, id: 'forest' }] }))
})
test('SSH theme choice survives catalog export/import and cannot be applied to another protocol', () => {
  const catalog = { schemaVersion: 1, groups: [], servers: [{ id: 's', name: 'Test', host: 'localhost', groupId: '', note: '', tags: [], favorite: false, connections: [{ id: 'c', type: 'ssh', name: 'SSH', port: 22, terminalThemeId: 'midnight' }] }] }
  assert.equal(parseCatalogImport(catalog).servers[0].connections[0].terminalThemeId, 'midnight')
  catalog.servers[0].connections[0].type = 'rdp'
  assert.throws(() => parseCatalogImport(catalog))
})
