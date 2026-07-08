<#
.SYNOPSIS
    Wrap the assembled dist\NeuroVue\ folder into a one-click self-extracting
    NeuroVue-Setup.exe (7-Zip SFX).

.DESCRIPTION
    Produces a single .exe that a non-technical user double-clicks to:
      1. extract the whole bundle to  %LOCALAPPDATA%\NeuroVue
      2. run run-firstrun.bat, which drops a "NeuroVue" shortcut on the Desktop
         and launches the app.

    Ship NeuroVue-Setup.exe on USB and/or upload it to GitHub Releases.

.NOTES
    Requires: 7-Zip (7z) on PATH, and a 7-Zip SFX module (7zSD.sfx or 7z.sfx).
    The SFX module ships in the "7-Zip Extra" package (7-zip.org/download.html).
    If 7zSD.sfx is not auto-found, pass -SfxModule <path>.
#>
[CmdletBinding()]
param(
    [string]$BundleDir = "",          # defaults to dist\NeuroVue
    [string]$OutFile   = "",          # defaults to dist\NeuroVue-Setup.exe
    [string]$SfxModule = ""           # path to 7zSD.sfx / 7z.sfx
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BundleDir) { $BundleDir = Join-Path $RepoRoot "dist\NeuroVue" }
if (-not $OutFile)   { $OutFile   = Join-Path $RepoRoot "dist\NeuroVue-Setup.exe" }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

if (-not (Test-Path $BundleDir)) {
    throw "Bundle not found: $BundleDir  (run build\assemble-bundle.ps1 first)"
}
if (-not (Get-Command 7z -ErrorAction SilentlyContinue)) {
    throw "7z not found on PATH (winget install 7zip.7zip)."
}

# --- Locate the SFX module ----------------------------------------------------
if (-not $SfxModule) {
    $candidates = @(
        "$env:ProgramFiles\7-Zip\7zSD.sfx",
        "$env:ProgramFiles\7-Zip\7z.sfx",
        "${env:ProgramFiles(x86)}\7-Zip\7zSD.sfx",
        "${env:ProgramFiles(x86)}\7-Zip\7z.sfx"
    )
    $SfxModule = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $SfxModule -or -not (Test-Path $SfxModule)) {
    throw @"
No 7-Zip SFX module found. Download '7-Zip Extra' from https://www.7-zip.org/download.html,
extract 7zSD.sfx (or 7z.sfx), and pass it with -SfxModule <path>.
"@
}
Write-Host "    using SFX module: $SfxModule"

# --- 1. Compress the bundle to a .7z -----------------------------------------
Write-Step "Compressing bundle (7z -mx9, this is slow)"
$archive = Join-Path $RepoRoot "dist\NeuroVue.7z"
if (Test-Path $archive) { Remove-Item -Force $archive }
Push-Location $BundleDir
try {
    & 7z a -t7z -mx9 -ms=on "$archive" "*" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z compression failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# --- 2. SFX config ------------------------------------------------------------
# 7-Zip SFX config: extract silently to %%S (a temp dir the SFX picks), then run
# run-firstrun.bat which relocates nothing (it uses its own folder). To install to
# a FIXED location we instead let the SFX extract to a temp dir and have
# run-firstrun.bat copy itself to %LOCALAPPDATA%\NeuroVue. To keep it simple and
# robust across SFX-module variants, we extract straight to %LOCALAPPDATA%\NeuroVue
# using the maintained SFX module's InstallPath, then RunProgram.
$configPath = Join-Path $RepoRoot "dist\sfx-config.txt"
$config = @'
;!@Install@!UTF-8!
Title="NeuroVue"
BeginPrompt="Install NeuroVue on this computer?"
InstallPath="%LOCALAPPDATA%\\NeuroVue"
RunProgram="run-firstrun.bat"
GUIMode="1"
OverwriteMode="2"
;!@InstallEnd@!
'@
Set-Content -Path $configPath -Value $config -Encoding UTF8

# --- 3. Concatenate module + config + archive --------------------------------
# An SFX .exe is literally: SFX module + config + .7z payload, concatenated in
# binary mode. `copy /b a + b + c out` is the canonical way to do this on Windows.
Write-Step "Building NeuroVue-Setup.exe"
if (Test-Path $OutFile) { Remove-Item -Force $OutFile }
$copyCmd = "copy /b `"$SfxModule`" + `"$configPath`" + `"$archive`" `"$OutFile`""
cmd /c $copyCmd | Out-Null
if (-not (Test-Path $OutFile)) { throw "Failed to create $OutFile" }

# --- 4. Checksum (handy for GitHub Releases) ---------------------------------
$hash = (Get-FileHash -Algorithm SHA256 $OutFile).Hash
$sizeMB = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
Set-Content -Path "$OutFile.sha256" -Value "$hash *$(Split-Path -Leaf $OutFile)" -Encoding ASCII

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Created: $OutFile  ($sizeMB MB)" -ForegroundColor Green
Write-Host "  SHA256 : $hash" -ForegroundColor Green
Write-Host "  (also written to $OutFile.sha256)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Ship this single file on USB and/or upload to GitHub Releases.`n"
