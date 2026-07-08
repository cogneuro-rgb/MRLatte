# NeuroVue — Offline Desktop App (Windows)

NeuroVue ships as a **native Windows desktop application**: one installer
(`NeuroVue-Setup-<version>-x64.exe`), one clean app window, no browser tab, no
console. It bundles its own Python backend + MongoDB, so it runs **fully offline**
on any Windows 10/11 x64 machine — nothing to install, no internet needed.

- **Online machines** → download the installer from GitHub Releases, run it.
- **Offline machines** → copy the installer from USB, run it.

The same installer works for both — the target machine downloads nothing.

---

## Part A — For the END USER (non-technical)

1. Double-click **`NeuroVue-Setup-…-x64.exe`**.
2. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**
   (normal for apps that aren't code-signed yet).
3. Follow the short installer (Next → Install). It creates a **NeuroVue** icon on
   the Desktop and in the Start Menu.
4. Launch NeuroVue from that icon. A window opens showing *"Starting NeuroVue…"*
   for a few seconds (longer on the very first launch), then the app appears.
5. To quit, just close the window. To uninstall, use *Add or remove programs*.

Your data (lesions, database) is stored under `%LOCALAPPDATA%\NeuroVue` and is kept
across updates and re-installs.

---

## Part B — For the BUILD ENGINEER

Building the installer is a **two-step** process on an internet-connected Windows
x64 machine: (1) assemble the offline backend bundle, (2) build the Electron
installer that embeds it.

### One-time tooling
```powershell
winget install -e --id Python.Python.3.11    # embeddable-Python parity for the sci-stack
# Node + yarn are already used by the frontend.
```
(7-Zip / Inno Setup are NOT needed — electron-builder produces the NSIS installer.)

### Go / no-go before building
- **`backend/tracts/S35_1mm.trk`** must be present (now committed, not gitignored),
  or tract dissection silently no-ops. `assemble-bundle.ps1` warns if it's missing.
- `DaLnm/lnm_bundle_d100.npz` must be present (it is, in this checkout).

### Step 1 — Assemble the offline backend bundle
Produces `dist\NeuroVue\` (embeddable Python + site-packages, portable MongoDB
4.4, backend source, dcm2niix, scripts, data, built frontend). Slow the first time
(downloads MongoDB + pip-installs the scientific stack; downloads are cached).
```powershell
powershell -ExecutionPolicy Bypass -File build\assemble-bundle.ps1
```

**Intermediate test (recommended, no internet needed):** before building the
installer, confirm the backend bundle actually runs on its own —
```powershell
dist\NeuroVue\run.bat
```
A browser opens the MNI152 viewer at `http://127.0.0.1:8001/`. Exercise DICOM
import + a tract dissection + a one-click summary, then close the window. This
isolates "does the bundled backend work" from "does Electron wrap it correctly."

### Step 2 — Build the Electron desktop installer
`extraResources` in `frontend/package.json` pulls `dist\NeuroVue\{python,mongo,
backend,dcm2niix,scripts,data,frontend_build}` into the app; the Windows target is
NSIS.
```powershell
cd frontend
yarn install
yarn dist:win
```
Output: **`frontend\dist-electron\NeuroVue-Setup-<version>-x64.exe`**.

### Ship it
- Upload the installer to **GitHub Releases** (online machines).
- Copy the same installer to **USB** (offline machines).

---

## How it works (architecture)

Mirrors the existing `docker-compose.local.yml` design **without Docker**, wrapped
in an Electron window.

```
NeuroVue-Setup-x64.exe  (NSIS installer, self-contained)
  └─ installs the Electron app; resources\ holds the embedded stack:
        resources\python\        embeddable Python 3.11 + site-packages\
        resources\mongo\         portable mongod.exe 4.4.x
        resources\backend\       server.py + worker .py files
        resources\frontend_build\ built React app (+ atlases\)
        resources\dcm2niix\      dcm2niix.exe (DICOM import)
        resources\scripts\ , resources\data\
     runtime data: %LOCALAPPDATA%\NeuroVue\{db, lesions, logs}
```

On launch, `frontend/public/electron.js` (the Electron main process):
1. starts `mongod` on `127.0.0.1:27117` (dbpath under `%LOCALAPPDATA%`);
2. starts the FastAPI backend via the bundled `python.exe`, injecting `MONGO_URL`,
   `STATIC_DIR`, `ATLAS_DIR`, the result/data dirs, and `dcm2niix` on `PATH`
   (uvicorn serves the React app + API same-origin on `127.0.0.1:8001`);
3. shows a "Starting NeuroVue…" screen, polls `GET /api/` until healthy, then
   loads `http://127.0.0.1:8001/` into the window;
4. tears down both child processes when the app quits (or if one crashes).

### Notable design points
- **MongoDB 4.4.x** is pinned deliberately — the last line that runs on CPUs
  **without AVX** (5.0+ crashes on non-AVX CPUs; matters for older hardware).
- **Embeddable Python** ships the real interpreter + real packages, so the heavy
  scientific stack (SimpleITK / nibabel / nilearn / neuropythy / scipy) "just
  works" and the worker subprocesses spawn correctly via the real `python.exe` —
  no PyInstaller freezing needed.
- The embeddable Python's `._pth` makes it ignore `PYTHONPATH`, so `electron.js`
  adds `site-packages` + `backend` to `sys.path` at runtime via a `-c` bootstrap.
- Native file save/open (`window.neurovue`) keeps working because `preload.js` is
  injected into the window regardless of the loaded URL.

### Testing the packaged code path without a full build
```powershell
cd frontend
$env:NEUROVUE_RES_DIR = "..\dist\NeuroVue"   # point at the assembled bundle
npx electron .
```
This runs the real spawn-backend path against `dist\NeuroVue\` without producing
an installer — fast iteration on the Electron integration.

### Known limitations / follow-ups
- **Unsigned installer** → SmartScreen / antivirus may warn. Code-signing
  (Authenticode) is the proper fix for locked-down clinical fleets — a later
  follow-up, not required for v1.
- Installer is ~1–2 GB. electron-builder uses LZMA for NSIS, which handles this,
  but watch build memory/time; if it approaches ~2 GB, revisit compression.
- The standalone `dist\NeuroVue\` folder (+ `run.bat`) remains a valid **fallback**
  distribution and the recommended intermediate test harness (Step 1 above).
- Docker remains a **separate track** for server deployments
  (`docker-compose.local.yml` + `DEPLOY-WINDOWS.md`).
