$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$rules = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'rules.json'), [Text.Encoding]::UTF8))
$runPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
function Read-Value($target) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($target.hive), [Microsoft.Win32.RegistryView]::$($target.view))
  try {
    $key = $base.OpenSubKey($target.path, $false)
    if ($null -eq $key) { return @{ exists = $false } }
    try {
      if ($key.GetValueNames() -notcontains [string]$target.name) { return @{ exists = $false } }
      $kind = [string]$key.GetValueKind($target.name)
      if (@('DWord','String','ExpandString') -notcontains $kind) { throw 'Unsupported registry type' }
      return @{ exists = $true; type = $kind; data = $key.GetValue($target.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Valid-Target($target) {
  if (@('CurrentUser','LocalMachine') -notcontains $target.hive -or @('Registry32','Registry64') -notcontains $target.view -or $target.path.Length -gt 300 -or $target.name.Length -gt 300) { throw 'Invalid target' }
  if ($target.path -eq $runPath) { return }
  if (-not ($rules | Where-Object { $_.path -eq $target.path -and $_.name -eq $target.name })) { throw 'Target is not allowed' }
}
function Same-Value($a, $b) { return ($a.exists -eq $b.exists -and ((-not $a.exists) -or ($a.type -eq $b.type -and $a.data -ceq $b.data))) }
function Stable-Id([string]$value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
}
function Snapshot {
  $items = New-Object 'System.Collections.Generic.List[object]'
  $coverage = New-Object 'System.Collections.Generic.List[string]'
  $warnings = New-Object 'System.Collections.Generic.List[string]'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $guid = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  $identity = Stable-Id "$guid/$sid"
  foreach ($hive in @('CurrentUser','LocalMachine')) { foreach ($view in @('Registry64','Registry32')) { foreach ($source in @('Run','RunOnce')) {
    $path = "Software\Microsoft\Windows\CurrentVersion\$source"
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
    try {
      $key = $base.OpenSubKey($path, $false)
      if ($null -ne $key) { try { foreach ($name in $key.GetValueNames() | Select-Object -First 1000) {
        $target = @{ hive = $hive; view = $view; path = $path; name = $name }
        try { $value = Read-Value $target } catch { continue }
        $command = [string]$value.data
        $own = ($name -match '(?i)webnav' -or $command -match '(?i)webnav')
        $writable = $hive -eq 'CurrentUser' -and $source -eq 'Run' -and $view -eq 'Registry64' -and (-not $own) -and @('String','ExpandString') -contains $value.type
        $items.Add(@{ id = Stable-Id "$identity/$hive/$view/$path/$name"; name = $name; category = 'startup'; source = "$hive / $view / $source"; state = 'registered'; writable = [bool]$writable; note = $(if ($own) {'Manage WebNav startup in the tray.'} elseif ($writable) {'Disable this registration; restore from encrypted journal.'} else {'Read-only source.'}); target = $target; before = $value; desired = @{ exists = $false }; details = $command })
      } } finally { $key.Dispose() } }
      $coverage.Add("$hive/$view/$source")
    } catch { $warnings.Add("Unable to read $hive/$view/$source") } finally { $base.Dispose() }
  } } }
  foreach ($folder in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
    try {
      if ([IO.Directory]::Exists($folder)) { foreach ($file in Get-ChildItem -LiteralPath $folder -File -Force | Select-Object -First 1000) {
        $items.Add(@{ id = Stable-Id "$identity/$($file.FullName)"; name = $file.Name; category = 'startup'; source = 'Startup folder'; state = 'registered'; writable = $false; note = 'Folder entries are read-only in this release.'; details = $file.FullName })
      } }
      $coverage.Add('Startup folder: ' + $folder)
    } catch { $warnings.Add('Startup folder unavailable') }
  }
  try { foreach ($service in Get-CimInstance Win32_Service -Filter "StartMode='Auto'" | Select-Object -First 1000) {
    $items.Add(@{ id = Stable-Id "$identity/service/$($service.Name)"; name = $service.DisplayName; category = 'startup'; source = 'Automatic service'; state = [string]$service.State; writable = $false; note = 'Read-only service'; details = $service.Name })
  }; $coverage.Add('Automatic services') } catch { $warnings.Add('Service enumeration unavailable') }
  try { foreach ($task in Get-ScheduledTask | Where-Object { @($_.Triggers | Where-Object { $_.CimClass.CimClassName -in @('MSFT_TaskBootTrigger','MSFT_TaskLogonTrigger') }).Count -gt 0 } | Select-Object -First 1000) {
    $items.Add(@{ id = Stable-Id "$identity/task/$($task.TaskPath)/$($task.TaskName)"; name = $task.TaskName; category = 'startup'; source = 'Startup task'; state = [string]$task.State; writable = $false; note = 'Read-only scheduled task'; details = $task.TaskPath })
  }; $coverage.Add('Boot/logon scheduled tasks visible to current user') } catch { $warnings.Add('Scheduled task enumeration unavailable') }
  foreach ($rule in $rules) {
    $target = @{ hive = 'CurrentUser'; view = 'Registry64'; path = $rule.path; name = $rule.name }
    try {
      $value = Read-Value $target
      $desired = @{ exists = $true; type = 'DWord'; data = $rule.value }
      $items.Add(@{ id = $rule.id; name = $rule.title; category = 'settings'; source = $rule.group; state = $(if (Same-Value $value $desired) {'configured'} elseif (-not $value.exists) {'not-set'} else {'custom'}); writable = [bool](-not (Same-Value $value $desired)); note = $rule.note; target = $target; before = $value; desired = $desired; details = "$($rule.path)/$($rule.name)" })
    } catch { $warnings.Add('Setting unavailable: ' + $rule.id) }
  }
  foreach ($hive in @('CurrentUser','LocalMachine')) { foreach ($view in @('Registry64','Registry32')) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view)
    try {
      $root = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
      if ($null -ne $root) { try { foreach ($name in $root.GetSubKeyNames() | Select-Object -First 2000) {
        $key = $root.OpenSubKey($name, $false)
        if ($null -eq $key) { continue }
        try { $display = [string]$key.GetValue('DisplayName',''); if ($display) {
          $items.Add(@{ id = Stable-Id "$identity/app/$hive/$view/$name"; name = $display; category = 'apps'; source = "$hive / $view"; state = 'installed'; writable = $false; note = ''; publisher = [string]$key.GetValue('Publisher',''); version = [string]$key.GetValue('DisplayVersion','') })
        } } finally { $key.Dispose() }
      } } finally { $root.Dispose() } }
    } catch { $warnings.Add('Application enumeration incomplete') } finally { $base.Dispose() }
  } }
  try { foreach ($app in Get-AppxPackage | Select-Object -First 1000) {
    $items.Add(@{ id = Stable-Id "$identity/appx/$($app.PackageFullName)"; name = $app.Name; category = 'apps'; source = 'Packaged application'; state = 'installed'; writable = $false; note = ''; publisher = $app.Publisher; version = [string]$app.Version })
  }; $coverage.Add('Current-user packaged applications') } catch { $warnings.Add('Packaged applications unavailable') }
  $warnings.Add('StartupApproved state, package startup tasks, signature and startup impact are not measured.')
  $warnings.Add('Enumeration is bounded: 1000 entries per startup source and packaged apps, 2000 entries per desktop-app registry source, 10000 entries total. Larger sources may be incomplete.')
  if ($items.Count -gt 10000) { $warnings.Add('Total enumeration truncated at 10000 entries.') }
  return @{ identity = $identity; computer = $env:COMPUTERNAME; user = [Environment]::UserName; build = [Environment]::OSVersion.Version.Build; scannedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); items = @($items.ToArray() | Select-Object -First 10000); coverage = $coverage.ToArray(); warnings = $warnings.ToArray() }
}
try {
  $request = ConvertFrom-Json ([Console]::In.ReadToEnd())
  $result = switch ($request.op) {
    'snapshot' { Snapshot; break }
    'read' { Valid-Target $request.target; Read-Value $request.target; break }
    'apply' {
      $target = $request.target; Valid-Target $target
      if ($target.hive -ne 'CurrentUser' -or $target.view -ne 'Registry64') { throw 'Write target is not allowed' }
      if ($target.path -eq $runPath -and $target.name -match '(?i)webnav') { throw 'WebNav startup is managed by the tray' }
      $current = Read-Value $target
      if (-not (Same-Value $current $request.expected)) { @{ status = 'conflict'; current = $current }; break }
      $desired = $request.desired
      if ($desired.exists -and (@('DWord','String','ExpandString') -notcontains $desired.type -or ([string]$desired.data).Length -gt 32768)) { throw 'Invalid value' }
      if ($target.path -ne $runPath -and $desired.exists -and $desired.type -ne 'DWord') { throw 'Invalid setting type' }
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
      try {
        $key = $base.CreateSubKey($target.path, $true)
        try { if ($desired.exists) { $value = $(if ($desired.type -eq 'DWord') { [int]$desired.data } else { [string]$desired.data }); $key.SetValue($target.name, $value, [Microsoft.Win32.RegistryValueKind]::$($desired.type)) } else { $key.DeleteValue($target.name, $false) }; $key.Flush() } finally { $key.Dispose() }
      } finally { $base.Dispose() }
      @{ status = 'applied'; current = (Read-Value $target) }; break
    }
    'protect' { Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($request.value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)); break }
    'unprotect' { Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($request.value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)); break }
    'open-settings' {
      $pages = @{ startup = 'ms-settings:startupapps'; apps = 'ms-settings:appsfeatures'; storage = 'ms-settings:storagesense' }
      if (-not $pages.ContainsKey([string]$request.page)) { throw 'Invalid settings page' }
      Start-Process -FilePath $pages[$request.page]; @{ opened = $true }; break
    }
    default { throw 'Unknown operation' }
  }
  @{ ok = $true; data = $result } | ConvertTo-Json -Depth 30 -Compress
} catch { @{ ok = $false; error = 'WINDOWS_OPERATION_FAILED' } | ConvertTo-Json -Compress; exit 1 }
