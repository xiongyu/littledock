import { posix } from 'node:path'
import ssh2 from 'ssh2'
export const linuxOutput=`Linux
atlas-dev
6.8.0
__CPU__
cpu 100 0 100 800 0 0 0 0
__MEM__
MemTotal: 16777216 kB
MemAvailable: 11534336 kB
__UP__
246600.00 1000.00
__LOAD__
0.24 0.18 0.12 1/200 100
__CORES__
8
__DISKS__
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 52428800 14680064 37748736 28% /
`
export function inspectorFixture(session,stats={},platform='linux'){
  session.on('exec',(accept,_reject,info)=>{
    stats.probes=(stats.probes??0)+1;const channel=accept()
    if(platform==='windows'){
      if(!info.command.startsWith('powershell.exe ')){channel.exit(1);channel.end();return}
      const output=Buffer.from(JSON.stringify({hostname:'DEV-WIN10',platform:'Microsoft Windows 10 专业版',uptime:24240,cpuCount:4,cpuPercent:3,memoryTotal:17072495001,memoryUsed:2147483648,load:'',disks:[{path:'C:',total:128849018880,used:37366215475}]}),'utf8')
      const split=output.indexOf(Buffer.from('专'))+1
      channel.write(output.subarray(0,split));channel.write(output.subarray(split))
    }else channel.write(linuxOutput)
    channel.exit(0);channel.end()
  })
  session.on('sftp',accept=>{
    stats.sftp=(stats.sftp??0)+1
    const stream=accept(),handles=new Map();let serial=0
    const attrs=(directory=false)=>({mode:(directory?0o040000:0o100000)|0o755,size:directory?0:4096,uid:1000,gid:1000,atime:1700000000,mtime:1700000000})
    stream.on('REALPATH',(id,path)=>stream.name(id,[{filename:posix.resolve('/home/fixture',path),longname:'',attrs:attrs(true)}]))
    stream.on('OPENDIR',(id,path)=>{if(path.includes('denied')){stream.status(id,ssh2.utils.sftp.STATUS_CODE.PERMISSION_DENIED);return}const handle=Buffer.from(String(++serial));handles.set(handle.toString(),{path,read:false});stream.handle(id,handle)})
    stream.on('READDIR',(id,handle)=>{
      const state=handles.get(handle.toString());if(!state||state.read){stream.status(id,ssh2.utils.sftp.STATUS_CODE.EOF);return}state.read=true
      const names=state.path==='/home/fixture'?['projects','deploy','README.md','package.json','server.ts','.env.example']:state.path.endsWith('/many')?Array.from({length:230},(_,i)=>'file-'+String(i).padStart(3,'0')):['notes.md','config.json']
      stream.name(id,names.map(name=>({filename:name,longname:name,attrs:attrs(['projects','deploy'].includes(name))})))
    })
    stream.on('CLOSE',(id,handle)=>{handles.delete(handle.toString());stream.status(id,ssh2.utils.sftp.STATUS_CODE.OK)})
  })
}
