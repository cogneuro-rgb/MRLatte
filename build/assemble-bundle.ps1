<#
.SYNOPSIS
    Assemble the self-contained, offline NeuroVue portable bundle (dist\NeuroVue\).

.DESCRIPTION
    Produces a fully self-contained folder that runs NeuroVue on any Windows PC
    with NO Python, NO MongoDB, NO Docker and NO internet installed:

        dist\NeuroVue\
          run.bat  run-firstrun.bat  launcher.py
          python\        (embeddable Python 3.11 + site-packages\)
          backend\       (server.py + worker .py files)
          frontend_build\(built React app + atlases\)
          mongo\         (portable mongod.exe 4.4.x)
          dcm2niix\      (dcm2niix.exe)
          scripts\       (runtime validation subset)
          data\          (lnm_bundle_d100.npz, tracts\S35_1mm.trk)

    Run this ONCE on a build machine that HAS internet. The resulting folder (or
    the NeuroVue-Setup.exe produced by make-sfx.ps1) is what ships on USB / GitHub.

.NOTES
    Requires: internet, a full Python 3.11 (`py -3.11`), Node + yarn, 7-Zip (7z).
    Downloads are cached in build\downloads\ so re-runs are fast.
#>
[CmdletBinding()]
param(
    # Pinned versions. 4.4 is the last MongoDB line that runs WITHOUT requiring an
    # AVX-capable CPU - safest for old/offline clinical hardware.
    [string]$PythonVersion = "3.11.9",
    [string]$MongoVersion  = "4.4.29",

    # Override download URLs here if the defaults ever move.
    [string]$PythonUrl = "",
    [string]$MongoUrl  = "",

    # Where the assembled bundle is written.
    [string]$OutDir = "",

    # Skip the (slow) `yarn build` if frontend\build already exists and is fresh.
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Resolve repo-relative paths (this script lives in <repo>\build\) ---------
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$Downloads  = Join-Path $PSScriptRoot "downloads"
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "dist" }
$BundleDir  = Join-Path $OutDir "NeuroVue"

if (-not $PythonUrl) {
    $PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
}
if (-not $MongoUrl) {
    $MongoUrl = "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-$MongoVersion.zip"
}

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    [warn] $msg" -ForegroundColor Yellow }

function Get-Cached($url, $fileName) {
    New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
    $dest = Join-Path $Downloads $fileName
    if (Test-Path $dest) {
        Write-Ok "using cached $fileName"
    } else {
        Write-Host "    downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        Write-Ok "downloaded $fileName"
    }
    return $dest
}

function Require-Tool($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required tool '$name' not found on PATH. $hint"
    }
}

# --- Preflight ----------------------------------------------------------------
# Note: this script unzips with PowerShell's built-in Expand-Archive, so 7-Zip is
# NOT needed here - it's only required later by make-sfx.ps1 for the final .exe.
Write-Step "Preflight checks"
Require-Tool "py"   "Install full Python 3.11 (winget install Python.Python.3.11)."
Require-Tool "yarn" "Install Node + yarn."

$trkFile = Join-Path $RepoRoot "backend\tracts\S35_1mm.trk"
if (-not (Test-Path $trkFile)) {
    Write-Warn2 "backend\tracts\S35_1mm.trk is MISSING. Tract-dissection features will no-op."
    Write-Warn2 "Supply that file before shipping, then re-run this script."
}
$lnmBundle = Join-Path $RepoRoot "DaLnm\lnm_bundle_d100.npz"
if (-not (Test-Path $lnmBundle)) {
    throw "Required data file missing: $lnmBundle"
}

# --- Fresh bundle dir ---------------------------------------------------------
Write-Step "Preparing bundle directory: $BundleDir"
if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null

# --- 1. Embeddable Python -----------------------------------------------------
Write-Step "1/6  Embeddable Python $PythonVersion"
$pyZip = Get-Cached $PythonUrl "python-$PythonVersion-embed-amd64.zip"
$pyDir = Join-Path $BundleDir "python"
New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
Expand-Archive -Path $pyZip -DestinationPath $pyDir -Force

# Enable site-packages for the embeddable interpreter. The ._pth file otherwise
# isolates sys.path; we append site-packages + enable `import site`. (The launcher
# ALSO inserts these paths at runtime via a -c bootstrap, so this is belt-and-
# suspenders - it makes the interpreter usable for the pip smoke test below too.)
$pthFile = Get-ChildItem -Path $pyDir -Filter "python*._pth" | Select-Object -First 1
if ($pthFile) {
    $lines = Get-Content $pthFile.FullName
    $lines = $lines | ForEach-Object { $_ -replace '^\s*#\s*import\s+site', 'import site' }
    if ($lines -notcontains "site-packages") { $lines += "site-packages" }
    if ($lines -notcontains "import site")   { $lines += "import site" }
    Set-Content -Path $pthFile.FullName -Value $lines -Encoding ASCII
    Write-Ok "patched $($pthFile.Name) (site-packages enabled)"
}

# --- 2. pip install runtime deps into site-packages ---------------------------
Write-Step "2/6  Installing backend dependencies into site-packages (this is slow)"
$sitePkgs = Join-Path $pyDir "site-packages"
New-Item -ItemType Directory -Force -Path $sitePkgs | Out-Null
$reqFile = Join-Path $RepoRoot "backend\requirements-frozen.txt"
& py -3.11 -m pip install --target "$sitePkgs" -r "$reqFile" --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
Write-Ok "dependencies installed"

