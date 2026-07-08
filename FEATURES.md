# NeuroVue — Feature & Architecture Documentation

> **Audience:** Future contributors, researchers, and clinical collaborators.
> **Scope:** Every feature, fix, refactor, and architectural decision from the initial commit to the current state of the `feature/clinical-roadmap` branch.
> **Update policy:** This file must be updated whenever a major feature, refactor, or architectural change is merged.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Core Application Architecture](#core-application-architecture)
3. [Visualization System (NiivueViewer)](#visualization-system-niivueviewer)
4. [Overlay & Layer Management](#overlay--layer-management)
5. [Atlas & Retinotopy System](#atlas--retinotopy-system)
6. [Crosshair & Coordinate System](#crosshair--coordinate-system)
7. [Lesion Analysis Pipeline](#lesion-analysis-pipeline)
8. [Drawing & Segmentation Tools](#drawing--segmentation-tools)
9. [Measurement & Windowing Tools](#measurement--windowing-tools)
10. [Activation Clustering](#activation-clustering)
11. [Eloquent-Structure Proximity Warning](#eloquent-structure-proximity-warning)
12. [Session Persistence (Workspace System)](#session-persistence-workspace-system)
13. [DICOM Import Pipeline](#dicom-import-pipeline)
14. [Longitudinal Comparison](#longitudinal-comparison)
15. [Tractography Support](#tractography-support)
16. [Asymmetric View Layout](#asymmetric-view-layout)
17. [Configuration System](#configuration-system)
18. [GPU / WebGL Rendering Layer](#gpu--webgl-rendering-layer)
19. [Desktop Integration (Electron)](#desktop-integration-electron)
20. [Backend Architecture (FastAPI)](#backend-architecture-fastapi)
21. [Security Hardening](#security-hardening)
22. [Bug Fixes & Stability Improvements](#bug-fixes--stability-improvements)
23. [Refactors & Codebase Cleanup](#refactors--codebase-cleanup)
24. [Performance Optimizations](#performance-optimizations)
25. [Research Utilities](#research-utilities)
26. [Future Planned Features](#future-planned-features)
27. [Project Evolution Summary](#project-evolution-summary)

---

## Project Overview

**NeuroVue** is a production-grade clinical neuroimaging desktop application for real-time 3D brain scan visualization, lesion analysis, and research workflows. It targets neurologists, neuroscientists, and clinical researchers who need a fast, self-contained tool that works both as a standalone desktop app and as a browser-accessible web viewer.

**Technology foundation:**

| Layer | Technology | Version |
|---|---|---|
| Desktop shell | Electron | 33 |
| UI framework | React | 19.0.0 |
| Neuroimaging renderer | Niivue (WebGL) | 0.68.2 |
| Styling | Tailwind CSS + Radix UI | 3.4.17 |
| Optional backend | FastAPI | latest |
| PDF export | jsPDF | 4.2.1 |
| Routing | React Router | 7.5.1 |

**Deployment modes:**
- **Web:** `http://localhost:3000` (React dev server) — no installation required
- **Desktop:** Electron app packaged for Windows / macOS / Linux via electron-builder
- **Backend (optional):** FastAPI server on port 8001 — required only for DICOM conversion and longitudinal registration

---

## Core Application Architecture

### Purpose

Establish a scalable, maintainable architecture that separates rendering concerns (WebGL canvas via Niivue) from clinical analysis logic (atlas lookups, affine math, report generation) and UI state management (React).

### Implementation

The application follows a **unidirectional data flow** with a single master layout component:

```
Dashboard.jsx
 ├── Topbar controls (slice mode, workspace, screenshot, toggles)
 ├── Sidebar (9 collapsible sections)
 │    ├── Base Volume
 │    ├── Lesion Masks
 │    ├── ROIs
 │    ├── Activation Maps
 │    ├── Draw Lesion
 │    ├── Measurements
 │    ├── Atlases
 │    ├── Retinotopy
 │    ├── Tractography
 │    └── Longitudinal
 └── Main viewer area
      ├── NiivueViewer (WebGL canvas + overlay divs)
      ├── ColorBarStack
      └── CrosshairInfo bar
```

**State management:** All application state lives in `Dashboard.jsx` as ~21 `useState` hooks. The `NiivueViewer` component is controlled via an **imperative handle** (`useImperativeHandle` + `forwardRef`) rather than props-driven re-renders. This is intentional — the Niivue WebGL instance is stateful and long-lived; driving it through React props would cause unnecessary re-renders and GPU state resets.

**Library abstraction:** All domain logic is extracted into `frontend/src/lib/`:

| Module | Responsibility |
|---|---|
| `atlasConfig.js` | Atlas URLs, label arrays, retinotopy definitions |
| `workspace.js` | Workspace serialize / deserialize |
| `dicom.js` | Backend availability probe + conversion API client |
| `lesionReport.js` | Clinical metric computation + TXT/PDF generation |
| `volumeAnalysis.js` | Affine-aware voxel operations, grid math |
| `measure.js` | Distance, diameter (PCA), midline shift |
| `longitudinal.js` | Registration API client |
| `eloquent.js` | White-matter proximity lookup |
| `windowing.js` | CT/MRI window preset resolution |
| `colormaps.js` | Custom colormap definitions |
| `visfAtlasColormap.js` | visfAtlas color mapping |

### Files Added/Modified

- `frontend/src/pages/Dashboard.jsx` (~1 100 lines)
- `frontend/src/components/NiivueViewer.jsx` (~1 000 lines)
- `frontend/src/lib/*.js` (11 library modules)
- `frontend/src/App.js` (root routing)

### Impact

Clean separation of concerns allows individual features to be developed and tested in isolation. The imperative viewer API means adding a new overlay type or control requires only a new method on the handle — no new props threading through the component tree.

### Notes

The sidebar grows linearly with feature count. A future refactor could extract each section into its own route with code splitting, but the current single-page layout keeps time-to-first-interaction fast and avoids navigation state management.

---

## Visualization System (NiivueViewer)

### Purpose

Provide a zero-latency, hardware-accelerated renderer for NIfTI/MGZ/DICOM brain scans with support for overlays, custom layouts, colormaps, and real-time crosshair navigation.

### Implementation

**NiivueViewer** wraps the [Niivue](https://github.com/niivue/niivue) WebGL library. The canvas is attached once on mount and the Niivue instance (`nv`) lives for the entire component lifecycle — it is never re-created on re-render.

**Slice modes** map to Niivue's `SLICE_TYPE` constants:

| UI Label | Niivue SLICE_TYPE | Description |
|---|---|---|
| Multiplanar | `MULTIPLANAR` | 2×2 grid (axial, coronal, sagittal, render) |
| Axial | `AXIAL` | Single horizontal cross-section |
| Coronal | `CORONAL` | Single front-back cross-section |
| Sagittal | `SAGITTAL` | Single left-right cross-section |
| Render | `RENDER` | 3D volume rendering |

**Custom layout (asymmetric mode):** Niivue's `nv.customLayout` API accepts an array of `{ sliceType, position: [x, y, w, h] }` entries in normalized 0–1 canvas coordinates. This is used to implement the asymmetric 1-large + 3-small layout.

**Imperative API surface** exposed via `useImperativeHandle`:
- Volume: `addOverlayFromUrl`, `addOverlayFromFile`, `removeOverlayByName`, `replaceBaseVolume`
- Display: `setOverlayOpacity`, `setOverlayColormap`, `setOverlayCalRange`, `setOverlayVisible`, `setBaseVisible`
- Navigation: `setCrosshairMM`, `getCrosshairMM`
- Drawing: `setDrawingEnabled`, `setDrawingTool`, `saveDrawing`, `clearDrawing`
- Segmentation: `setClickToSegment`, `getClickToSegmentVolume`
- Layout: `setAsymmetricLayout`, `setSliceType`
- Mesh: `addMeshFromFile`, `removeMeshByName`, `setMeshVisible`, `toggleTractRGBColor`
- Utility: `saveScreenshot`, `getSliceAtCanvasPx`

**Stale-closure pattern:** Canvas event listeners (dblclick, mousemove, mouseleave) are registered once at mount. All callbacks that must reference fresh React state are routed through `useRef` — `onDoubleClickSliceRef`, `onLocationChangeRef`, `sideLayoutRef`. This prevents the classic event-listener stale-closure bug where captured state values are frozen at the time of listener registration.

**Custom colormaps** are registered at initialization:
- `visfAtlas` (11-color categorical map for ventral-temporal visual areas)
- `polar_angle_0_360` (custom circular red→yellow→blue→cyan→red for retinotopy)

### Files Added/Modified

- `frontend/src/components/NiivueViewer.jsx`
- `frontend/src/lib/colormaps.js`
- `frontend/src/lib/visfAtlasColormap.js`

### Impact

All neuroimaging rendering is encapsulated in one component. Dashboard never touches WebGL directly. Adding a new slice type, overlay type, or interaction requires only a new method on the imperative handle.

### Notes

Niivue 0.68.2 uses WebGL 1.0 (OpenGL ES 2.0) for maximum compatibility. A future upgrade to WebGL 2.0 would unlock float32 textures for higher-precision overlay rendering.

---

## Overlay & Layer Management

### Purpose

Allow users to load, visualize, and configure an unlimited number of neuroimaging layers (lesion masks, ROIs, activation maps, atlases, retinotopy maps) on top of the base volume.

### Implementation

Each overlay is tracked in Dashboard as an entry in one of several `useState` arrays:

```
userLayers: [{id, name, type, url, visible, opacity, colormap, calMin, calMax, ignoreZeroVoxels, invertThreshold}]
tractLayers: [{id, name, visible, url}]
atlasState: {atlasId → {visible, opacity}}
retState: {retLayerId → {visible, opacity, colormap}}
```

**Layer types and defaults:**

| Type | Default colormap | Default opacity | Notes |
|---|---|---|---|
| `lesion` | `red` | 0.85 | Red mask; volume/centroid computed on add |
| `roi` | Cycled (green→blue→viridis→warm) | 0.60 | Multi-label regions |
| `activation` | `warm` | 0.80 | T-stat / z-score maps |
| `atlas` | Per-atlas config | 0.60 | Standard atlases (AAL, HO, etc.) |
| `retinotopy` | Per-layer config | 0.70 | Polar angle, eccentricity, visual areas |

**Per-layer controls** (`LayerControlAdvanced.jsx`):
- Visibility toggle (eye icon)
- Opacity slider (0–100%)
- Colormap picker (dropdown of all Niivue built-in maps + custom)
- Threshold dual-slider: independent cal_min / cal_max
- Ignore-zero-voxels toggle (useful for sparse lesion maps)
- Invert-threshold toggle (show voxels below threshold instead of above)
- Atlas picker for activation layers (links region-name lookups to any standard atlas)
- Remove button (calls `removeOverlayByName` + removes from state)

**Color-bar stack** (`ColorBarStack.jsx`): Renders per-layer gradient bars with min/max labels for all continuous overlays currently visible. Positioned as an absolute overlay in the bottom-right of the viewer.

### Files Added/Modified

- `frontend/src/pages/Dashboard.jsx`
- `frontend/src/components/LayerControl.jsx`
- `frontend/src/components/LayerControlAdvanced.jsx`
- `frontend/src/components/ColorBarStack.jsx`

### Impact

Users can compose arbitrarily complex multi-layer views (e.g., lesion mask + activation map + atlas + retinotopy) without performance degradation. Per-layer threshold and colormap controls give research-grade flexibility.

### Notes

Currently, custom atlas overlay (user-supplied parcellation) does not participate in region-name lookups or the lesion-atlas overlap computation — a planned enhancement.

---

## Atlas & Retinotopy System

### Purpose

Provide anatomically labeled reference overlays for the entire brain, with special support for the visual cortex retinotopic organization.

### Implementation

All atlas definitions live in `frontend/src/lib/atlasConfig.js`. Each atlas entry specifies a CDN URL (NIfTI hosted on a public neuroimaging server), a colormap, default opacity, and a label array.

**Six standard atlases:**

| Atlas | Regions | Coverage | Labels source |
|---|---|---|---|
| AAL (Automated Anatomical Labeling) | 116 | Whole brain | JSON array |
| Harvard-Oxford Cortical | 48 | Cortical | JSON array |
| Harvard-Oxford Subcortical | 21 | Subcortical | JSON array |
| Destrieux | 148 | Cortical (fsaverage-based) | JSON array |
| Jülich | variable | White-matter tracts | JSON array |
| visfAtlas (Rosenke et al. 2020) | 11 | Ventral-temporal visual areas | JSON dict |

**Retinotopy layers (Benson et al. 2014, Wang et al. 2015):**

| Layer | Colormap | Range |
|---|---|---|
| Benson Polar Angle | Custom circular (red→yellow→blue→cyan→red) | 0–360° |
| Benson Eccentricity | `warm` | 0–90° visual angle |
| Benson Visual Areas | `actc` (discrete, 12 labels) | V1–V5 |
| Wang Maximum Probability | `warm` | 11 occipital ROIs |

**Lazy loading:** Atlases and retinotopy layers load on first toggle (not on app start). A `ensureAtlasLoaded` helper in Dashboard checks whether an atlas volume is already in NiivueViewer's loaded set before issuing a load call, preventing duplicate network requests.

**Label resolution at crosshair:** On every `onLocationChange` event, Dashboard calls `nv.getAtlasAtMM(mm)` (or equivalent voxel lookup) for each visible atlas, resolving voxel intensity → region name from the label array. The resolved names appear in the crosshair info bar.

**visfAtlas colormap** (`visfAtlasColormap.js`): A custom 11-entry categorical RGBA array registered as a named colormap on Niivue at init time. Required because Niivue has no built-in visual-area colormap.

### Files Added/Modified

- `frontend/src/lib/atlasConfig.js`
- `frontend/src/lib/visfAtlasColormap.js`
- `frontend/src/lib/colormaps.js`
- `frontend/src/components/NiivueViewer.jsx` (colormap registration)
- `frontend/src/pages/Dashboard.jsx` (atlas state, ensureAtlasLoaded)

### Impact

Users can overlay any combination of atlases with a single toggle, see live region labels at the crosshair, and perform lesion-atlas overlap analysis — all without any manual atlas file management.

### Notes

Atlas CDN URLs are pinned to specific NIfTI files. A future enhancement would bundle atlases locally for offline use. The Destrieux atlas is fsaverage-surface-projected to MNI volume, which introduces interpolation artifacts at boundaries.

---

## Crosshair & Coordinate System

### Purpose

Give users real-time anatomical context — knowing where the cursor is in MNI space, which atlas region it falls in, and what intensity values the overlays report — without leaving the viewer.

### Implementation

**Coordinate chain:**
1. Niivue fires `onLocationChange(data)` on every crosshair move with `data.mm` (3-vector in MNI space) and `data.values` (intensity at cursor for each loaded volume).
2. Dashboard's `handleLocationChange` callback updates `crosshairMM` state and runs label lookups.
3. `CrosshairInfo.jsx` renders the result as a compact bar below the viewer.

**Display fields:**
- MNI coordinates: `(x, y, z)` mm, 1 decimal place
- Voxel coordinates: `(i, j, k)` in base volume space
- Per-overlay values: intensity at crosshair for each visible overlay
- Atlas region labels: one label per visible atlas, empty string if background

**Eloquent proximity chip:** If `eloquentWarn` is enabled, `CrosshairInfo` also shows a color-coded chip (green / amber / red) with the nearest white-matter tract name and distance in mm (see [Eloquent-Structure Proximity Warning](#eloquent-structure-proximity-warning)).

### Files Added/Modified

- `frontend/src/components/CrosshairInfo.jsx`
- `frontend/src/pages/Dashboard.jsx` (`handleLocationChange`, `crosshairMM` state)
- `frontend/src/components/NiivueViewer.jsx` (`onLocationChange` ref pattern)

### Impact

Eliminates the need to open a separate tool for coordinate/label lookup. The live display is essential for guided lesion drawing and atlas-based anatomical navigation.

### Notes

Label resolution for large atlases (AAL, Destrieux) adds ~1 ms of synchronous array lookup per crosshair event. At typical crosshair update rates this is imperceptible, but for extremely dense interaction (e.g., programmatic sweep) it could be batched.

---

## Lesion Analysis Pipeline

### Purpose

Automate the clinical work of measuring and characterizing a lesion — replacing manual region-of-interest drawing with computed metrics, atlas overlap, and a ready-to-paste clinical report paragraph.

### Implementation

**Core metrics** (computed in `frontend/src/lib/lesionReport.js` and `volumeAnalysis.js`):

| Metric | Method |
|---|---|
| Volume (mm³ / cm³) | Count non-zero voxels × \|det(affine)\| |
| Centroid (MNI mm) | Intensity-weighted center of mass in voxel space → transform via affine |
| Per-atlas overlap (%) | Affine-aware voxel intersection (lesion grid → atlas grid via inverse affine) |

**Affine-aware intersection** (`volumeAnalysis.js`): The lesion and atlas may be on different grids (different resolution, origin, or orientation). The overlap computation: (1) reads both NIfTI affine matrices, (2) iterates over each non-zero lesion voxel, (3) transforms it to MNI mm via the lesion affine, (4) transforms back to atlas voxel space via the inverted atlas affine, (5) rounds to nearest integer index, (6) looks up the atlas label. This handles arbitrary grid mismatches without resampling.

**Report generation** (`lesionReport.js`): Formats all metrics into a structured clinical paragraph:
> *"A lesion of 4.2 cm³ is centered at MNI (−42, 12, 28). It involves 38% of left precentral gyrus (AAL) and 22% of left superior frontal gyrus (AAL)."*

**PDF export** uses `jsPDF` (no server required). TXT export uses a Blob URL download.

**Lesion-Atlas Overlap Panel** (`OverlapPanel.jsx`): Interactive table showing the full breakdown across all standard atlases. Sortable by overlap %. CSV export for data analysis.

**Activation Cluster Panel** (`ClusterPanel.jsx`): Connected-component analysis on activation maps. Identifies spatially contiguous super-threshold voxel groups; reports each cluster's size, peak value, peak location (voxel + MNI mm), and centroid. Optional atlas region label at the peak. CSV export.

### Files Added/Modified

- `frontend/src/lib/lesionReport.js`
- `frontend/src/lib/volumeAnalysis.js`
- `frontend/src/components/LesionReportPanel.jsx`
- `frontend/src/components/OverlapPanel.jsx`
- `frontend/src/components/ClusterPanel.jsx`
- `frontend/src/pages/Dashboard.jsx`

### Dependencies

- `jsPDF 4.2.1` — in-browser PDF generation, no server required

### Impact

What previously required FSL `fslstats`, custom Python scripts, and manual atlas lookup can now be done in one click with TXT or PDF output. The voxel-accurate affine-aware overlap computation handles mixed-resolution datasets correctly.

### Notes

- Vascular territory is **not** reported. The previous centroid-based heuristic was clinically unreliable and has been removed; a future release may bundle a validated vascular atlas (e.g. Thiebaut de Schotten 2011) for accurate territory assignment.
- Cluster analysis has no statistical correction (no FDR, no permutation testing). Raw suprathreshold clusters only.
- Custom-atlas overlap is not yet implemented; only the 6 standard atlases are supported.

---

## Drawing & Segmentation Tools

### Purpose

Allow users to manually delineate lesion boundaries or use semi-automatic seed-growing segmentation — creating NIfTI masks for downstream analysis without leaving the viewer.

### Implementation

**Manual drawing tools** (via Niivue drawing API):

| Tool | Behavior |
|---|---|
| Pen | Freehand voxel painting at configurable radius |
| Rectangle | Draw a filled/outlined rectangular ROI |
| Ellipse | Draw a filled/outlined elliptical ROI |
| Undo | Step-back one drawing operation |
| Clear | Wipe entire drawing bitmap |

Drawing operates on Niivue's internal draw bitmap (separate from the loaded volumes). Pen radius is adjustable (1–20 voxels). Filled vs. outline toggle controls whether only the boundary or the interior is painted.

**Smart segmentation (click-to-segment):**
Wraps Niivue's native `clickToSegment` function, which grows a region from the clicked seed voxel by intensity similarity (flood-fill variant):
- **Tolerance:** 0–100% of the dynamic range — controls how aggressively the seed expands into neighboring voxels
- **2D vs 3D:** whether to expand within the current slice only or across the full 3D volume
- **Max distance (mm):** hard radius constraint on expansion (0 = unlimited)
- **Volume feedback:** live segmented volume (mL) display updated after each seed click

**Save as NIfTI:** Calls Niivue's `saveImage({ isSaveDrawing: true })` which writes the drawing bitmap as a binary NIfTI mask. In the desktop build, this triggers Electron's native save dialog. In the browser, it triggers a blob download.

### Files Added/Modified

- `frontend/src/components/DrawingPanel.jsx`
- `frontend/src/components/NiivueViewer.jsx` (drawing + segmentation methods)
- `frontend/src/pages/Dashboard.jsx` (drawing state)

### Impact

Reduces the segmentation workflow from: launch FSL/ITK-SNAP → draw → export → load back → analyze, to: draw in NeuroVue → analyze immediately. The click-to-segment mode makes initial lesion outlines in seconds rather than minutes.

### Notes

Click-to-segment uses Niivue's built-in algorithm, which is an intensity-similarity flood fill. It is not a deep-learning segmentation model. For complex lesions with heterogeneous intensity, manual refinement via the pen tool is recommended.

---

## Measurement & Windowing Tools

### Purpose

Provide quick quantitative measurements (linear distances, lesion diameter, midline shift) and CT/MRI window-level presets directly from the viewer — eliminating context-switches to external tools.

### Implementation

**Measurement tools** (`frontend/src/lib/measure.js`):

| Tool | Method | Output |
|---|---|---|
| 2-point ruler | User clicks two crosshair positions; Euclidean distance in MNI mm | Distance (mm) |
| Lesion max diameter | PCA on lesion voxel set; length of first principal component | Diameter (mm) |
| Midline shift | Detect displacement of midline structures relative to anatomical midplane | Shift (mm) |

**PCA-based diameter:** Reads the lesion mask voxels from the Niivue volume array, builds a 3×N coordinate matrix (voxel → MNI mm via affine), computes SVD, extracts the first singular vector (the principal axis), and projects all voxel coordinates onto it to find min/max extent. This gives the longest axis of the lesion regardless of orientation — more accurate than a bounding-box diameter.

**CT Window presets** (`frontend/src/lib/windowing.js`):

| Preset | Center | Width | Use case |
|---|---|---|---|
| Brain | 40 HU | 80 HU | Standard brain CT |
| Stroke | 35 HU | 35 HU | Subtle hyperdensity |
| Soft Tissue | 60 HU | 400 HU | General soft tissue |
| Bone | 400 HU | 1800 HU | Bony structures |
| Full Range | — | — | Reset to auto |

Window presets call `nv.setCalMinMax()` on the base volume to apply the selected Hounsfield unit window without reloading the volume.

### Files Added/Modified

- `frontend/src/components/MeasurePanel.jsx`
- `frontend/src/lib/measure.js`
- `frontend/src/lib/windowing.js`
- `frontend/src/components/NiivueViewer.jsx` (calMin/calMax API)

### Impact

CT windowing is essential for reading DICOM-imported scans. Lesion diameter and midline shift are standard clinical reporting metrics. Having them integrated eliminates the FSL / OsiriX round-trip.

### Notes

Midline shift detection is landmark-assisted (user identifies two landmarks). A fully automated midline shift algorithm (falx cerebri detection) is a future enhancement.

---

## Activation Clustering

### Purpose

Identify and characterize spatially contiguous clusters of super-threshold activation voxels in fMRI/PET activation maps — a standard step in neuroimaging analysis.

### Implementation

`ClusterPanel.jsx` and logic in `volumeAnalysis.js` implement a 3D 26-connectivity connected-component labeling algorithm:
1. User selects an activation layer from a dropdown.
2. User sets a threshold value.
3. The component reads the raw voxel data from Niivue (`nv.getVolumeAt`), applies the threshold mask, and runs connected-component labeling.
4. For each cluster: size (voxels), peak intensity value, peak location (voxel indices + MNI mm via affine), centroid (MNI mm).
5. Optional: if a label atlas is selected, the atlas region at the peak voxel is resolved.
6. Results displayed in a sortable table. CSV export for downstream analysis.

### Files Added/Modified

- `frontend/src/components/ClusterPanel.jsx`
- `frontend/src/lib/volumeAnalysis.js`
- `frontend/src/pages/Dashboard.jsx`

### Impact

Replaces `FSL cluster`, `SPM cluster`, or custom Python scripts for basic cluster characterization. Integrated with the atlas system so region labels are resolved automatically.

### Notes

No statistical correction (FDR, Bonferroni, permutation) is implemented. This is intentional: the panel is designed for exploration and visualization, not for inference. Statistical thresholding should be applied before loading activation maps into NeuroVue.

---

## Eloquent-Structure Proximity Warning

### Purpose

Alert the clinician when the crosshair (or a lesion centroid) is within a configurable distance of a critical white-matter structure — assisting with pre-operative planning and lesion characterization.

### Implementation

`frontend/src/lib/eloquent.js` implements the proximity lookup:
1. At app start, `ensureAtlasLoaded("jülich")` loads the Jülich white-matter atlas (invisible, zero opacity) so its voxel data is available.
2. On every `onLocationChange` event, `eloquentProximityMM(atlasVoxels, currentMM, affine)` searches for the nearest non-zero Jülich voxel by scanning a sphere of increasing radius (coarse grid search + distance verification).
3. Returns `{ tractName, distanceMM }`.

**Distance-to-color mapping:**
- < 5 mm → red chip (danger)
- 5–15 mm → amber chip (caution)
- > 15 mm or off → gray/none

**Toggle:** The "Eloquent Warn" button in the topbar enables/disables the lookup. When disabled, no proximity computation runs, eliminating the per-event overhead.

**Architectural decision:** The Jülich atlas loads at zero opacity (invisible) so it participates in voxel-data availability without cluttering the viewer. This is the "ghost atlas" pattern.

### Files Added/Modified

- `frontend/src/lib/eloquent.js`
- `frontend/src/components/CrosshairInfo.jsx`
- `frontend/src/components/NiivueViewer.jsx`
- `frontend/src/pages/Dashboard.jsx` (`eloquentWarn` state, `ensureAtlasLoaded`)

### Impact

Provides real-time surgical risk awareness during lesion navigation — a feature typically requiring a separate neuro-navigation system. The proximity warning is visible at all times in the crosshair bar, making it impossible to miss.

### Notes

Jülich is a probabilistic atlas thresholded at peak probability. The proximity search is a brute-force radius expansion, which is acceptable for MNI-space volumes (~2 mm isotropic) but would benefit from a KD-tree for sub-millimeter atlases. A future enhancement will allow configuring the danger/caution distance thresholds.

---

## Session Persistence (Workspace System)

### Purpose

Allow users to save and restore a complete NeuroVue session — all loaded volumes, overlay configurations, view settings, and measurements — as a single portable file.

### Implementation

**Workspace format:** A self-contained `.nvws.json` file:
```json
{
  "version": "1.0",
  "sliceType": "multiplanar",
  "asymmetric": false,
  "largeSlice": "axial",
  "crosshair": true,
  "clipDepth": 2,
  "baseVolume": { "id": "mni152", "url": "..." },
  "userLayers": [...],
  "atlasState": {...},
  "retState": {...},
  "tractLayers": [...],
  "overlayMeta": {...}
}
```

**User-uploaded volumes** are embedded as base64-encoded strings so the workspace file is self-contained and portable. Atlas and retinotopy layers reference their CDN URLs (not inlined) since they are fixed public assets.

**Save flow (`workspace.js`):**
1. Serialize all Dashboard state into the workspace object.
2. In Electron: call `window.electronAPI.saveWorkspace(json, suggestedName)` → triggers native Save dialog via IPC.
3. In browser: create a Blob URL, programmatically click a hidden `<a>` element.

**Restore flow:**
1. In Electron: call `window.electronAPI.openWorkspace()` → triggers native Open dialog, returns file content.
2. In browser: `<input type="file">` picker.
3. Parse JSON, re-apply all state to Dashboard and NiivueViewer in the correct order (base volume first, then overlays, then display settings).

**Electron IPC** (`frontend/public/preload.js`, `frontend/public/electron.js`):
- `neurovue:saveWorkspace` — write file to disk via Electron dialog
- `neurovue:openWorkspace` — open file picker, return content
- `neurovue:saveFile` — generic file save (used for drawings, reports)

Context isolation is maintained: the preload script exposes only the specific API methods via `contextBridge`, with no access to raw Node.js APIs.

### Files Added/Modified

- `frontend/src/lib/workspace.js`
- `frontend/public/preload.js`
- `frontend/public/electron.js`
- `frontend/src/pages/Dashboard.jsx` (save/restore handlers)

### Impact

Sessions can be shared between clinicians or reproduced for research. Embedded base64 volumes make the workspace file truly self-contained — no external file paths to maintain.

### Notes

Base64 embedding of large volumes (>50 MB) can produce multi-hundred-MB workspace files. A future enhancement could use reference paths + a checksum instead of full embedding for large volumes.

---

## DICOM Import Pipeline

### Purpose

Allow users to load clinical DICOM series (e.g., CT, MRI) directly into NeuroVue without manually running `dcm2niix` on the command line.

### Implementation

**Architecture:** DICOM conversion runs server-side. The browser cannot reliably decode all DICOM flavors (no decoder is bundled in this Niivue build), so the pipeline delegates to `dcm2niix` via the FastAPI backend.

**Flow:**
1. User selects a folder of `.dcm` files (or a `.zip` archive) via the DICOM import dialog.
2. Frontend calls `GET /api/convert/dicom/available` — a probe that checks whether the `dcm2niix` binary is on the server PATH.
3. If available: `POST /api/convert/dicom` with `multipart/form-data` containing all `.dcm` files.
4. Backend: saves files to a temp directory, runs `dcm2niix -z y -f converted -o outdir indir`, streams back `converted.nii.gz`.
5. Frontend: receives the NIfTI blob, creates an object URL, calls `replaceBaseVolume()` on NiivueViewer.
6. Background task on the server cleans up temp files.

**Availability probe (`frontend/src/lib/dicom.js`):** `checkDicomAvailable()` returns `{ available: bool, message: string }`. The UI shows a warning toast if the backend is unreachable or `dcm2niix` is missing (HTTP 503).

**Error states:**
- Backend not running → 503 → toast "Backend not available"
- `dcm2niix` not on PATH → 503 → toast "dcm2niix not found on server"
- Conversion failed → 422 → toast with error message
- Timeout (>60 s for large series) → 504 → toast "Conversion timed out"

### Files Added/Modified

- `backend/server.py` (`/api/convert/dicom` and `/api/convert/dicom/available` endpoints)
- `frontend/src/lib/dicom.js`
- `frontend/src/components/DicomImportPanel.jsx`
- `frontend/src/pages/Dashboard.jsx`
- `backend/requirements.txt`

### Dependencies

- `dcm2niix` binary (external; must be on server PATH)
- `python-multipart` (FastAPI multipart form handling)
- `FastAPI` (HTTP server)

### Impact

Makes CT and clinical MRI data accessible without any command-line setup for end users. The graceful degradation (probe + toast) ensures users understand why the feature is unavailable rather than silently failing.

### Notes

For privacy-sensitive workflows, the backend should run locally (not on a shared server) since raw DICOM files containing patient metadata are uploaded. A future enhancement could add client-side de-identification before upload.

---

## Longitudinal Comparison

### Purpose

Compare brain scans acquired at different time points (e.g., pre/post surgery, disease progression) by registering the follow-up scan to the baseline and computing a signed difference map.

### Implementation

**Backend pipeline** (`backend/server.py`, `/api/longitudinal/register`):
1. Receives `baseline.nii.gz` and `followup.nii.gz` as multipart form data.
2. Checks if the scans are already on the same grid (same shape + affine) — a "same-grid fast path" that skips registration.
3. If registration is required: runs SimpleITK affine registration (12 DOF; mutual information metric).
4. Resamples the registered follow-up onto the baseline grid (nearest-neighbor for masks, linear for intensity volumes).
5. Computes voxel-wise subtraction: `diff = followup_registered − baseline`.
6. Returns the difference map as `diff.nii.gz` with change metrics in response headers:
   - `X-Change-Volume-MM3`: volume of voxels with |change| > threshold
   - `X-Change-Percent`: fraction of brain volume with significant change
   - `X-Max-Change`: peak absolute voxel change

**Frontend flow** (`frontend/src/lib/longitudinal.js`, `LongitudinalPanel.jsx`):
1. User uploads baseline and follow-up NIfTI files.
2. Client calls `POST /api/longitudinal/register`.
3. Receives diff NIfTI blob → displays as a new overlay (warm colormap, centered at zero).
4. Reads change metrics from response headers and displays in the panel.

**Availability probe:** `GET /api/longitudinal/available` checks for SimpleITK on the Python path. UI degrades gracefully (toast) if unavailable.

### Files Added/Modified

- `backend/server.py` (registration endpoint, availability probe)
- `frontend/src/lib/longitudinal.js`
- `frontend/src/components/LongitudinalPanel.jsx`
- `frontend/src/pages/Dashboard.jsx`
- `backend/requirements.txt` (`SimpleITK`)

### Dependencies

- `SimpleITK` (Python; affine registration + resampling)
- `FastAPI` (HTTP server)

### Impact

Multi-timepoint analysis that previously required FSL FLIRT + fslmaths + manual overlay loading is now a two-file upload with instant visualization. The same-grid fast path makes repeat analysis (e.g., daily ICU monitoring) sub-second.

### Notes

Registration is affine-only (12 DOF). Non-rigid (deformable) registration would better handle significant anatomy changes (e.g., post-resection) but would require ANTs or similar — a future enhancement. Typical registration time: 30–60 seconds for standard MRI.

---

## Tractography Support

### Purpose

Overlay diffusion MRI fiber bundles for white-matter pathway visualization alongside structural scans, enabling surgical planning and connectivity analysis.

### Implementation

Tractography files are loaded via `NiivueViewer.addMeshFromFile()`. Niivue natively supports the following tractography formats:
- `.trk` (TrackVis)
- `.tck` (MRtrix)
- `.trx` (new standard format)
- `.vtk` (VTK polydata)
- `.gii` (GIFTI surface/tractography)
- `.mz3` (Niivue native compressed mesh)

**DTI RGB color-by-direction:** Niivue supports coloring fibers by their local orientation vector (R=left-right, G=anterior-posterior, B=superior-inferior), which is the standard DTI color convention for identifying major tracts. This is toggled via `nv.setMeshProperty(meshIdx, 'colormap', 'dti_rgb')`.

**Layer tracking:** Tract overlays are tracked in a separate `tractLayers` array (distinct from `userLayers`) since they use the mesh API rather than the volume API.

### Files Added/Modified

- `frontend/src/pages/Dashboard.jsx` (tractLayers state)
- `frontend/src/components/NiivueViewer.jsx` (mesh methods)
- `frontend/src/components/LayerControl.jsx` (tract visibility toggle)

### Impact

Enables white-matter pathway visualization without FSL FDT or 3D Slicer. DTI RGB orientation coloring is essential for tract identification at a glance.

---

## Asymmetric View Layout

### Purpose

Allow clinicians to focus on one slice orientation while keeping the other three available for spatial reference — a common workflow in lesion navigation.

### Implementation

**Layout engine:** Niivue's `nv.customLayout` API accepts a positional array:
```javascript
nv.customLayout = [
  { sliceType: SLICE_TYPE.AXIAL,    position: [0.00, 0.00, 0.78, 1.00] }, // large (78% width)
  { sliceType: SLICE_TYPE.CORONAL,  position: [0.78, 0.00, 0.22, 0.33] }, // small (right stack)
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.78, 0.33, 0.22, 0.33] },
  { sliceType: SLICE_TYPE.RENDER,   position: [0.78, 0.67, 0.22, 0.33] },
]
```
Position format: `[x, y, width, height]` in normalized 0–1 canvas coordinates.

**Double-click swap:** A `dblclick` listener on the canvas converts pixel coordinates to normalized canvas coordinates using device pixel ratio (DPR) scaling, then hits-tests each `customLayout` entry to identify which panel was clicked. The resolved slice key is passed to Dashboard via `onDoubleClickSliceRef` (stale-closure-safe ref pattern), which updates `largeSlice` state, triggering a layout re-render.

**Hover overlay design** (added with latest commit):
The three right-side panels are visually interactive — hovering shows:
- A small slice-type label chip in the top-left corner (always visible)
- A cyan border highlight + tinted background
- A centred "Double-click to expand" hint

These are HTML `<div>` overlays absolutely positioned over the WebGL canvas using percentage-based CSS derived from the `customLayout` fractional coordinates. They do not intercept pointer events (`pointer-events: none`), so all WebGL interactions remain functional.

**Bug fix — slice type restoration:** When disabling asymmetric mode, the previous implementation hardcoded `nv.setSliceType(MULTIPLANAR)`. This left the viewer stuck on multiplanar even when the user had been on Sagittal before enabling asymmetric mode. The fix introduces `sliceTypeRef` (tracking the current `sliceType` prop) and uses it in the disable path.

### Files Added/Modified

- `frontend/src/components/NiivueViewer.jsx` (`setAsymmetricLayout`, hover overlays, `sliceTypeRef`, `sideLayout` state)
- `frontend/src/pages/Dashboard.jsx` (`asymmetric`, `largeSlice` state, `handleDoubleClickSlice`)

### Impact

Significant workflow improvement for lesion navigation — the large panel provides detail while the side panels maintain orientation awareness. The visual design makes the interactivity discoverable without documentation.

### Notes

The overlay `<div>` positions are synchronized with the canvas via fractional-to-percentage CSS conversion. If Niivue ever changes its coordinate convention, `setAsymmetricLayout` must be updated in sync.

---

## Configuration System

### Purpose

Allow per-session and per-layer configuration without polluting global state, and provide a deterministic workspace format for session portability.

### Implementation

**Session-level config** (managed in Dashboard state):
- `sliceType`: current slice mode (multiplanar / axial / coronal / sagittal / render)
- `asymmetric` + `largeSlice`: asymmetric layout toggle and focus slice
- `crosshair`: crosshair visibility toggle
- `clipDepth`: clip plane depth (-1 to 2; slider in topbar)
- `eloquentWarn`: eloquent-structure proximity toggle
- `baseLabel`: display name of the current base volume

**Per-layer config** (in each layer entry):
- `opacity`, `colormap`, `calMin`, `calMax`
- `ignoreZeroVoxels`, `invertThreshold`
- `labelAtlasId` (for activation layers: which atlas to use for peak labeling)

**Atlas / retinotopy config** (in `atlasState`, `retState`):
- `visible`, `opacity`, `colormap`

All configuration is serialized into the workspace `.nvws.json` format (see [Session Persistence](#session-persistence-workspace-system)).

**Atlas definitions** (`atlasConfig.js`): A single source of truth for every atlas URL, colormap, label array, and default display settings. Adding a new atlas requires only a new entry in this file — no other code changes needed.

### Files Added/Modified

- `frontend/src/lib/atlasConfig.js`
- `frontend/src/lib/workspace.js`
- `frontend/src/pages/Dashboard.jsx`

### Notes

There is no persistent user preferences store beyond the workspace file. A future enhancement could add a `settings.json` for user preferences (default colormap, default opacity, keybindings) stored in Electron's `app.getPath('userData')`.

---

## GPU / WebGL Rendering Layer

### Purpose

Deliver hardware-accelerated neuroimaging visualization that runs at interactive frame rates on any device with a GPU, without requiring native application installation.

### Implementation

**Niivue** (0.68.2) provides the WebGL rendering:
- **Shader pipeline:** Custom GLSL shaders for volume ray-casting (MIP / isosurface / DVR), slice rendering, mesh rendering.
- **Texture management:** NIfTI volumes are uploaded as 3D WebGL textures. Multiple volumes are composited via additive blending.
- **Colormap LUT:** Each overlay has a per-texture lookup table (256-entry RGBA LUT) stored as a 1D texture.

**Canvas sizing:** The Niivue canvas is sized to fill its container div (`100% × 100%`). On DPR changes (external display hotplug), a ResizeObserver triggers canvas revalidation.

**DPR handling:** Mouse event hit-testing (for double-click panel detection, mousemove hover) scales client-space coordinates by `window.devicePixelRatio` to correctly map to WebGL canvas pixels on high-DPI displays.

**Custom colormaps** registered at init:
- `visfAtlas`: 11-entry categorical colormap (registered via `nv.addColormap()`)
- `polar_angle_0_360`: circular 360-entry gradient for retinotopy polar angle

### Notes

WebGL 1.0 (OpenGL ES 2.0) is used for maximum cross-platform compatibility (Safari, older mobile GPUs). WebGL 2.0 would enable float32 textures for higher-precision overlay values — a potential future upgrade when Safari support matures.

---

## Desktop Integration (Electron)

### Purpose

Package the browser-based viewer as a native desktop application with OS-level file system access (native file dialogs), offline operation, and auto-update support.

### Implementation

**Process architecture:**
- **Main process** (`frontend/public/electron.js`): Window management, IPC handlers, native dialog APIs.
- **Renderer process**: React app running in a BrowserWindow (contextIsolation enabled).
- **Preload script** (`frontend/public/preload.js`): Secure bridge between renderer and main process via `contextBridge.exposeInMainWorld`.

**IPC handlers** registered in main process:

| Channel | Handler | Purpose |
|---|---|---|
| `neurovue:saveWorkspace` | `dialog.showSaveDialog` + `fs.writeFileSync` | Save `.nvws.json` with native dialog |
| `neurovue:openWorkspace` | `dialog.showOpenDialog` + `fs.readFileSync` | Open `.nvws.json` with native dialog |
| `neurovue:saveFile` | `dialog.showSaveDialog` + `fs.writeFileSync` | Save any file (drawings, reports) |

**Security:**
- `contextIsolation: true` (default Electron 12+): renderer cannot access Node.js directly
- `nodeIntegration: false`: no raw Node.js in renderer
- `preload.js` exposes only a narrow API surface (`window.electronAPI`)

**Dev mode detection:** `NEUROVUE_DEV=1` env var (set via `cross-env` in the npm script) causes the main process to load `http://localhost:3000` instead of the built `index.html`. This was fixed for Windows compatibility (direct env var assignment in `package.json` scripts fails on Windows CMD).

**Build targets:**
- Windows: `.zip` (portable)
- macOS: `.dmg`
- Linux: `.AppImage`
Built via `electron-builder 25` with the config in `package.json`.

### Files Added/Modified

- `frontend/public/electron.js`
- `frontend/public/preload.js`
- `frontend/package.json` (electron-builder config, scripts)

### Notes

Auto-update (`electron-updater`) is not yet configured. A future release will add it with a GitHub Releases channel for seamless app updates.

---

## Backend Architecture (FastAPI)

### Purpose

Provide server-side compute for operations too heavy or requiring external binaries not available in the browser: DICOM→NIfTI conversion and affine image registration.

### Implementation

`backend/server.py` is a single-file FastAPI application:

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/convert/dicom/available` | Probe dcm2niix availability |
| POST | `/api/convert/dicom` | Convert DICOM series → NIfTI |
| GET | `/api/longitudinal/available` | Probe SimpleITK availability |
| POST | `/api/longitudinal/register` | Register follow-up → baseline, return diff |

**CORS policy:** Configured via `CORS_ORIGINS` environment variable (space-separated list). `allow_credentials=True` is only set when explicit origins are provided — a security fix from the initial baseline (wildcard + credentials is spec-invalid and browser-rejected).

**Cleanup:** Both conversion and registration create temporary directories for intermediate files. A FastAPI `BackgroundTask` is scheduled to `shutil.rmtree` the temp dir after the response is fully sent.

**Optional dependency pattern:** Both `dcm2niix` (binary) and `SimpleITK` (Python package) are optional. The availability probe endpoints return `{available: false}` gracefully if they are absent, and the frontend degrades to a toast notification rather than a hard error.

### Files Added/Modified

- `backend/server.py`
- `backend/requirements.txt`

### Dependencies

- `fastapi`, `uvicorn` (ASGI server)
- `python-multipart` (form file uploads)
- `python-dotenv` (env var loading)
- `SimpleITK` (optional; image registration)
- `dcm2niix` (external binary; optional)

### Notes

The backend is stateless — no database, no session storage. Motor (async MongoDB driver) appears in some dependency lists but is not currently used; it is a remnant from an earlier architecture and should be removed to avoid confusion.

---

## Security Hardening

### Purpose

Eliminate privacy and security risks before the application handles real patient scan data.

### Implementation

**Removed third-party tracking scripts** (pre-Phase-1 baseline commit):
- `assets.emergent.sh` CDN script removed from `frontend/public/index.html` — was loading an external JavaScript payload, which is unacceptable in a tool handling patient neuroimaging data.
- PostHog session-recording script removed — patient workflow recording is a HIPAA/GDPR concern.

**CORS fix** (`backend/server.py`):
- Original: `allow_origins=["*"]` + `allow_credentials=True` — invalid per CORS spec (browsers reject this combination; Chromium ignores credentials with wildcard).
- Fixed: `allow_credentials=True` only when `CORS_ORIGINS` is explicitly set to a non-wildcard list. Defaults to no-credentials wildcard for development convenience.

**Electron context isolation:**
- `contextIsolation: true` enforced.
- `nodeIntegration: false` enforced.
- Preload exposes only explicitly named API methods — no arbitrary IPC channel exposure.

**Blob URL memory management:**
- `replaceBaseVolume`, `addOverlayFromFile`, `addMeshFromFile` now call `URL.revokeObjectURL()` after Niivue has consumed the blob. Previous implementation leaked object URLs indefinitely.

### Files Added/Modified

- `frontend/public/index.html` (tracking script removal)
- `backend/server.py` (CORS fix)
- `frontend/public/preload.js` (IPC surface audit)
- `frontend/src/components/NiivueViewer.jsx` (blob URL revocation)

### Impact

Application is safe for use in clinical and research environments where patient data confidentiality is required. CORS fix prevents subtle authentication failures in deployed environments.

---

## Bug Fixes & Stability Improvements

### Double-click stale-closure fix

**Problem:** The `dblclick` canvas listener was registered once at mount and captured `asymmetric` state in its closure. After enabling asymmetric mode, the listener still saw `asymmetric=false` and the swap was silently a no-op.

**Fix:** Route the callback through `onDoubleClickSliceRef` — a `useRef` updated on every render. The listener always calls `onDoubleClickSliceRef.current()`, which is always the freshest closure.

**Files:** `NiivueViewer.jsx`, `Dashboard.jsx`

---

### `onLocationChange` stale-closure fix

**Problem:** Same class of bug as above: `nv.onLocationChange` was assigned once and captured stale Dashboard state, causing crosshair-driven features (eloquent proximity, label lookups) to malfunction after certain state changes.

**Fix:** `onLocationChangeRef` pattern — identical to the dblclick fix.

**Files:** `NiivueViewer.jsx`

---

### Slice type restoration bug (asymmetric → other view)

**Problem:** `setAsymmetricLayout(null)` hardcoded `nv.setSliceType(MULTIPLANAR)` in the disable path. If the user was on Sagittal before enabling asymmetric mode, disabling asymmetric would leave them on Multiplanar because the `sliceType` prop hadn't changed (so NiivueViewer's sliceType effect didn't re-run).

**Fix:** Introduced `sliceTypeRef` (mirrors `sliceType` prop via a ref/effect pattern). The disable path now calls `nv.setSliceType(sliceMap[sliceTypeRef.current])`.

**Files:** `NiivueViewer.jsx`

---

### Electron dev mode Windows fix

**Problem:** `NODE_ENV=development electron .` in `package.json` scripts fails on Windows CMD because inline env-var assignment is a Bash/Unix-ism.

**Fix:** Use `cross-env NEUROVUE_DEV=1 electron .` which handles env var injection cross-platform.

**Files:** `frontend/package.json`

---

## Refactors & Codebase Cleanup

### Foundational Refactor (commit: `8895f69`)

**Purpose:** Extract domain logic from Dashboard into testable library modules.

**Changes:**
- Affine math helpers (`invertMat4`, `voxToMM`, `mmToVox`, `getDims`) exported from `volumeAnalysis.js` for shared use across lesion analysis, clustering, and measurements.
- `ensureAtlasLoaded` helper extracted to Dashboard as a shared guard against duplicate atlas loads.
- `eloquent.js` created as a standalone proximity module — previously the proximity logic was inline in the crosshair handler.

**Impact:** Each library module can be unit-tested independently. Adding new analysis tools requires importing from `volumeAnalysis.js` rather than duplicating affine math.

---

### `useImperativeHandle` API Design

**Decision:** NiivueViewer exposes a large imperative API (~25 methods) rather than accepting props for every configuration dimension.

**Reasoning:** Niivue is a stateful WebGL renderer. Applying state changes via props would require NiivueViewer to diff every prop on every render and decide which Niivue API to call — fragile and over-engineered. The imperative handle is explicit: callers call `viewerRef.current.setOverlayOpacity(id, value)` and the effect is immediate and predictable.

**Trade-off:** Tighter coupling between Dashboard and NiivueViewer's internal API. Accepted because they are tightly coupled by design — Dashboard is the only consumer.

---

### Stale-Closure Ref Pattern

**Decision:** All canvas event listeners route through `useRef` guards instead of re-registering on every state change.

**Reasoning:** Re-registering `addEventListener`/`removeEventListener` pairs on each render is error-prone (potential duplicate listeners, GC pressure). The ref pattern registers once at mount and always calls through the freshest ref value.

**Applied to:** `onDoubleClickSliceRef`, `onLocationChangeRef`, `sideLayoutRef`, `sliceTypeRef`.

---

## Performance Optimizations

### Lazy Atlas Loading

Atlases (~100 MB total) are not prefetched on app start. Each atlas loads on first toggle via `ensureAtlasLoaded`. This reduces initial load time significantly and avoids downloading data the user never needs.

### Ghost Atlas Pattern

The Jülich atlas for eloquent proximity is loaded at zero opacity (invisible, no GPU rendering). It occupies a WebGL texture slot but adds zero rendering overhead. This allows voxel-data lookups without visual clutter.

### Per-Event Proximity Guard

The eloquent proximity computation only runs when `eloquentWarn` is true. The toggle eliminates all per-event overhead (nearest-neighbor search) when the feature is not needed.

### Blob URL Revocation

Object URLs created for user-uploaded files are revoked immediately after Niivue has consumed the data. This prevents indefinite memory growth in long sessions with many file uploads.

### `useCallback` for Event Handlers

`handleDoubleClickSlice`, `handleLocationChange`, and other frequently-called handlers are wrapped in `useCallback` to prevent unnecessary child re-renders.

---

## Research Utilities

### Atlas Validation Panel (`AtlasValidationPanel.jsx`)

A modal panel displaying side-by-side comparisons of Benson/Wang surface retinotopy projections against the volume overlays currently loaded. Designed for researchers verifying that the MNI-projected retinotopy maps align with individual anatomy.

### Polar Angle Disc & Eccentricity Bar

Custom SVG legend components (`PolarAngleDisc.jsx`, `EccentricityBar.jsx`) rendered as floating overlays when retinotopy layers are active. These show the color-to-angle mapping in the standard retinotopy colorwheel convention, making the visualization interpretable without external reference.

### Activation Cluster CSV Export

The `ClusterPanel.jsx` exports full cluster tables as CSV (cluster ID, size, peak value, peak MNI mm, centroid MNI mm, atlas region). Directly importable into Excel, R, or Python for statistical analysis.

### Lesion-Atlas Overlap CSV Export

`OverlapPanel.jsx` exports per-region overlap percentages as CSV. Enables population-level analyses across multiple subjects when combined with external scripts.

### Workspace Files as Research Artifacts

`.nvws.json` workspace files embed all loaded volumes and configuration. They can serve as reproducible research artifacts: sharing a workspace file re-creates the exact visualization state used in a publication figure.

---

## Future Planned Features

The following enhancements are documented in `PROGRESS.md` and the `feature/clinical-roadmap` branch planning:

| Feature | Description | Priority |
|---|---|---|
| Non-rigid registration | ANTs/NiftyReg deformable registration for longitudinal comparison | High |
| Statistical cluster correction | FDR / permutation-based thresholding in ClusterPanel | High |
| Validated vascular atlas | Add accurate territory assignment via the Thiebaut de Schotten atlas (heuristic territory was removed) | Medium |
| Automated midline shift detection | Falx cerebri detection for mass effect quantification | Medium |
| Custom atlas region labels | Lesion-atlas overlap for user-supplied parcellations | Medium |
| KD-tree for eloquent proximity | Replace radius-expansion with spatial index for sub-mm atlases | Low |
| Auto-update (Electron) | electron-updater with GitHub Releases channel | Medium |
| Offline atlas bundling | Bundle atlases locally for air-gapped clinical environments | High |
| User settings persistence | Electron `app.getPath('userData')` settings store | Low |
| DICOM de-identification | Strip patient metadata before upload to backend | High |
| Deep learning segmentation | Integration with TotalSegmentator or nnU-Net for automated masks | Future |

---

## Project Evolution Summary

NeuroVue began as a general-purpose neuroimaging viewer (Niivue-based) with multi-overlay support, atlas overlays, retinotopy visualization, and basic crosshair navigation — the baseline commit (`b9e871f`). The initial codebase had several security issues (embedded tracking scripts, CORS misconfiguration) and subtle React bugs (stale closures in canvas event listeners, blob URL leaks) that were addressed in the first cleanup pass.

**Phase 1** (commits `8895f69` → `617f965`) transformed the viewer into a clinical analysis tool. The architectural refactor extracted all domain logic into library modules, creating a clean separation between rendering (NiivueViewer), analysis (lib/), and layout (Dashboard). Five clinical features were added in rapid succession: lesion reporting with PDF export, eloquent-structure proximity warning, session persistence, measurement tools, and semi-automatic segmentation. Each feature built on the previous — the affine math helpers unlocked accurate lesion volume, which enabled the report; the report required session persistence to be useful clinically; the proximity warning reused the atlas infrastructure already in place.

**Phase 2** (commit `8660ce0`) added the first server-dependent feature: DICOM import. This established the backend architecture pattern (FastAPI, availability probes, graceful degradation) that Phase 3 would reuse.

**Phase 3** (commit `d5a78ef`) added longitudinal registration — the first feature that performs significant compute (SimpleITK affine registration). The same-grid fast path and the availability probe pattern ensured the feature degrades cleanly when the backend is not running.

The most recent work (`feature/clinical-roadmap` HEAD) addresses UX polish: the asymmetric view now has rich hover overlays (slice labels, visual affordance for double-click interaction) and the long-standing slice-type restoration bug was fixed using the same stale-closure ref pattern established in Phase 1.

The system has evolved from a viewer into a lightweight clinical workstation — capable of lesion characterization, surgical proximity assessment, multi-timepoint comparison, and structured report generation — while remaining deployable as a single-page web app or a packaged Electron desktop application with no external dependencies beyond the optional backend.
