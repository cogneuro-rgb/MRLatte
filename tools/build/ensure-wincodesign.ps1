<#
.SYNOPSIS
    Make sure electron-builder's Windows exe tool (winCodeSign) is in its cache,
    so stamping the icon and version into MRLatte.exe works on any Windows PC.

.DESCRIPTION
    electron-builder edits the exe with rcedit, which it takes from an archive it
    downloads on first use: winCodeSign-2.6.0.7z. That archive also holds two macOS
    symbolic links (darwin/10.12/lib/libcrypto.dylib, libssl.dylib). Windows only
    lets a normal user create symbolic links in Developer Mode or as administrator,
    so on an ordinary PC electron-builder's own unpack fails four times with

        ERROR: Cannot create symbolic link : A required privilege is not held by the client.

    and the installer build dies there. (This is why package.json used to carry
    `signAndEditExecutable: false`, which avoided the step and left MRLatte.exe
    with Electron's default icon.)

    electron-builder only unpacks when the folder isn't already there, so this
    script puts it there first: same archive, same download location, checked
    against a known SHA-256, unpacked WITHOUT the darwin folder. Nothing on
    Windows uses that folder.

    Run by build-minimal.bat and build-full.bat before packaging. Does nothing
    when the folder already exists.

.PARAMETER CacheRoot
    electron-builder's cache folder. Defaults to what electron-builder itself
    uses: %ELECTRON_BUILDER_CACHE%, else %LOCALAPPDATA%\electron-builder\Cache.
#>
param([string]$CacheRoot)

$ErrorActionPreference = "Stop"
$name   = "winCodeSign-2.6.0"
$sha256 = "cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4"
$url    = "https://github.com/electron-userland/electron-builder-binaries/releases/download/$name/$name.7z"

if (-not $CacheRoot) {
    $CacheRoot = if ($env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE }
                 else { Join-Path $env:LOCALAPPDATA "electron-builder\Cache" }
}
$dir    = Join-Path $CacheRoot "winCodeSign"
$target = Join-Path $dir $name

if (Test-Path (Join-Path $target "rcedit-x64.exe")) {
    Write-Host "  [ok] $name already in electron-builder's cache"
    exit 0
}

$sevenZip = Join-Path $PSScriptRoot "..\..\frontend\node_modules\7zip-bin\win\x64\7za.exe"
if (-not (Test-Path $sevenZip)) {
    throw "7za.exe not found at $sevenZip - run 'yarn install' in frontend\ first."
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$archive = Join-Path $dir "$name.download.7z"
$staging = Join-Path $dir "$name.unpacking"

Write-Host "  downloading $name (5.6 MB)"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

$actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
if ($actual -ne $sha256) {
    Remove-Item $archive -Force
    throw "$name.7z has SHA-256 $actual, expected $sha256. Not unpacking it."
}

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
& $sevenZip x -bd -y "-xr!darwin" "-o$staging" $archive | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7za failed to unpack $name.7z (exit $LASTEXITCODE)." }
if (-not (Test-Path (Join-Path $staging "rcedit-x64.exe"))) { throw "$name.7z unpacked without rcedit-x64.exe." }

# Unpacked beside its final place and renamed in one step, so a build that is
# interrupted half-way never leaves a folder electron-builder would take as complete.
Move-Item $staging $target
Remove-Item $archive -Force
Write-Host "  [ok] $name unpacked into electron-builder's cache (without the macOS folder)"
