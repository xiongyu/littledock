import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'
import {powershell} from '../src/desktop/windows.ts'

test('shipped WinForms tray renders live counts and zero in both tooltip and menu',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const script=fileURLToPath(new URL('./tray-summary.ps1',import.meta.url)),source=fileURLToPath(new URL('../src/desktop/windows/tray.cs',import.meta.url))
  const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script,'-Source',source],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  t.after(()=>{if(child.exitCode===null)child.kill()})
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
  const [code]=await once(child,'exit');assert.equal(code,0,output);assert.match(output,/native-tray-summary-passed/)
})
