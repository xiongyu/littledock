# Native control regression: compile the shipped tray and inspect its actual tooltip/menu state.
param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path $Source -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
$flags=[System.Reflection.BindingFlags]'Instance,NonPublic'
$type=[WebNav.TrayHost]
$brandImagePath = Join-Path (Split-Path -Parent $Source) 'littledock-otter-icon.png'
if (!(Test-Path -LiteralPath $brandImagePath)) { throw 'Tray brand image is missing' }
$hostContext=$type.GetConstructor($flags,$null,[Type[]]@([string]),$null).Invoke(@([string]$brandImagePath))
try {
  $queue=$type.GetField('messages',$flags).GetValue($hostContext)
  $icon=$type.GetField('icon',$flags).GetValue($hostContext)
  $menuStatus=$type.GetField('sessions',$flags).GetValue($hostContext)
  foreach($escaped in @('\u6682\u65e0\u8fd0\u884c','SSH 2 \u00b7 RDP 1','SSH 0 \u00b7 RDP 0 \u00b7 \u672c\u5730\u7ec8\u7aef 1','\u6682\u65e0\u8fd0\u884c')) {
    $summary=[Regex]::Unescape($escaped)
    $queue.Enqueue((@{type='state';state='running';autoStart=$false;sessionSummary=$summary}|ConvertTo-Json -Compress))
    $type.GetMethod('Drain',$flags).Invoke($hostContext,@()) | Out-Null
    $heading=[Regex]::Unescape('\u5c0f\u7ad9 \u00b7 LittleDock \u00b7 \u8fd0\u884c\u4e2d')
    if($icon.Text -ne "$heading`n$summary" -or $menuStatus.Text -ne $summary){throw "Tray summary mismatch: $($icon.Text) / $($menuStatus.Text)"}
  }
  [Console]::WriteLine('native-tray-summary-passed')
} finally { $hostContext.ExitThread() }
