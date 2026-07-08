# MRLatte

**Offline neuroimaging visualization & clinical analysis — as a self-contained Windows desktop app.**

MRLatte loads MRI volumes (NIfTI / DICOM), renders them in a hardware-accelerated
WebGL viewer, and layers a suite of clinical and research analyses on top —
lesion mapping, tractography dissection, lesion–network mapping, retinotopy, and
one-click reporting. It ships as a single installer that bundles its own
application server and database, so it runs on an air-gapped clinical workstation
with **no internet, no Python, and no database setup required**.

---

## Highlights

- 🧠 **Interactive volume viewer** — NIfTI & DICOM rendering powered by
  [NiiVue](https://github.com/niivue/niivue) (WebGL2): multiplanar and 3D views,
  overlays, opacity/colormap control, and precise voxel/slice navigation.
- 🩻 **DICOM import** — drag in a DICOM series and convert to NIfTI in-app via a
  bundled `dcm2niix`.
- 🗺️ **Rich atlas library** — MNI152, Wang 2015, Benson 2014, AAL,
  Harvard–Oxford, Jülich, Destrieux, JHU white-matter, and HCP/IIT tractography
  atlases for overlay and localization.
- ✏️ **Lesion tools** — draw, edit, and quantify lesions; overlay comparison for
  longitudinal review.
- 🧵 **Tract dissection** — filter a whole-brain tractogram through lesion ROIs,
  including inter-lesion (between-region) connectivity, with DTI-coloured
  streamline visualization.
- 🔗 **Lesion–network mapping (LNM)** — estimate the network footprint of a
  lesion from a normative connectome bundle.
- 👁️ **Visual-field & retinotopy mapping** — Benson/Wang-based visual area and
  eccentricity/polar-angle maps, with a 2D visual-field projection.
- 📋 **One-click clinical summary** — generate a shareable HTML report of the
  current workspace and findings.
- 🗄️ **Longitudinal tracking** — per-patient workspaces persisted locally in
  MongoDB.

---

## Architecture

MRLatte is a desktop shell around a same-origin web application: one local server
process serves both the API and the built UI, backed by a local database.

| Layer              | Technology                                             |
| ------------------ | ------------------------------------------------------ |
| Desktop shell      | Electron                                               |
| User interface     | React + [NiiVue](https://github.com/niivue/niivue) (WebGL2) |
| Application server | FastAPI (Python), served by Uvicorn                    |
| Database           | MongoDB (bundled, local-only)                          |
| Imaging stack      | SimpleITK · nibabel · nilearn · NumPy/SciPy · dcm2niix |

In the packaged app, the Electron main process launches a **bundled MongoDB** and
an **embedded-Python FastAPI backend**, waits for it to become healthy, then loads
the same-origin UI (`http://127.0.0.1:8001`) into the window. All patient data
stays on the machine, under `%LOCALAPPDATA%\MRLatte`.

---

## Getting started

### Option A — Install the desktop app (recommended)

1. Obtain the installer (`*-Setup-*-x64.exe`) — from the Releases page or on USB.
2. Run it and follow the prompts. A desktop shortcut is created.
3. Launch MRLatte. The first start takes a little longer while the imaging engine
   warms up; subsequent launches are fast.

No Python, database, or internet connection is required on the target machine.
See **[OFFLINE-INSTALL.md](OFFLINE-INSTALL.md)** for the full offline / USB
deployment guide.

### Option B — Run from source (development)

Prerequisites: Node.js + Yarn, Python 3.11, and `dcm2niix` on `PATH`
(for DICOM import).

```bash
# 1. Backend (API + database-backed features)
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8001      # requires MONGO_URL + DB_NAME

# 2. Frontend (web, hot-reload)
cd frontend
yarn install
yarn start                                    # http://localhost:3000

# …or run the desktop shell against the dev server:
yarn electron:start
```

### Option C — Build the offline installer

The installer is produced in two steps on an internet-connected Windows x64
machine — assemble the self-contained backend bundle, then package the Electron
app around it:

```powershell
# 1. Assemble the offline bundle (embeds Python, MongoDB, dcm2niix, UI, data)
powershell -ExecutionPolicy Bypass -File build\assemble-bundle.ps1

# 2. Build the Windows installer
cd frontend
yarn dist:win
```

Full details, prerequisites, and verification steps are in
**[OFFLINE-INSTALL.md](OFFLINE-INSTALL.md)**.

---

## Repository layout

```
frontend/    React + NiiVue UI and the Electron shell (public/electron.js)
backend/     FastAPI server, imaging workers, and requirements
build/       Offline-bundle build scripts (assemble-bundle.ps1, make-sfx.ps1)
launcher/    Standalone console launcher (bundle fallback / test harness)
scripts/     Atlas-generation and validation tooling
DaLnm/       Lesion–network-mapping connectome bundle (Git LFS)
```

Large binaries (`backend/tracts/S35_1mm.trk`, `DaLnm/lnm_bundle_d100.npz`) are
tracked with **Git LFS** — install [git-lfs](https://git-lfs.com) before cloning
to fetch them.

## Documentation

- **[USER_GUIDE.md](USER_GUIDE.md)** — operating the app, feature by feature.
- **[OFFLINE-INSTALL.md](OFFLINE-INSTALL.md)** — building and shipping the offline installer.
- **[DEPLOY.md](DEPLOY.md)** / **[DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)** — server deployment (Docker).
- **[FEATURES.md](FEATURES.md)** · **[CHANGELOG.md](CHANGELOG.md)** — feature tracking and history.

---

## Data & privacy

MRLatte is designed for handling sensitive medical imaging. It runs fully offline,
stores all data locally, and includes no external telemetry, session recording, or
third-party CDN scripts.

> **Disclaimer.** MRLatte is a research and visualization tool. It is **not** a
> certified medical device and must not be used as the sole basis for clinical
> diagnosis or treatment decisions.
