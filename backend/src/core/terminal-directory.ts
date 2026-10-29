import { StringDecoder } from 'node:string_decoder'

// Only observe directory reports and recognizable prompts. Never collect terminal input.
export class TerminalDirectoryTracker {
  private decoder=new StringDecoder('utf8')
  private tail=''
  private path=''
  private revision=0
  feed(bytes:Buffer){
    this.tail=(this.tail+this.decoder.write(bytes)).slice(-8192)
    for(const match of this.tail.matchAll(/\x1b\](?:7;([^\x07\x1b]+)|1337;CurrentDir=([^\x07\x1b]+))(?:\x07|\x1b\\)/g)){
      try{const path=match[1]?decodeURIComponent(new URL(match[1]).pathname):match[2]!;this.update(path)}catch{}
    }
    const plain=this.tail.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    const windows=plain.match(/(?:^|[\r\n])(?:[^\s]+@[^\s]+\s+)?(?:PS )?([A-Za-z]:[^\r\n<>|]*)>[ \t]*$/)
    if(windows)this.update('/'+windows[1]!.replaceAll('\\','/'))
    else{
      const unix=plain.match(/(?:^|[\r\n])[^\s:@]+@[^\s:]+(?::|\s+)(~(?:\/[^\r\n]*?)?|\/[^\r\n]*?)\s*[$#] ?$/)
      if(unix)this.update(unix[1]!)
    }
    // Preserve only the unfinished line/OSC for cross-chunk parsing.
    const newline=Math.max(this.tail.lastIndexOf('\n'),this.tail.lastIndexOf('\r'))
    if(newline>=0)this.tail=this.tail.slice(newline)
  }
  private update(path:string){if(path&&path.length<=4096&&!/[\x00-\x1f\x7f]/.test(path)&&(path.startsWith('/')||path==='~'||path.startsWith('~/'))&&path!==this.path){this.path=path;this.revision++}}
  snapshot(){return {path:this.path,revision:this.revision}}
}
