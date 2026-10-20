import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { AppError } from '../core/errors.ts'

// Only this fixed program is executed. Connection values enter as JSON on stdin,
// never as PowerShell source, command-line arguments, or environment variables.
export const credentialWriterScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WebNavCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref Credential credential, uint flags);
  public static void Write(string target, string username, string password) {
    byte[] bytes = Encoding.Unicode.GetBytes(password);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Credential value = new Credential {
        Type = 1, TargetName = target, Comment = "WebNav RDP",
        CredentialBlobSize = (uint)bytes.Length, CredentialBlob = blob,
        Persist = 1, UserName = username
      };
      if (!CredWrite(ref value, 0)) throw new InvalidOperationException("Credential write failed");
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@ | Out-Null
  [WebNavCredential]::Write([string]$data.target, [string]$data.username, [string]$data.password)
  $data = $null
  [Console]::Out.Write('ok')
} catch { exit 1 }
`

export function rdpCredentialPayload(host: string, username: string, password: string) {
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || host.startsWith('-') ||
      !username.trim() || username.length > 100 || /[\r\n\0]/.test(username) ||
      !password || password.length > 1280 || password.includes('\0')) {
    throw new AppError('INVALID_ARGUMENT', 'RDP 地址、用户名或密码不正确。')
  }
  // mstsc's TERMSRV credential target is host-scoped, including on custom ports.
  return { target: `TERMSRV/${host.replace(/^\[|\]$/g, '')}`, username, password }
}

export async function writeRdpCredential(host: string, username: string, password: string) {
  const payload = rdpCredentialPayload(host, username, password)
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(credentialWriterScript, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    const fail = () => reject(new AppError('RDP_CREDENTIAL_FAILED', '无法向 Windows 远程桌面传递已保存的凭据。'))
    const timer = setTimeout(() => { child.kill(); fail() }, 15_000)
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(0, 64) })
    child.stdin.on('error', () => { /* Process exit below reports a sanitized error. */ })
    child.once('error', () => { clearTimeout(timer); fail() })
    child.once('close', code => { clearTimeout(timer); if (code === 0 && output === 'ok') resolve(); else fail() })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}
