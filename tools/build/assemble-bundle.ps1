<#
.SYNOPSIS
    Assemble the self-contained, offline MRLatte portable bundle (MRLatte-build\MRLatte\).

.DESCRIPTION
    Produces a fully self-contained folder that `yarn dist:win` (electron-builder,
    from frontend\) packages into the Windows installer, with NO Python, NO Docker
    and NO internet needed on the end user's machine:

        MRLatte-build\MRLatte\
          python\        (embeddable Python 3.11 + site-packages\)
          python-reports\      (OPTIONAL, -Full only: requirements-reports.txt)
          python-validation\   (OPTIONAL, -Full only: requirements-validation.txt)
          backend\       (server.py + worker .py files)
          frontend_build\(built React app; NO atlases - see modules\)
          dcm2niix\      (dcm2niix.exe)
          scripts\       (runtime validation subset)
          modules\       (manifest.json, atlases\, and the empty tracts\ + lnm\
                          drop-in slots for the two user-supplied assets)

    The two big assets - a whole-brain tractogram and a DA-LNM connectome bundle
    - are NOT shipped. Both are HCP-derived, the WU-Minn Open Access Data Use
    Terms bar redistribution, and neither has to be one specific file, so the
    manifest marks them `type: "slot"`: the bundle only creates the folder the
    user drops their own copy into.

    Run this ONCE on a build machine that HAS internet, then `cd frontend && yarn
    dist:win` (or `dist:win:full` after `-Full`) to produce the installer.

.NOTES
    Requires: internet, a full Python 3.11 (`py -3.11`), Node + yarn, and `git`
    on PATH (requirements-frozen.txt pins lqtpy via a git+https URL, and pip
    shells out to git to fetch it even for `pip install --target`).
    Downloads are cached in tools\build\downloads\ so re-runs are fast.
#>
[CmdletBinding()]
param(
    [string]$PythonVersion = "3.11.9",

    # Override the download URL here if the default ever moves.
    [string]$PythonUrl = "",

    # Where the assembled bundle is written. Defaults to env var MRLATTE_BUILD_DIR,
    # or <repo-parent>\MRLatte-build when that is not set - always OUTSIDE the repo.
    [string]$OutDir = "",

    # Skip the (slow) `yarn build` if frontend\build already exists and is fresh.
    [switch]$SkipFrontendBuild,

    # Also stage the optional python-reports\ and python-validation\ dependency
    # sets (each in its own dir under the bundle) so the installer can offer them
    # as opt-in components. Without -Full, the bundle is core-only.
    [switch]$Full
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Resolve repo-relative paths (this script lives in <repo>\tools\build\) ---
$RepoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Downloads  = Join-Path $PSScriptRoot "downloads"
if (-not $OutDir) {
    if ($env:MRLATTE_BUILD_DIR) {
        $OutDir = $env:MRLATTE_BUILD_DIR
    } else {
        $OutDir = Join-Path (Split-Path -Parent $RepoRoot) "MRLatte-build"
    }
}
$BundleDir  = Join-Path $OutDir "MRLatte"

if (-not $PythonUrl) {
    $PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
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
Write-Step "Preflight checks"
Require-Tool "py"   "Install full Python 3.11 (winget install Python.Python.3.11)."
Require-Tool "yarn" "Install Node + yarn."

# NOTE: there is deliberately no check here for a tractogram or an LNM bundle.
# Neither ships, so their absence on the build machine is not a build failure -
# it is the normal state. They are slots the user fills after installing.

# --- Fresh bundle dir ---------------------------------------------------------
Write-Step "Preparing bundle directory: $BundleDir"
if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null

# --- 1. Embeddable Python -----------------------------------------------------
Write-Step "1/5  Embeddable Python $PythonVersion"
$pyZip = Get-Cached $PythonUrl "python-$PythonVersion-embed-amd64.zip"
$pyDir = Join-Path $BundleDir "python"
New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
Expand-Archive -Path $pyZip -DestinationPath $pyDir -Force

# Enable site-packages for the embeddable interpreter. The ._pth file otherwise
# isolates sys.path; we append site-packages + enable `import site`. (The packaged
# Electron app ALSO inserts these paths at runtime via a -c bootstrap in
# frontend\public\electron.js, so this is belt-and-suspenders - it makes the
# interpreter usable for the pip smoke test below too.)
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
Write-Step "2/5  Installing backend dependencies into site-packages (this is slow)"
$sitePkgs = Join-Path $pyDir "site-packages"
New-Item -ItemType Directory -Force -Path $sitePkgs | Out-Null
$reqFile = Join-Path $RepoRoot "backend\requirements-frozen.txt"
# requirements-frozen.txt pins lqtpy via a git+https URL (VCS requirement) -
# pip needs `git` on PATH to resolve it, same as any other pip install of a
# git URL. Not checked in Preflight above; add a Require-Tool "git" call there
# if a build machine ever lacks it.
& py -3.11 -m pip install --target "$sitePkgs" -r "$reqFile" --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }
Write-Ok "dependencies installed"

# --- 2a. Optional python stacks (installer components) -------------------------
# Each optional stack gets its OWN directory under $BundleDir so the installer
# can include or skip it independently of the others and of the core bundle.
if ($Full) {
    Write-Step "2a/5  Installing optional dependency stacks (-Full)"

    $reportsReq = Join-Path $RepoRoot "backend\requirements-reports.txt"
    $reportsDir = Join-Path $BundleDir "python-reports"
    New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
    & py -3.11 -m pip install --target "$reportsDir" -r "$reportsReq" --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "pip install (reports) failed (exit $LASTEXITCODE)" }
    Write-Ok "python-reports installed"

    $validationReq = Join-Path $RepoRoot "backend\requirements-validation.txt"
    $validationDir = Join-Path $BundleDir "python-validation"
    New-Item -ItemType Directory -Force -Path $validationDir | Out-Null
    & py -3.11 -m pip install --target "$validationDir" -r "$validationReq" --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "pip install (validation) failed (exit $LASTEXITCODE)" }
    Write-Ok "python-validation installed"
} else {
    Write-Ok "optional stacks skipped (pass -Full to include python-reports / python-validation)"
}

