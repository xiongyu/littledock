import type { WorkspaceProtocol } from './catalog.js'
export type WorkspaceLayout = {kind:'pane';sessionId:string} | {kind:'split';id:string;direction:'horizontal'|'vertical';ratio:number;first:WorkspaceLayout;second:WorkspaceLayout}
export interface WorkspaceGroup {id:string;focusedId:string;layout:WorkspaceLayout}
export interface WorkspaceView {groups:WorkspaceGroup[];active:string;floating:string[];minimized:string[]}
export interface WorkspaceSession {sessionId:string;serverId:string;connectionId:string;protocol:WorkspaceProtocol;name:string;connected:boolean}
export interface WorkspaceSnapshot {epoch:string;revision:number;sessions:WorkspaceSession[];view:WorkspaceView}
export const emptyWorkspaceView = ():WorkspaceView => ({groups:[],active:'',floating:[],minimized:[]})

/** Layout contains references only, never terminal bytes, credentials or remote content. */
export function parseWorkspaceView(input:unknown):WorkspaceView {
  const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('工作区格式无效。');return value as Record<string,unknown>}
  const text=(value:unknown):string=>{if(typeof value!=='string'||value.length>100)throw new Error('工作区标识无效。');return value}
  const list=(value:unknown):unknown[]=>{if(!Array.isArray(value)||value.length>8)throw new Error('工作区数量超限。');return value}
  let count=0;const panes=new Set<string>(),branches=new Set<string>()
  const layout=(value:unknown,depth=0):WorkspaceLayout=>{
    if(++count>24||depth>8)throw new Error('分屏层级超限。')
    const node=object(value)
    if(node.kind==='pane'){const id=text(node.sessionId);if(!id||panes.has(id))throw new Error('终端不能重复出现。');panes.add(id);return {kind:'pane',sessionId:id}}
    if(node.kind!=='split'||!['horizontal','vertical'].includes(String(node.direction))||typeof node.ratio!=='number'||!Number.isFinite(node.ratio)||node.ratio<20||node.ratio>80)throw new Error('分屏格式无效。')
    const id=text(node.id);if(!id||branches.has(id))throw new Error('分屏标识重复。');branches.add(id)
    return {kind:'split',id,direction:node.direction as 'horizontal'|'vertical',ratio:node.ratio,first:layout(node.first,depth+1),second:layout(node.second,depth+1)}
  }
  const p=object(input),groups=list(p.groups).map(value=>{const g=object(value);return {id:text(g.id),focusedId:text(g.focusedId),layout:layout(g.layout)}})
  if(new Set(groups.map(g=>g.id)).size!==groups.length)throw new Error('标签标识重复。')
  return {groups,active:text(p.active),floating:list(p.floating).map(text),minimized:list(p.minimized).map(text)}
}
export function parseWorkspaceSnapshot(input:unknown):WorkspaceSnapshot {
  if(!input||typeof input!=='object')throw new Error('工作区快照无效。')
  const p=input as Record<string,unknown>
  if(typeof p.epoch!=='string'||!Number.isSafeInteger(p.revision)||Number(p.revision)<0||!Array.isArray(p.sessions)||p.sessions.length>8)throw new Error('工作区快照无效。')
  const sessions=p.sessions.map(value=>{
    if(!value||typeof value!=='object')throw new Error('会话无效。')
    const s=value as Record<string,unknown>
    for(const key of ['sessionId','serverId','connectionId','name'])if(typeof s[key]!=='string'||String(s[key]).length>512)throw new Error('会话标识无效。')
    if(!['ssh','local','rdp','vnc','adb','wdb'].includes(String(s.protocol))||typeof s.connected!=='boolean')throw new Error('会话状态无效。')
    return s as unknown as WorkspaceSession
  })
  return {epoch:p.epoch,revision:Number(p.revision),sessions,view:parseWorkspaceView(p.view)}
}
