param([Parameter(Mandatory = $true)][string]$ConfigFile)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($property in $config.environment.PSObject.Properties) {
    if ($property.Name -notin @('WEBNAV_DATA_DIR', 'WEBNAV_PORT', 'WEBNAV_UI_PORT', 'WEBNAV_RDP_ENABLED', 'WEBNAV_EDITOR_ENABLED', 'WEBNAV_EDITOR_PACKAGE_DIR', 'LOCALAPPDATA', 'XDG_STATE_HOME')) { throw 'Invalid environment key' }
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}
$arguments = @('--experimental-strip-types', ('"' + $config.entry + '"'))
Start-Process -FilePath $config.node -ArgumentList $arguments -WorkingDirectory $config.root -WindowStyle Hidden
