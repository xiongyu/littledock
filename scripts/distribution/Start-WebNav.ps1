param([switch]$Console)
$ErrorActionPreference = 'Stop'
$runtimeNode = Join-Path $PSScriptRoot 'runtime/node.exe'
$entry = Join-Path $PSScriptRoot 'launch.mjs'
if ($Console) { & $runtimeNode $entry --console; exit $LASTEXITCODE }
Start-Process -FilePath $runtimeNode -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
