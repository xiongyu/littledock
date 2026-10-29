export type SplitDirection = 'horizontal' | 'vertical'
export interface WorkspaceEntry { sessionId: string; protocol: 'ssh' | 'rdp' | 'vnc' | 'local' | 'adb' | 'wdb'; detached?: boolean }
export type TerminalLayout = { kind: 'pane'; sessionId: string } | TerminalBranch
export interface TerminalBranch { kind: 'split'; id: string; direction: SplitDirection; ratio: number; first: TerminalLayout; second: TerminalLayout }
export interface TerminalGroup { id: string; layout: TerminalLayout; focusedId: string }
export interface LayoutRect { left: number; top: number; width: number; height: number }
export interface SplitHandle extends LayoutRect { branch: TerminalBranch; bounds: LayoutRect }

export function paneIds(layout: TerminalLayout): string[] {
  return layout.kind === 'pane' ? [layout.sessionId] : [...paneIds(layout.first), ...paneIds(layout.second)]
}
export function constrainSplitRatio(ratio: number) { return Math.max(20, Math.min(80, Number.isFinite(ratio) ? ratio : 50)) }

// A split replaces only the selected leaf. Existing branches and session IDs survive.
export function splitPane(layout: TerminalLayout, target: string, second: string, direction: SplitDirection, branchId: string): TerminalLayout {
  if (!paneIds(layout).includes(target) || paneIds(layout).includes(second)) throw new Error('分屏目标已经改变，请重新操作。')
  const insert = (node: TerminalLayout): TerminalLayout => node.kind === 'pane'
    ? node.sessionId === target ? { kind: 'split', id: branchId, direction, ratio: 50, first: node, second: { kind: 'pane', sessionId: second } } : node
    : { ...node, first: insert(node.first), second: insert(node.second) }
  return insert(layout)
}

export function filterLayout(layout: TerminalLayout, keep: (id: string) => boolean): TerminalLayout | undefined {
  if (layout.kind === 'pane') return keep(layout.sessionId) ? layout : undefined
  const first = filterLayout(layout.first, keep), second = filterLayout(layout.second, keep)
  if (!first || !second) return first ?? second
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second }
}

export function removePane(groups: readonly TerminalGroup[], id: string): TerminalGroup[] {
  return groups.flatMap(group => {
    const layout = filterLayout(group.layout, pane => pane !== id)
    return layout ? [{ ...group, layout, focusedId: group.focusedId === id ? paneIds(layout)[0]! : group.focusedId }] : []
  })
}

export function joinPane(groups: readonly TerminalGroup[], entries: readonly WorkspaceEntry[], target: string, second: string, direction: SplitDirection, branchId: string): TerminalGroup[] {
  if ([target, second].some(id => !entries.some(item => item.sessionId === id && item.protocol === 'ssh' && !item.detached))) throw new Error('只能对主页中的 SSH 终端分屏。')
  const destination = groups.find(group => paneIds(group.layout).includes(target))
  if (!destination || !groups.some(group => paneIds(group.layout).includes(second)) || paneIds(destination.layout).includes(second)) throw new Error('请选择其他标签中的 SSH 终端。')
  const layout = splitPane(destination.layout, target, second, direction, branchId)
  return removePane(groups, second).map(group => group.id === destination.id ? { ...group, layout, focusedId: target } : group)
}

export function replacePane(layout: TerminalLayout, oldId: string, newId: string): TerminalLayout {
  if (layout.kind === 'pane') return layout.sessionId === oldId ? { ...layout, sessionId: newId } : layout
  return { ...layout, first: replacePane(layout.first, oldId, newId), second: replacePane(layout.second, oldId, newId) }
}
export function setSplitRatio(layout: TerminalLayout, id: string, ratio: number): void {
  if (layout.kind === 'pane') return
  if (layout.id === id) layout.ratio = constrainSplitRatio(ratio)
  else { setSplitRatio(layout.first, id, ratio); setSplitRatio(layout.second, id, ratio) }
}

// Flat positioned views keep Vue/xterm instances alive even when the tree changes.
export function layoutGeometry(layout: TerminalLayout | undefined, width: number, height: number, minimized:ReadonlySet<string>=new Set()) {
  const panes = new Map<string, LayoutRect>(), handles: SplitHandle[] = []
  const collapsed=(node:TerminalLayout):boolean=>node.kind==='pane'?minimized.has(node.sessionId):collapsed(node.first)&&collapsed(node.second)
  const extent=(node:TerminalLayout,axis:'width'|'height'):number=>node.kind==='pane'?36:(node.direction==='horizontal'&&axis==='width'||node.direction==='vertical'&&axis==='height')?extent(node.first,axis)+6+extent(node.second,axis):Math.max(extent(node.first,axis),extent(node.second,axis))
  const visit = (node: TerminalLayout, bounds: LayoutRect) => {
    if (node.kind === 'pane') { panes.set(node.sessionId, bounds); return }
    const horizontal = node.direction === 'horizontal'
    const axis = horizontal ? 'width' : 'height', offset = horizontal ? 'left' : 'top'
    const gap = Math.min(6, bounds[axis]), available = bounds[axis] - gap
    const firstCollapsed=collapsed(node.first),secondCollapsed=collapsed(node.second)
    const firstSize = firstCollapsed?Math.min(available,extent(node.first,axis)):secondCollapsed?Math.max(0,available-extent(node.second,axis)):Math.round(available * constrainSplitRatio(node.ratio) / 100)
    const secondSize=secondCollapsed?Math.min(available-firstSize,extent(node.second,axis)):available-firstSize
    visit(node.first, { ...bounds, [axis]: firstSize })
    if(!firstCollapsed&&!secondCollapsed)handles.push({ ...bounds, [offset]: bounds[offset] + firstSize, [axis]: gap, branch: node, bounds })
    visit(node.second, { ...bounds, [offset]: bounds[offset] + firstSize + gap, [axis]: secondSize })
  }
  if (layout) visit(layout, { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, layout.kind==='pane'&&collapsed(layout)?Math.min(36,height):height) })
  return { panes, handles }
}
