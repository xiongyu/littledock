import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Client, ClientChannel } from 'ssh2'
import type { EditorPlatform } from '@webnav/shared'
import type { RemoteFs } from '../ssh-files/remote-fs.ts'
import type { EditorPackage } from './packages.ts'

export const shQuote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'"
export const psQuote=(value:string)=>"'"+value.replace(/'/g,"''")+"'"
export const windowsPath=(value:string)=>value.replace(/^\/([a-z]:)/i,'$1').replace(/\//g,'\\')
export const powershell=(script:string)=>'powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '+Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+script,'utf16le').toString('base64')

export function execRemote(client:Client,command:string,signal:AbortSignal,timeout=15_000,outputMode:'capture'|'drain'='capture'):Promise<string> {
  return new Promise((resolve,reject)=>{
    let stream:ClientChannel|undefined,done=false,output='',size=0,diagnostic=''
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);client.off('close',abort);stream?.close();if(error)reject(error);else resolve(output)}
    const abort=()=>finish(new Error('SSH 连接已结束。')),timer=setTimeout(()=>finish(new Error('远端操作超时。')),timeout)
    signal.addEventListener('abort',abort,{once:true});client.once('close',abort);if(signal.aborted){abort();return}
    client.exec(command,(error,ch)=>{if(done){ch?.close();return}if(error){finish(error);return}stream=ch
      ch.on('data',(chunk:Buffer)=>{if(done||outputMode==='drain')return;size+=chunk.length;if(size>64*1024)finish(new Error('远端响应过大。'));else output+=chunk.toString('utf8')})
      // Progress and warnings are not command results. Always drain stderr,
      // retaining only a bounded diagnostic tail for a nonzero exit.
      ch.stderr.on('data',(chunk:Buffer)=>{if(!done)diagnostic=(diagnostic+chunk.toString('utf8')).slice(-4096)})
      ch.on('error',()=>finish(new Error('远端命令执行失败。')))
      ch.on('close',(code:number|null,exitSignal?:string)=>{
        if(code!==0){const detail=diagnostic.replace(/[\x00-\x08\x0b-\x1f\x7f]/g,' ').trim().slice(-1200);finish(new Error(`远端命令执行失败（${code??exitSignal??'未返回退出状态'}）${detail?'：'+detail:'。'}`))}
        else finish()
      })
    })
  })
}
export async function detectPlatform(client:Client,signal:AbortSignal):Promise<EditorPlatform> {
  let text=''
  try{text=await execRemote(client,'uname -s; uname -m',signal)}catch{signal.throwIfAborted()}
  if(text.startsWith('Linux')){if(/\bx86_64\b/.test(text))return 'linux-x64';if(/\b(aarch64|arm64)\b/.test(text))return 'linux-arm64';throw new Error('暂支持 Linux x64 / ARM64。')}
  const arch=(await execRemote(client,powershell("[Console]::WriteLine($(if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}))"),signal)).trim()
  if(arch==='AMD64')return 'windows-x64';if(arch==='ARM64')return 'windows-arm64'
  throw new Error('暂支持 Linux 与 Windows 的 x64 / ARM64 系统。')
}
export async function mkdirs(fs:RemoteFs,home:string,parts:string[]) { let path=home;for(const part of parts){path=posix.join(path,part);await fs.ensureDirectory(path)}return path }
export async function putFile(fs:RemoteFs,path:string,data:Buffer) { const h=await fs.open(path,'w',0o600);try{await fs.write(h,data,0)}finally{await fs.close(h)} }
export async function uploadPackage(fs:RemoteFs,source:string,target:string,signal:AbortSignal,report:(percent:number)=>void) {
  const total=(await stat(source)).size,h=await fs.open(target,'w',0o600);let offset=0,last=-1
  try{for await(const raw of createReadStream(source,{highWaterMark:128*1024})){signal.throwIfAborted();const bytes=Buffer.from(raw);await fs.write(h,bytes,offset);offset+=bytes.length;const percent=Math.floor(offset/total*100);if(percent!==last){last=percent;report(percent)}}}
  finally{await fs.close(h).catch(()=>{})}
}
export function installCommand(pkg:EditorPackage,archive:string,stage:string,destination:string) {
  const marker=JSON.stringify({sha256:pkg.sha256,licenseAccepted:!!pkg.licenseUrl})
  // Commit the marker inside the extracted tree before moving it into place.
  // A lost SSH response must not leave a complete installation unrecognizable.
  if(pkg.platform.startsWith('windows'))return powershell(`$archive=[IO.Path]::GetFullPath(${psQuote(windowsPath(archive))}); $stage=[IO.Path]::GetFullPath(${psQuote(windowsPath(stage))}); $dest=[IO.Path]::GetFullPath(${psQuote(windowsPath(destination))}); $parent=[IO.Path]::GetFullPath(${psQuote(windowsPath(posix.dirname(destination)))}); foreach($path in @($archive,$stage,$dest)){if(![IO.Path]::GetDirectoryName($path).Equals($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid install path'}}; if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne '${pkg.sha256}'){throw 'checksum'}; Expand-Archive -LiteralPath $archive -DestinationPath $stage; $root=Join-Path $stage '${pkg.root}'; if(!(Test-Path -LiteralPath (Join-Path $root 'node.exe')) -or !(Test-Path -LiteralPath (Join-Path $root 'out/server-main.js'))){throw 'package layout'}; [IO.File]::WriteAllText((Join-Path $root 'webnav-install.json'),${psQuote(marker)},[Text.UTF8Encoding]::new($false)); if(Test-Path -LiteralPath $dest){$existing=Get-Item -LiteralPath $dest -Force; if(!$existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath (Join-Path $dest 'webnav-install.json'))){throw 'Existing installation changed; reopen the editor'}; $backup=$dest+'.incomplete-'+[IO.Path]::GetFileName($stage); if(![IO.Path]::GetDirectoryName($backup).Equals($parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid backup path'}; Move-Item -LiteralPath $dest -Destination $backup}; Move-Item -LiteralPath $root -Destination $dest; Remove-Item -LiteralPath $stage; Remove-Item -LiteralPath $archive;`)
  const root=posix.join(stage,pkg.root),backup=destination+'.incomplete-'+posix.basename(stage)
  return `set -eu; test "$(sha256sum ${shQuote(archive)} | cut -d ' ' -f 1)" = ${shQuote(pkg.sha256)}; mkdir ${shQuote(stage)}; tar -xzf ${shQuote(archive)} -C ${shQuote(stage)}; test -x ${shQuote(posix.join(root,'bin/code-server'))}; printf %s ${shQuote(marker)} > ${shQuote(posix.join(root,'webnav-install.json'))}; if test -e ${shQuote(destination)} || test -L ${shQuote(destination)}; then test -d ${shQuote(destination)}; test ! -L ${shQuote(destination)}; test ! -e ${shQuote(posix.join(destination,'webnav-install.json'))}; test ! -e ${shQuote(backup)}; mv ${shQuote(destination)} ${shQuote(backup)}; fi; mv ${shQuote(root)} ${shQuote(destination)}; rmdir ${shQuote(stage)}; rm -f ${shQuote(archive)}`
}
export function launchCommand(pkg:EditorPackage,install:string,data:string,run:string) {
  const heartbeat=posix.join(run,'heartbeat')
  if(pkg.platform.startsWith('windows')){
    // Redirect through pipes, never write server output or token-bearing URLs into logs.
    const args=['"'+windowsPath(posix.join(install,'out/server-main.js'))+'"','--start-server','--host','127.0.0.1','--port','0','--connection-token-file','"'+windowsPath(posix.join(run,'token'))+'"','--server-data-dir','"'+windowsPath(data)+'"','--accept-server-license-terms','--disable-telemetry'].join(' ')
    return powershell(`$heartbeat=${psQuote(windowsPath(heartbeat))}; $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=${psQuote(windowsPath(posix.join(install,'node.exe')))}; $info.Arguments=${psQuote(args)}; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $p=[Diagnostics.Process]::new(); $p.StartInfo=$info; $null=$p.Start(); try { $out=$p.StandardOutput.ReadLineAsync(); $err=$p.StandardError.ReadLineAsync(); while(!$p.HasExited){ if($out -and $out.IsCompleted){$line=$out.Result;if($null -ne $line){[Console]::WriteLine($line);$out=$p.StandardOutput.ReadLineAsync()}else{$out=$null}}; if($err -and $err.IsCompleted){$line=$err.Result;if($null -ne $line){[Console]::Error.WriteLine($line);$err=$p.StandardError.ReadLineAsync()}else{$err=$null}}; if(!(Test-Path -LiteralPath $heartbeat) -or ((Get-Date).ToUniversalTime()-(Get-Item -LiteralPath $heartbeat).LastWriteTimeUtc).TotalSeconds -gt 45){break}; Start-Sleep -Milliseconds 100 } } finally { if(!$p.HasExited){& "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F 2>$null | Out-Null}; $p.Dispose() }`)
  }
  const script=`set -eu\ncommand -v setsid >/dev/null\nsetsid ${shQuote(posix.join(install,'bin/code-server'))} --config ${shQuote(posix.join(run,'config.yaml'))} --user-data-dir ${shQuote(data)} --extensions-dir ${shQuote(posix.join(data,'extensions'))} &\nchild=$!\ntrap 'kill -TERM -- -"$child" 2>/dev/null || true' EXIT HUP INT TERM\nwhile kill -0 "$child" 2>/dev/null; do\n test -f ${shQuote(heartbeat)} || break\n now=$(date +%s); touched=$(stat -c %Y ${shQuote(heartbeat)}); test "$((now-touched))" -le 45 || break\n sleep 2\ndone`
  return 'bash -c '+shQuote(script)
}
export function listeningPort(output:string):number|undefined {
  const text=output.replace(/\x1b\[[0-9;]*m/g,'')
  const match=text.match(/HTTP server listening on https?:\/\/127\.0\.0\.1:(\d+)/i)??text.match(/Extension host agent listening on (\d+)/i)
  const port=Number(match?.[1]);return Number.isInteger(port)&&port>0&&port<=65535?port:undefined
}
