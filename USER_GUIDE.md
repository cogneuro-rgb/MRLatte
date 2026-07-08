# NeuroVue — Operating Guide

How to run the app and how each clinical feature works. For the change log see
`CHANGELOG.md`; for the implementation log see `PROGRESS.md`.

---

## 1. Running the app

### Web (browser)
```
cd frontend
yarn install        # first time only
yarn start          # → http://localhost:3000
```

### Desktop (Electron)
```
cd frontend
yarn install        # first time only
yarn electron:start # launches the CRA dev server + desktop window together
```
Production desktop build (Windows): `cd frontend && yarn dist:win` → output in
`frontend/dist-electron/` (extract the `.zip`, run `NeuroVue.exe`).

### Backend (optional)
Only needed for **DICOM import** and **Longitudinal comparison**. Everything
else works without it.
```
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8001
```
Extra runtime requirements:
- **DICOM import:** the `dcm2niix` binary must be on the system PATH.
- **Longitudinal:** the `SimpleITK` Python package (installed by `requirements.txt`).

If a backend feature isn't available the UI shows a clear error toast instead
of failing silently.

---

## 2. Core workflow

1. The MNI152 template loads automatically as the base volume.
2. Load your data via the left sidebar sections (Lesion Masks, Custom ROIs,
   Activation Maps, Atlases, Tractography, …).
3. Click anywhere on a slice to move the crosshair — the info bar above the
   viewer shows MNI mm, voxel index, per-layer values, and atlas labels.
4. Use the topbar for view modes, screenshots, clearing overlays, and the new
   workspace/eloquent controls.

---

## 3. New features

### 3.1 One-click lesion report
**Where:** Sidebar → *Lesion Masks* (appears once a lesion is loaded, below the
Overlap panel).

1. Load a lesion mask.
2. In *One-click lesion report*, choose the lesion (if more than one) and tick
   which atlases to cross-reference (defaults to the atlases currently shown).
3. Click **Generate Report**. You get a clinical paragraph with:
   - Lesion volume (cm³) and centroid in MNI mm.
   - Per-atlas % involvement of each region.
4. Export with **TXT** or **PDF**. In the desktop app a native Save dialog
   opens; in the browser the file downloads.

### 3.2 Eloquent-structure proximity warning
**Where:** Topbar → **Eloquent Warn** toggle.

- Turn it on; the Jülich atlas loads invisibly in the background.
- As you move the crosshair, a chip appears in the info bar when you are within
  ~5 mm of an eloquent white-matter tract: amber for "near", red for "inside".
- Turn it off to hide the chip and stop the lookups.

### 3.3 Semi-automatic lesion segmentation (Smart Seed)
**Where:** Sidebar → *Draw Lesion* → enable drawing → **Smart Seed** mode.

1. Enable Drawing, then switch the mode toggle from *Manual* to *Smart Seed*.
2. Set the **intensity tolerance** (how similar neighbouring voxels must be),
   optional **max distance (mm)**, and **3D grow** (whole volume) vs single slice.
3. Click once inside the lesion — the region grows automatically and fills the
   draw layer. The last segmented volume is shown in mL.
4. **Undo** reverts the last grow; **Save** exports the mask as `.nii.gz`.
   Manual pen/rectangle/ellipse drawing still works in *Manual* mode.

### 3.4 Measurements & windowing
**Where:** Sidebar → *Measurements & Window*.

- **Ruler:** move the crosshair, click **Set A**, move it, click **Set B** —
  the straight-line distance in mm is shown.
- **Lesion max diameter:** pick a lesion and click **Measure**. Reports an
  approximate maximum diameter (PCA principal axis) and voxel count.
- **Midline shift:** place the crosshair on a structure that should sit on the
  midline and click **Set Landmark @ Crosshair**. Reports |x| from MNI x≈0 and
  the displaced side.
- **Window presets:** Brain / Stroke / Soft Tissue / Bone are CT Hounsfield
  windows for CT bases; use **Full** for the default MRI MNI152 template.

### 3.5 Session save / restore
**Where:** Topbar → **Save** and **Open**.

- **Save** writes a `.nvws.json` workspace containing your view settings,
  overlay/atlas/retinotopy visibility and settings, and the bytes of any
  uploaded volumes (the file is self-contained, so it can be reopened on
  another machine).
- **Open** restores everything. Desktop uses native file dialogs; the browser
  uses a download / file picker.
- Note: fine-grained per-layer threshold (cal-range) restore for uploaded
  volumes is deferred to a future version; colormap and opacity are restored.

### 3.6 DICOM import
**Where:** Sidebar → *Base Volume* → **Import DICOM Series**. Requires the
backend with `dcm2niix`.

1. Click and select a **folder** of `.dcm` files (or a `.zip` of them).
2. The backend converts the series to NIfTI and it loads as the base volume.
3. If the server lacks `dcm2niix`, you'll get a clear error — convert to NIfTI
   externally as a fallback.

### 3.7 Longitudinal comparison
**Where:** Sidebar → *Longitudinal*. Requires the backend with `SimpleITK`.

1. Select a **baseline** scan and a **follow-up** scan.
2. Click **Compare**. The follow-up is affine-registered to the baseline and a
   signed difference map (follow-up − baseline) is overlaid in a warm colormap.
3. The metrics box reports changed-voxel %, whether the scans shared a grid
   (fast path, no registration needed), and the registration metric.
   Positive (warm) = follow-up greater than baseline.

---

## 4. Notes & limitations

- The lesion report does **not** assign a vascular (arterial) territory. The
  earlier centroid-based heuristic was clinically unreliable and has been
  removed; read territory from a validated source instead.
- Eloquent proximity uses the Jülich atlas; distances are sampled in mm and
  reported as approximate ("≈").
- DICOM and longitudinal features are server-dependent and intentionally have
  no in-browser fallback for the heavy computation.
- All work is on the `feature/clinical-roadmap` branch.
