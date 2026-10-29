$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'tray.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions
[WebNav.TrayHost]::Run((Join-Path $PSScriptRoot 'littledock-otter-icon.png'))
