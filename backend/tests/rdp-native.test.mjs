import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'
import { writeRdpCredential } from '../src/plugins/rdp-credentials.ts'

// Reads/deletes only the unique synthetic credential created by this test.
const verifyAndRemove = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VerifyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint Size;
    public IntPtr Blob;
    public uint Persist, Count;
    public IntPtr Attributes;
    public string Alias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode)]
  static extern bool Read(string name, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode)]
  static extern bool Delete(string name, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  public static bool VerifyAndRemove(string name, string user, string password) {
    IntPtr pointer = IntPtr.Zero;
    bool matched = false, removed = false;
    try {
      if (Read(name, 1, 0, out pointer)) {
        Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        matched = value.UserName == user && value.Persist == 1 &&
          Marshal.PtrToStringUni(value.Blob, (int)value.Size / 2) == password;
      }
    } finally {
      if (pointer != IntPtr.Zero) CredFree(pointer);
      removed = Delete(name, 1, 0);
    }
    return matched && removed;
  }
}
'@ | Out-Null
if ([VerifyCredential]::VerifyAndRemove([string]$data.target,[string]$data.username,[string]$data.password)) {
  [Console]::Out.Write('verified-and-removed')
} else { exit 1 }
`

test('Windows credential handoff preserves Unicode and shell characters, then removes only its test entry', { skip: process.platform !== 'win32' }, async () => {
  const host = `webnav-test-${randomUUID()}.invalid`, username = 'SYNTHETIC\\tester'
  const password = '测试 & " $(not-code) ` \\\\ synthetic'
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await writeRdpCredential(host,username,password)
  } finally {
    const result = execFileSync(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(verifyAndRemove,'utf16le').toString('base64')], {
      windowsHide:true, encoding:'utf8', input:JSON.stringify({target:`TERMSRV/${host}`,username,password}), stdio:['pipe','pipe','ignore'], timeout:15000,
    })
    assert.equal(result,'verified-and-removed')
  }
})
