import { spawn } from 'node:child_process'
import { powershell, psQuote } from '../src/plugins/task-manager/remote.ts'

// Win32-OpenSSH gives the child an OVERLAPPED stdin handle. Node's usual
// spawn(stdio: 'pipe') does not reproduce ConsoleStream's subsequent-read stall.
export function spawnWithSshStdin(command, env) {
  const native = 'using System;using System.Runtime.InteropServices;public static class PipeFixture{[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);[DllImport("kernel32.dll")] public static extern bool SetStdHandle(int n,IntPtr h);}'
  const script = `
Add-Type -TypeDefinition ${psQuote(native)}
$name='webnav-task-pipe-'+[Guid]::NewGuid().ToString('N')
$server=[IO.Pipes.NamedPipeServerStream]::new($name,[IO.Pipes.PipeDirection]::In,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,32768,32768,$null,[IO.HandleInheritability]::Inheritable)
$client=[IO.Pipes.NamedPipeClientStream]::new('.',$name,[IO.Pipes.PipeDirection]::Out,[IO.Pipes.PipeOptions]::Asynchronous)
$p=[Diagnostics.Process]::new()
$p.StartInfo.FileName='powershell.exe'
$p.StartInfo.Arguments=${psQuote(command.slice('powershell.exe '.length))}
$p.StartInfo.UseShellExecute=$false
$p.StartInfo.CreateNoWindow=$true
$p.StartInfo.RedirectStandardOutput=$true
$p.StartInfo.RedirectStandardError=$true
$started=$false
try {
  $connected=$server.WaitForConnectionAsync()
  $client.Connect(5000)
  [void]$connected.GetAwaiter().GetResult()
  $original=[PipeFixture]::GetStdHandle(-10)
  try {
    if(![PipeFixture]::SetStdHandle(-10,$server.SafePipeHandle.DangerousGetHandle())){throw 'SetStdHandle failed'}
    [void]$p.Start();$started=$true
  } finally {[void][PipeFixture]::SetStdHandle(-10,$original)}
  $output=$p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errors=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $inputCopy=[Console]::OpenStandardInput().CopyToAsync($client)
  [void]$inputCopy.GetAwaiter().GetResult()
  $client.Dispose()
  if(!$p.WaitForExit(5000)){throw 'SSH launcher did not exit after EOF'}
  [void]$output.GetAwaiter().GetResult();[void]$errors.GetAwaiter().GetResult()
  exit $p.ExitCode
} finally {
  $client.Dispose();$server.Dispose()
  if($started -and !$p.HasExited){$p.Kill()}
  $p.Dispose()
}`
  const args = powershell(script).split(' ')
  return spawn(args.shift(), args, { stdio: 'pipe', windowsHide: true, env })
}
