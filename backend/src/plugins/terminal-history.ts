import { Service, type Context } from 'cordis'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statfsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { AppError, integer, record, string } from '../core/errors.ts'

// A bounded text transcript. Control sequences are consumed across chunks, never replayed.
export class TextTranscript {
  private decoder = new StringDecoder('utf8')
  private state: 'text'|'esc'|'csi'|'string'|'string-esc' = 'text'
  private line = ''
  private cursor = 0
  feed(bytes: Buffer): string {
    let result = ''
    for (const char of this.decoder.write(bytes)) {
      if (this.state === 'string') { if (char === '\x07') this.state = 'text'; else if (char === '\x1b') this.state = 'string-esc'; continue }
      if (this.state === 'string-esc') { this.state = char === '\\' ? 'text' : 'string'; continue }
      if (this.state === 'csi') { if (char >= '@' && char <= '~') this.state = 'text'; continue }
      if (this.state === 'esc') { this.state = char === '[' ? 'csi' : [']','P','^','_','X'].includes(char) ? 'string' : 'text'; continue }
      if (char === '\x1b') { this.state = 'esc'; continue }
      if (char === '\r') { this.cursor = 0; continue }
      if (char === '\b') { this.cursor = Math.max(0,this.cursor-1); continue }
      if (char === '\n') { result += this.line + '\n'; this.line = ''; this.cursor = 0; continue }
      if (char < ' ' && char !== '\t' || char === '\x7f') continue
      this.line = this.line.slice(0,this.cursor) + char + this.line.slice(this.cursor + char.length); this.cursor += char.length
      if (this.line.length >= 4096) { result += this.line; this.line = ''; this.cursor = 0 }
    }
    return result
  }
  flush() { const tail = this.feed(Buffer.from(this.decoder.end())); const line = this.line; this.line=''; this.cursor=0; return tail+line }
}
declare module 'cordis' { interface Context { terminalHistory: TerminalHistoryService } }
export class TerminalHistoryService extends Service {
  static inject = ['storage']
  db: Database.Database
  private parsers = new Map<string, TextTranscript>()
  private bytes = new Map<string,number>()
  private failed = new Set<string>()
  constructor(ctx: Context) {
    super(ctx, 'terminalHistory', true)
    this.db = new Database(join(ctx.storage.directory,'terminal-history.sqlite'))
    this.db.pragma('journal_mode=WAL'); this.db.pragma('auto_vacuum=INCREMENTAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, server_id TEXT, name TEXT, started INTEGER, ended INTEGER, incomplete INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunks (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, text TEXT, bytes INTEGER);
      CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id,seq);`)
    this.db.prepare('UPDATE sessions SET ended=?,incomplete=1 WHERE ended IS NULL').run(Date.now())
    this.clean()
    const timer = setInterval(() => { try { this.clean() } catch { /* Recording reports its own failure; cleanup retries later. */ } },60_000)
    ctx.on('dispose', () => { clearInterval(timer); for (const id of this.parsers.keys()) this.close(id); if(this.db.open){this.db.pragma('wal_checkpoint(TRUNCATE)');this.db.close()} })
  }
  open(id:string,serverId:string,name:string) { this.db.prepare('INSERT INTO sessions(id,server_id,name,started) VALUES (?,?,?,?)').run(id,serverId,name,Date.now());this.parsers.set(id,new TextTranscript());this.bytes.set(id,0) }
  append(id:string, bytes:Buffer) { const parser=this.parsers.get(id);if(!parser || this.failed.has(id)) return;this.write(id,parser.feed(bytes)) }
  private write(id:string,text:string) {
    if(!text) return
    try {
      const size=Buffer.byteLength(text), total=(this.bytes.get(id)??0)+size
      if(total>100*1024*1024) throw new Error('Session limit')
      const space=statfsSync(this.ctx.storage.directory);if(space.bavail*space.bsize<100*1024*1024) throw new Error('Disk space')
      this.db.transaction(() => {
        // Bound each query record even if a connector delivers a large output chunk.
        for (let start = 0; start < text.length;) {
          let end = Math.min(start + 16 * 1024, text.length)
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
          const part = text.slice(start, end)
          this.db.prepare('INSERT INTO chunks(session_id,text,bytes) VALUES (?,?,?)').run(id,part,Buffer.byteLength(part))
          start = end
        }
      })();this.bytes.set(id,total)
    } catch { this.failed.add(id);try{this.db.prepare('UPDATE sessions SET incomplete=1 WHERE id=?').run(id)}catch{} }
  }
  close(id:string) { const parser=this.parsers.get(id);if(!parser)return;this.write(id,parser.flush());this.parsers.delete(id);this.bytes.delete(id);this.failed.delete(id);this.db.prepare('UPDATE sessions SET ended=? WHERE id=?').run(Date.now(),id) }
  clean() {
    this.db.transaction(()=>{
      const expired=this.db.prepare('SELECT id FROM sessions WHERE ended IS NOT NULL AND started<?').all(Date.now()-7*86400_000) as {id:string}[]
      for(const row of expired){this.db.prepare('DELETE FROM chunks WHERE session_id=?').run(row.id);this.db.prepare('DELETE FROM sessions WHERE id=?').run(row.id)}
      let total=(this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM chunks').get() as {n:number}).n
      while(total>1024**3){const row=this.db.prepare('SELECT seq,session_id,bytes FROM chunks ORDER BY seq LIMIT 1').get() as {seq:number;session_id:string;bytes:number}|undefined;if(!row)break;this.db.prepare('DELETE FROM chunks WHERE seq=?').run(row.seq);this.db.prepare('UPDATE sessions SET incomplete=1 WHERE id=?').run(row.session_id);total-=row.bytes}
    })();this.db.pragma('wal_checkpoint(PASSIVE)');this.db.pragma('incremental_vacuum(1000)')
  }
  list(serverId:string) { return this.db.prepare('SELECT id,name,started,ended,incomplete FROM sessions WHERE server_id=? ORDER BY started DESC LIMIT 100').all(serverId) }
  range(sessionId:string) {
    if(!this.db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId))throw new AppError('NOT_FOUND','记录不存在或已清理。')
    return this.db.prepare('SELECT coalesce(min(seq),0) AS lower,coalesce(max(seq),0) AS upper FROM chunks WHERE session_id=?').get(sessionId) as {lower:number;upper:number}
  }
  page(input:unknown,range:{sessionId:string;lower:number;upper:number}) {
    const params=record(input), after=integer(params.after??0,0,Number.MAX_SAFE_INTEGER), search=string(params.search??'',256,true)
    const retained=this.range(range.sessionId)
    if(range.lower && (!retained.lower || retained.lower>range.lower))throw new AppError('HISTORY_RANGE_EXPIRED','这段历史已被清理，请刷新查询。')
    const batch=this.db.prepare('SELECT seq,text FROM chunks WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 400').all(range.sessionId,Math.max(after,range.lower-1),range.upper) as {seq:number;text:string}[]
    const rows:typeof batch=[];let bytes=0,cursor=after
    const needle=search.toLocaleLowerCase(), overlap=Math.max(0,search.length-1)
    let prefix=overlap ? ((this.db.prepare('SELECT text FROM chunks WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(range.sessionId,range.lower,after) as {text:string}|undefined)?.text.slice(-overlap)??'') : ''
    for(const row of batch){
      const joined=prefix+row.text
      const matched=!search || joined.toLocaleLowerCase().includes(needle)
      const displayed=search ? joined.split('\n').filter(line=>line.toLocaleLowerCase().includes(needle)).join('\n')+'\n' : row.text
      if(matched){const result={seq:row.seq,text:displayed};const size=Buffer.byteLength(JSON.stringify(result));if(bytes+size>200*1024 || rows.length>=100)break;rows.push(result);bytes+=size}
      prefix=overlap ? joined.slice(-overlap) : '';cursor=row.seq
    }
    return {rows,after:cursor,done:cursor>=range.upper||batch.length===0,incomplete:!!(this.db.prepare('SELECT incomplete FROM sessions WHERE id=?').get(range.sessionId) as {incomplete:number}).incomplete}
  }
}