# Prune ballast that never runs in the shipped app: package test suites, byte-code
# caches and type stubs. Scoped strictly to $sitePkgs; best-effort, so a missing
# or locked directory logs a warning instead of failing the build.
Write-Step "2b/5  Pruning test dirs, __pycache__ and .pyi stubs from site-packages"
$prunedBytes = 0
try {
    $junkDirs = @(Get-ChildItem -Path $sitePkgs -Recurse -Directory -Force -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -eq "tests" -or $_.Name -eq "test" -or $_.Name -eq "__pycache__" })
    foreach ($d in $junkDirs) {
        # A parent may already have been removed earlier in this same loop.
        if (-not (Test-Path -LiteralPath $d.FullName)) { continue }
        $sum = (Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        if ($sum) { $prunedBytes += $sum }
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    $stubs = @(Get-ChildItem -Path $sitePkgs -Recurse -File -Force -Filter "*.pyi" -ErrorAction SilentlyContinue)
    foreach ($f in $stubs) {
        if (-not (Test-Path -LiteralPath $f.FullName)) { continue }
        $prunedBytes += $f.Length
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
    }
} catch {
    Write-Warn2 "prune pass incomplete: $($_.Exception.Message)"
}
Write-Ok ("pruned {0:N1} MB from site-packages" -f ($prunedBytes / 1MB))

# --- 3. Frontend build --------------------------------------------------------
$feBuild = Join-Path $RepoRoot "frontend\build"
if ($SkipFrontendBuild -and (Test-Path $feBuild)) {
    Write-Step "3/5  Frontend build (skipped, using existing frontend\build)"
} else {
    Write-Step "3/5  Building the React frontend (yarn build)"
    $env:REACT_APP_BACKEND_URL = ""     # same-origin: API served from the app itself
    $env:GENERATE_SOURCEMAP    = "false"  # ~10 MB of .js.map otherwise ships (and leaks source)
    Push-Location (Join-Path $RepoRoot "frontend")
    try {
        & yarn install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "yarn install failed" }
        & yarn build
        if ($LASTEXITCODE -ne 0) { throw "yarn build failed" }
    } finally { Pop-Location }
}
# CRA copies frontend\public\ verbatim into frontend\build\, so the build output
# carries a 36 MB atlases\ tree. Exclude it: atlases now ship ONCE, under
# modules\atlases (step 5), and server.py mounts them at /atlases off ATLAS_DIR -
# the exact URL the frontend already requests - so nothing in the app changes.
robocopy $feBuild (Join-Path $BundleDir "frontend_build") /E /XD "atlases" `
    /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy of frontend build failed (exit $LASTEXITCODE)" }
Write-Ok "frontend copied (atlases excluded)"

# --- 4. dcm2niix, backend source, scripts subset ------------------------------
Write-Step "4/5  Backend, dcm2niix, scripts"

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
           "lnm_results" "summary_results" "tract_results" `
           "lesion_jobs" "dissect_jobs" "lnm_jobs" `
    /XF "*.pyc" ".env" | Out-Null

# Runtime scripts subset (validate_round_trip imports postprocess_atlases).
$scriptsDest = Join-Path $BundleDir "scripts"
New-Item -ItemType Directory -Force -Path $scriptsDest | Out-Null
foreach ($f in @("validate_round_trip.py", "postprocess_atlases.py", "benson_validation_report.txt")) {
    $src = Join-Path $RepoRoot "tools\scripts\$f"
    if (Test-Path $src) { Copy-Item -Force $src $scriptsDest }
    else { Write-Warn2 "tools\scripts\$f not found (skipped)" }
}
$vplots = Join-Path $RepoRoot "tools\scripts\validation_plots"
if (Test-Path $vplots) { Copy-Item -Recurse -Force $vplots $scriptsDest }

# --- 5. Module tree -----------------------------------------------------------
# One root for every large data asset. The packaged Electron app points
# MRLATTE_MODULE_ROOT at this folder (frontend\public\electron.js), and
# backend\deps.py derives ATLAS_DIR (atlases), GLOBAL_TRACT_FILE (tracts\) and
# LNM_BUNDLE (lnm\) from it.
Write-Step "5/5  Module tree (manifest, atlases, drop-in slots)"
$modulesDest = Join-Path $BundleDir "modules"
New-Item -ItemType Directory -Force -Path $modulesDest | Out-Null

# The manifest the backend reads to report per-module capability + install state.
$manifestSrc = Join-Path $RepoRoot "data\modules\manifest.json"
if (-not (Test-Path $manifestSrc)) { throw "Module manifest missing: $manifestSrc" }
Copy-Item -Force $manifestSrc $modulesDest
Write-Ok "manifest.json copied"

# Redistributable atlas families (per-family subfolders: mni152\, harvard_oxford\,
# benson14\, hcp1065\, ...). These are the only data assets that ship.
$atlasSrc  = Join-Path $RepoRoot "data\modules\atlases"
$atlasDest = Join-Path $modulesDest "atlases"
if (Test-Path $atlasSrc) {
    robocopy $atlasSrc $atlasDest /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy of atlases failed (exit $LASTEXITCODE)" }
    $atlasFiles = @(Get-ChildItem -Path $atlasDest -Recurse -File)
    $atlasMB    = ($atlasFiles | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Ok ("atlases copied ({0} files, {1:N1} MB)" -f $atlasFiles.Count, $atlasMB)
} else {
    Write-Warn2 "data\modules\atlases not found - the app will start with no atlases."
}

# The two user-supplied slots. Create them EMPTY so the drop-in location exists
# and is obvious on a fresh install. Each carries a README.txt for two reasons:
# it tells the user what belongs there, and electron-builder does not store an
# empty directory, so without a file inside, the folder would simply not exist
# after packaging. module_slots.scan_slot filters candidates by extension, so a
# .txt in the slot is ignored, not "broken".
$slots = @(
    @{
        dir = "tracts"
        txt = @(
            "Drop a whole-brain tractogram here to enable lesion-based virtual",
            "tract dissection.",
            "",
            "  * format:  .trk  (a .tck is rejected - it carries no reference grid)",
            "  * space:   registered to the MNI template",
            "  * name:    anything; any conforming file here is picked up",
            "",
            "Nothing to install. Restart MRLatte after dropping the file in."
        )
    },
    @{
        dir = "lnm"
        txt = @(
            "Drop a DA-LNM connectome bundle here to enable lesion network mapping.",
            "",
            "  * format:  .npz  (as produced by the DA-LNM preparation stage)",
            "  * name:    anything; any conforming file here is picked up",
            "",
            "Nothing to install. Restart MRLatte after dropping the file in."
        )
    }
)
foreach ($slot in $slots) {
    $slotDir = Join-Path $modulesDest $slot.dir
    New-Item -ItemType Directory -Force -Path $slotDir | Out-Null
    Set-Content -Path (Join-Path $slotDir "README.txt") -Value $slot.txt -Encoding ASCII
    if (-not (Test-Path (Join-Path $slotDir "README.txt"))) {
        throw "slot directory modules\$($slot.dir) was not created"
    }
    Write-Ok "slot modules\$($slot.dir)\ created (empty)"
}

# --- Done ---------------------------------------------------------------------
$sizeMB = [math]::Round((Get-ChildItem -Recurse -File $BundleDir | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Bundle assembled: $BundleDir  (~$sizeMB MB)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Next: cd frontend; yarn dist:win  (or dist:win:full, after -Full)"
Write-Host "  to package this bundle into the Windows installer."
Write-Host ""
Write-Host "  SMOKE TEST after installing:" -ForegroundColor Green
Write-Host "    1) launch MRLatte and confirm the MNI152 viewer loads (atlases now"
Write-Host "       come from modules\atlases, not frontend_build)"
Write-Host "    2) exercise DICOM import + a one-click summary"
Write-Host "    3) open the Module Store: tractography-whole-brain and"
Write-Host "       lnm-connectome must read 'not installed', NOT 'broken'"
Write-Host "    4) drop a .trk into the installed modules\tracts, restart,"
Write-Host "       re-check, then run a tract dissection`n"

# robocopy exits 1 ("files were copied") on success, so without this the script
# would report failure to any caller that checks its exit code. Only reached when
# nothing threw - $ErrorActionPreference is Stop, so a real failure never gets here.
exit 0