# --- 3. Frontend build --------------------------------------------------------
$feBuild = Join-Path $RepoRoot "frontend\build"
if ($SkipFrontendBuild -and (Test-Path $feBuild)) {
    Write-Step "3/6  Frontend build (skipped, using existing frontend\build)"
} else {
    Write-Step "3/6  Building the React frontend (yarn build)"
    $env:REACT_APP_BACKEND_URL = ""   # same-origin: API served from the app itself
    Push-Location (Join-Path $RepoRoot "frontend")
    try {
        & yarn install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "yarn install failed" }
        & yarn build
        if ($LASTEXITCODE -ne 0) { throw "yarn build failed" }
    } finally { Pop-Location }
}
Copy-Item -Recurse -Force $feBuild (Join-Path $BundleDir "frontend_build")
Write-Ok "frontend copied"

# --- 4. Portable MongoDB ------------------------------------------------------
Write-Step "4/6  Portable MongoDB $MongoVersion"
$mongoZip = Get-Cached $MongoUrl "mongodb-windows-x86_64-$MongoVersion.zip"
$mongoTmp = Join-Path $Downloads "mongo-extract"
if (Test-Path $mongoTmp) { Remove-Item -Recurse -Force $mongoTmp }
Expand-Archive -Path $mongoZip -DestinationPath $mongoTmp -Force
$mongoBin = Get-ChildItem -Path $mongoTmp -Recurse -Filter "mongod.exe" | Select-Object -First 1
if (-not $mongoBin) { throw "mongod.exe not found in the MongoDB archive." }
$mongoDest = Join-Path $BundleDir "mongo"
New-Item -ItemType Directory -Force -Path $mongoDest | Out-Null
Copy-Item -Force (Join-Path $mongoBin.DirectoryName "*") $mongoDest -Recurse
Write-Ok "mongod.exe + bin copied"

# --- 5. dcm2niix, backend source, scripts subset, data ------------------------
Write-Step "5/6  Backend, dcm2niix, scripts, data"

# dcm2niix.exe ships inside the pip 'dcm2niix' package we just installed; locate it.
$dcm = Get-ChildItem -Path $sitePkgs -Recurse -Filter "dcm2niix.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$dcmDest = Join-Path $BundleDir "dcm2niix"
New-Item -ItemType Directory -Force -Path $dcmDest | Out-Null
if ($dcm) {
    Copy-Item -Force $dcm.FullName $dcmDest
    Write-Ok "dcm2niix.exe found and copied"
} else {
    Write-Warn2 "dcm2niix.exe not found in site-packages. DICOM import will be disabled."
    Write-Warn2 "Download it from https://github.com/rordenlab/dcm2niix/releases and place"
    Write-Warn2 "  dcm2niix.exe into: $dcmDest"
}

# Backend source (server + workers + any .py); exclude caches and local result dirs.
$backendDest = Join-Path $BundleDir "backend"
New-Item -ItemType Directory -Force -Path $backendDest | Out-Null
robocopy (Join-Path $RepoRoot "backend") $backendDest `
    /E /XD "__pycache__" ".pytest_cache" "tracts" "dicom_results" "roi_results" `
           "lnm_results" "summary_results" "lesion_store" `
    /XF "*.pyc" ".env" | Out-Null

# Runtime scripts subset (validate_round_trip imports postprocess_atlases).
$scriptsDest = Join-Path $BundleDir "scripts"
New-Item -ItemType Directory -Force -Path $scriptsDest | Out-Null
foreach ($f in @("validate_round_trip.py", "postprocess_atlases.py", "benson_validation_report.txt")) {
    $src = Join-Path $RepoRoot "scripts\$f"
    if (Test-Path $src) { Copy-Item -Force $src $scriptsDest }
    else { Write-Warn2 "scripts\$f not found (skipped)" }
}
$vplots = Join-Path $RepoRoot "scripts\validation_plots"
if (Test-Path $vplots) { Copy-Item -Recurse -Force $vplots $scriptsDest }

# Data files.
$dataDest = Join-Path $BundleDir "data"
New-Item -ItemType Directory -Force -Path (Join-Path $dataDest "tracts") | Out-Null
Copy-Item -Force $lnmBundle $dataDest
if (Test-Path $trkFile) { Copy-Item -Force $trkFile (Join-Path $dataDest "tracts") }

# --- 6. Launcher + entry scripts ---------------------------------------------
Write-Step "6/6  Launcher and entry scripts"
Copy-Item -Force (Join-Path $RepoRoot "launcher\launcher.py")        $BundleDir
Copy-Item -Force (Join-Path $RepoRoot "launcher\run.bat")            $BundleDir
Copy-Item -Force (Join-Path $RepoRoot "launcher\run-firstrun.bat")   $BundleDir
$ico = Join-Path $RepoRoot "launcher\neurovue.ico"
if (Test-Path $ico) { Copy-Item -Force $ico $BundleDir }
Write-Ok "launcher.py, run.bat, run-firstrun.bat copied"

# --- Done ---------------------------------------------------------------------
$sizeGB = [math]::Round((Get-ChildItem -Recurse $BundleDir | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Bundle assembled: $BundleDir  (~$sizeGB GB)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  SMOKE TEST before shipping:" -ForegroundColor Green
Write-Host "    1) double-click  $BundleDir\run.bat"
Write-Host "    2) confirm the browser opens the MNI152 viewer"
Write-Host "    3) exercise DICOM import + a tract dissection + one-click summary"
Write-Host "  Then wrap it into NeuroVue-Setup.exe with:  build\make-sfx.ps1`n"
