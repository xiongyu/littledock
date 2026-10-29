$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
if ($request.identity -notmatch '^[a-f0-9]{20}$') { throw 'Invalid identity' }
if ($request.action -eq 'open') {
    if ($request.url -notmatch '^http://127\.0\.0\.1:[0-9]{4,5}/$') { throw 'Invalid URL' }
    Start-Process -FilePath $request.url
    [Console]::WriteLine('true')
    exit
}
$startupDirectory = [Environment]::GetFolderPath('Startup')
if ($request.startupDirectory) { $startupDirectory = [string]$request.startupDirectory }
$shortcutPath = Join-Path $startupDirectory ('WebNav-' + $request.identity + '.lnk')
switch ($request.action) {
    'enable' {
        if (!(Test-Path -LiteralPath $request.launchFile -PathType Leaf)) { throw 'Missing launch configuration' }
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
        $shortcut.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $request.bootstrap + '" -ConfigFile "' + $request.launchFile + '"'
        $shortcut.WindowStyle = 7
        $shortcut.Description = 'WebNav'
        $shortcut.Save()
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    }
    'disable' { if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath } }
    'status' { }
    default { throw 'Unknown action' }
}
[Console]::WriteLine((Test-Path -LiteralPath $shortcutPath).ToString().ToLowerInvariant())
