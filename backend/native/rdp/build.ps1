param([string]$Perl = 'perl.exe', [string]$Generator = 'Visual Studio 18 2026', [switch]$TestPeer)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$deps = Join-Path $project '.native-deps'
$cmake = (Get-Command cmake.exe -ErrorAction SilentlyContinue).Source
if (!$cmake) { $cmake = 'C:\Program Files\CMake\bin\cmake.exe' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs -or !(Test-Path $cmake)) { throw '源码编译需要 Visual Studio C++ Build Tools 和 CMake；普通启动不需要编译。' }
$perlPath = (Get-Command $Perl -ErrorAction Stop).Source
New-Item -ItemType Directory -Force $deps | Out-Null
function Source([string]$Name, [string]$Url, [string]$Hash, [string]$Folder) {
  $archive = Join-Path $deps $Name
  if (!(Test-Path $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $Hash) {
    & curl.exe -L --fail --retry 3 $Url -o $archive
    if ($LASTEXITCODE -ne 0) { throw "下载失败：$Name" }
  }
  if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $Hash) { throw "源码校验失败：$Name" }
  if (!(Test-Path (Join-Path $deps $Folder))) { & tar.exe -xf $archive -C $deps; if ($LASTEXITCODE -ne 0) { throw '源码解压失败' } }
}
Source 'freerdp-source.zip' 'https://codeload.github.com/FreeRDP/FreeRDP/zip/refs/tags/3.32.2' '49BDFE90DDFBC1152FF8EBBB2F81EDFF0C753533119FBFC76A5A5A8236F1B5D7' 'FreeRDP-3.32.2'
Source 'openssl-3.5.9.tar.gz' 'https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz' '603F5602E2EEF00D77FBD429D34DCD5822BB301757A1BC9CDB24C670F1EB859A' 'openssl-3.5.9'
$ssl = (Join-Path $deps 'openssl-install').Replace('\','/')
# Use native Windows Perl (for example Strawberry Perl), not Git's MSYS Perl.
$build = @"
@echo off
call "$vs\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
set "PATH=$(Split-Path $perlPath);%PATH%"
set "LC_ALL=C"
cd /d "$deps\openssl-3.5.9"
"$perlPath" Configure VC-WIN64A no-shared no-tests no-asm no-module --prefix="$ssl" --openssldir="$ssl/ssl"
if errorlevel 1 exit /b 1
nmake /nologo
if errorlevel 1 exit /b 1
nmake /nologo install_sw
"@
$batch = Join-Path $deps 'build-webnav-openssl.cmd'
Set-Content -LiteralPath $batch -Value $build -Encoding ascii
& $batch
if ($LASTEXITCODE -ne 0) { throw 'OpenSSL 编译失败' }
$install = (Join-Path $deps 'freerdp-install').Replace('\','/')
& $cmake --preset minimal-client -S "$deps/FreeRDP-3.32.2" -B "$deps/freerdp-build" -G $Generator -A x64 `
  -DCMAKE_C_STANDARD=11 -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DBUILD_SHARED_LIBS=OFF "-DCMAKE_INSTALL_PREFIX=$install" `
  -DWITH_OPENSSL=ON -DWITH_MBEDTLS=OFF "-DOPENSSL_ROOT_DIR=$ssl" -DOPENSSL_USE_STATIC_LIBS=TRUE -DOPENSSL_MSVC_STATIC_RT=TRUE `
  -DWITH_SMARTCARD_EMULATE=OFF -DWITH_CLIENT=OFF -DWITH_X11=OFF -DWITH_CLIENT_SDL=OFF -DWITH_CLIENT_COMMON=ON `
  -DWITH_SAMPLE=OFF -DWITH_SERVER=OFF -DWITH_PROXY=OFF -DWITH_PROXY_MODULES=OFF -DWITH_WINPR_TOOLS=OFF `
  -DWITH_AAD=OFF -DWITH_NATIVE_SSPI=ON -DWITH_MEDIA_FOUNDATION=ON -DBUILD_TESTING=OFF -DWITH_ZLIB=OFF `
  -DWITH_CHANNELS=ON -DCHANNEL_URBDRC=OFF -DCHANNEL_RDPECAM=OFF -DCHANNEL_SSHAGENT=OFF -DCHANNEL_RDP2TCP=OFF -DCHANNEL_PRINTER=OFF -DWITH_WEBVIEW=OFF
if ($LASTEXITCODE -ne 0) { throw 'FreeRDP 配置失败' }
& $cmake --build "$deps/freerdp-build" --config Release --target install --parallel 8
if ($LASTEXITCODE -ne 0) { throw 'FreeRDP 编译失败' }
$peer = if ($TestPeer) { 'ON' } else { 'OFF' }
& $cmake -S $PSScriptRoot -B "$PSScriptRoot/build" -G $Generator -A x64 "-DCMAKE_PREFIX_PATH=$install;$ssl" "-DWEBNAV_BUILD_TEST_PEER=$peer"
if ($LASTEXITCODE -ne 0) { throw 'RDP 组件配置失败' }
& $cmake --build "$PSScriptRoot/build" --config Release --parallel 8
if ($LASTEXITCODE -ne 0) { throw 'RDP 组件编译失败' }
& node (Join-Path $PSScriptRoot 'package.mjs')
if ($LASTEXITCODE -ne 0) { throw 'RDP 组件打包失败' }
