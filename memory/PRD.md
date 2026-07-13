# NeuroVue · Neuroimaging Visualization Dashboard

## Original Problem Statement
Create a neuroimaging visualization dashboard using React and @niivue/niivue.
1. UI: Dark-themed, professional dashboard with a large central viewing area and a sidebar for layer management.
2. Views: Niivue synced 3D view and 3-plane (axial, sagittal, coronal) multiaxial view.
3. Base Image: MNI152 template by default.
4. Overlays: Toggleable layers for Wang 2015 Probabilistic Atlas and Benson 2014 Retinotopy (Angle/Eccentricity).
5. Lesion Support: 'Load Lesion Mask' button that overlays .nii.gz/.mgz in red.
6. Controls: Opacity sliders per layer + 'Clip Plane' slider for 3D.
7. Integration: Reference nben/occipital_atlas (FreeSurfer-style .mgz or .nii volumes).
8. User addition: Polar angle rainbow colormap with circular disc color scale; ROI upload option.

## Tech Stack
- **Frontend**: React 19, @niivue/niivue, Tailwind, Shadcn UI, lucide-react, sonner
- **Backend**: FastAPI scaffold (currently only the default Hello World; lesion processing is client-side)
- **Data**: MNI152 template + generated MNI152-space Wang/Benson volumetric atlases (under /app/frontend/public/atlases/)

## Implementation Status (as of 2026-02-XX)

### Implemented (P0)
- Dark Swiss-grid theme (IBM Plex Sans + JetBrains Mono fonts)
- Niivue multiplanar (axial/coronal/sagittal) + 3D synced view
- MNI152 template auto-loads on mount
- Wang 2015 ROI atlas overlay (11 occipital regions: V1d/v, V2d/v, V3d/v, hV4, VO1, LO1, TO1, V3A)
- Benson 2014 Polar Angle (0–360° hsv/rainbow), Eccentricity (warm), Visual Area Labels
- Per-layer visibility toggle, opacity slider, colormap selector
- Lesion mask upload (.nii / .nii.gz / .mgz / .mgh) → overlaid in red
- Custom ROI upload with auto-cycling colormaps (green/blue/winter/warm/plasma/viridis)
- Polar Angle color disc (conic-gradient rainbow with UVM/RHM/LVM/LHM tick labels)
- Eccentricity color bar legend
- Clip Plane slider (range -1 to 2, default off=2)
- View mode switcher (Multiplanar+3D / 3D Render / Axial / Coronal / Sagittal)
- Crosshair toggle, screenshot export
- Orient cube indicator in 3D view
- Tract / mesh upload (.trk / .tck / .trx / .vtk / .gii / .mz3) via NVMesh.loadFromFile with DTI direction colouring
- Individual remove buttons per uploaded overlay (lesion / ROI / activation / custom-atlas / tract)
- Clear-All overlays button (aggressively wipes meshes + drawing + overlay GL textures)
- Conte69 inflated brain surface (LH / RH) toggle with optional volume overlay projection
  (Polar Angle / Eccentricity / Visual Areas / Wang prob / active Lesion mask)
- Standard atlases (AAL · Harvard-Oxford · Jülich · Destrieux) with cluster analysis + lesion-atlas overlap

### Desktop (Windows) build (2026-02-14)
- Wrapped in **Electron 33** so the dashboard ships as a native Windows app
- All atlas data (~11 MB) bundled inside `app.asar` → runs **fully offline**
- HashRouter replaces BrowserRouter so the app works under `file://`
- `yarn dist:win` produces `dist-electron/NeuroVue-0.1.0-x64.zip` (~160 MB compressed, 522 MB extracted)
- Documentation: see `/app/frontend/DESKTOP_BUILD.md`
- Build artefact location: `/app/frontend/dist-electron/`
- NSIS installer target available but requires x64 host (current preview container is arm64)

### visfAtlas + Benson colormap + interactive inflated brain (2026-02-14, iter 16)
- **De-highlighted "Verify Atlas"** topbar button — same neutral zinc styling as Clear All / Crosshair / Screenshot
- **Interactive rotatable 3D inflated brain** inside the Verify Atlas modal:
  - New `InflatedBrainViewer.jsx` spins up its own niivue instance loading the fsaverage inflated LH+RH GII meshes with the Benson scalar `.gii` files as vertex layers
  - Per-row toggle in the Atlas Verification modal: "Static plots" ↔ "Interactive 3D"
  - Mouse drag rotates · scroll zooms · proper polar-angle / eccentricity / visual-areas legend in bottom-right
  - WebGL context released on unmount (`WEBGL_lose_context`)
- **Custom Benson polar_angle colormap** registered via `nv.addColormap("polar_angle", ...)` at niivue init — 5 stops (blue → red → yellow → green → cyan-blue) matching neuropythy's published convention. Same colormap baked into `InflatedBrainViewer` so its mini-viewer matches the main viewer.
- **visfAtlas (Rosenke et al. 2020, bioRxiv 2020.01.22.916239)** as a new standard atlas option:
  - User-uploaded `.nii.gz` + `.xml` + `.cmap` placed in `/app/frontend/public/atlases/`
  - 33 categorical ROIs across higher visual cortex (FFA / PPA / EBA / hMT / V1-V3 d/v retinotopic per hemisphere)
  - Custom categorical colormap inlined as `src/lib/visfAtlasColormap.js` (avoids async-fetch race)
  - Applied via niivue's proper label-volume API: `vol.setColormapLabel(VISFATLAS_COLORMAP)` after volume add
  - `colormap` dropdowns updated to include `polar_angle` + `visfAtlas`
  - `loadAtlasLabels` extended to handle dict-shaped JSON (`{"1":"lh_mFus_faces",...}`) in addition to array-of-objects
  - URL-basename → layer-id canonicalization in `handleLocationChange` so crosshair value + label testids match expected layer id

### In-app atlas verification panel (2026-02-14, iter 15)
Added an inline modal so the user no longer needs to paste URLs:
- New "Verify Atlas" button in the topbar
- Opens `AtlasValidationPanel` modal showing **4 surface↔volume row pairs** (Benson polar angle / eccentricity / visual areas / Wang 2015)
- Plots fetched on-demand from `/api/validation/plots/*.png`
- Embeds the text validation report inline below the plots
- Smoke test confirmed: PANEL=1, PAIRS=1, surface + volume plots load correctly, retinotopic rainbow pattern visibly matches between fsaverage and MNI volume

### Cortical-ribbon coverage v2 — KD-tree GM fill (2026-02-14, iter 14)
Previous 7-point sampling left the ribbon thin and patchy. Replaced with:
- **Dense point cloud**: 11 depth samples × (1 + 3 barycentric face subsamples) per fsaverage face → ~1.35M source points per hemisphere (~8× more than before)
- **MNI152 gray-matter mask** (intensity 25–95, morphologically cleaned) restricts the fill to actual cortical voxels
- **KD-tree nearest-neighbour fill** with 3 mm radius: every GM voxel gets the inverse-distance-weighted average of up to 4 (continuous) or 8 (categorical) nearby surface samples
- Result: cortical ribbon coverage jumped from ~115K voxels to **~380K voxels** per Benson map (≈3× thicker, fully contiguous along occipital cortex). LLM visual analysis of the regenerated MNI plot confirmed thickness of 3–6 voxels (~2–4 mm = correct GM thickness).

### Cortical-ribbon thickness fix + Wang regeneration (2026-02-14, iter 13)
- **Many-point surface→volume sampling**: `/app/scripts/generate_real_benson.py` now samples 7 points per fsaverage vertex along WM→pial line so projected overlays fill the full ~2–4 mm cortical ribbon (previously single-voxel, then 2-iter dilation).
- **Wang 2015 regenerated** from real `lh/rh.wang15_mplbl.v1_0.mgz` Kastner-Lab files: all 25 ROIs present, max-prob + 6-mm gaussian "soft" prob.
- **Benson Visual Areas** expanded to the full 12-area neuropythy scheme (V1, V2, V3, hV4, VO1/2, LO1/2, TO1/2, V3a, V3b) — labels updated in `atlasConfig.js`.
- **Validation artefacts**:
  - `/app/scripts/benson_validation_report.txt` (text report — produced vs. expected ranges & label distributions)
  - `/app/scripts/validation_plots/0[1-8]_*.png` — 8 surface-vs-MNI-volume side-by-side plots
  - Exposed via `/api/validation/report` and `/api/validation/plots/{name}` for in-browser viewing

### Follow-up fixes (2026-02-14, iter 12)
- **Mask-zero (signed data)** now works via niivue's positive/negative colormap split — `cal_minNeg=-eps`, `cal_maxNeg=globalMin`, `cal_min=eps`, `cal_max=globalMax` so zero voxels fall in the transparent gap.
- **Asymmetric layout side views moved to RIGHT** of the canvas (large slot fills left ~78%, small stack on right ~22%).
- **Threshold slider gradient is now static** (always shows the full colormap end-to-end); only the brain view + left-edge ColorBarStack react to threshold drags.
- **Voxel value at crosshair** shown next to MNI/voxel coordinates, with one badge per loaded volume (MNI152 + each overlay).
- **Inverse-threshold toggle** per layer ("show inside ↔ show outside thresholds") — implemented by registering a custom 256-entry LUT via `nv.addColormap` with alpha=0 inside the user's threshold band; recomputed whenever thresholds change while inverted.

### Major feature batch (2026-02-14, iter 11)
6-feature enhancement set:
- **Asymmetric layout** (1 large + 3 small stacked side views). Toggle in topbar; large slot defaults to Axial; double-click any side view to promote it. Implemented via niivue's `customLayout` array.
- **Vertical colorbars on left edge of viewer**, one per continuous overlay (lesion/ROI/activation/retinotopy; atlases excluded per spec). Auto-thins as overlays multiply. Labels read live from each layer's thresholds.
- **Clip plane invisible** — `clipPlaneColor=[0,0,0,0]` so brain gets cut but no purple slab is drawn.
- **Reset-to-MNI button** — visible only when a custom base has been uploaded; restores the default template while preserving overlays.
- **Real Benson 2014 atlas** — replaced the synthetic-formula maps with proper fsaverage→MNI152 projections. Pipeline: `/app/scripts/generate_real_benson.py` fetches fsaverage pial/white surfaces via nilearn, takes the mid-thickness vertex coordinates, splats the neuropythy `lh/rh.benson14_{angle,eccen,varea}.v4_0.mgz` scalars into MNI152 voxels (mean for continuous, majority vote for varea). Polar angle is 0–180° per hemisphere (Benson convention).
- **Per-layer advanced controls** (`LayerControlAdvanced` + `RangeSlider`):
  - visibility toggle on the left of every layer **including the base**
  - dual-handle threshold slider with **live colormap gradient** inside the active range
  - **click-to-edit threshold values** (textbox) — Enter to commit, Escape to cancel
  - **auto-sort** when handles cross (Math.min/max wrapper inside both handlers)
  - **mask-zero toggle** auto-shown only for signed data (global_min < −1e-3 && global_max > 1e-3)

### Recent fixes (2026-02-14, iter 8)
- **Removed inflated brain feature entirely** per user request (UI block + `loadInflatedBrain` method)
- **Colorbar toggle bug**: niivue defaults every volume's `colorbarVisible=true`, so the global `isColorbar` flag (derived from `.some(colorbarVisible)`) stayed true after toggling a layer off. Fixed by forcing all other volumes' `colorbarVisible=false` and setting `nv.opts.isColorbar` directly to the user's choice. Also default `colorbarVisible=false` at base/overlay creation.
- **Tract files loading but not displaying**: switched `addMeshFromFile` from `NVMesh.loadFromFile` + `nv.addMesh` (which skipped the tractography scene/camera setup) to `nv.loadMeshes` with a blob URL whose `name` field carries the original extension. Streamlines (.trk/.tck/.gii) now render correctly in the 3D viewport.

### Recent fixes (2026-02-14, iter 7)
- Added missing `useState` hooks for `inflatedState` / `inflatedOverlay` in Dashboard.jsx (was crashing render)
- FileUploader: replaced hardcoded extension allowlist with one derived from the `accept` prop so tract / mesh formats are accepted
- NiivueViewer.loadInflatedBrain: omit empty `layers` key when no overlay is selected
- NiivueViewer mesh loaders: append the original file extension to the niivue `name`
  field (niivue 0.68.2 derives the parser from name's ext), then reset `mesh.name = id`
  after load so internal meshMap keys remain stable
- Dashboard.handleInflatedToggle: only flip inflatedState to true after `loadInflatedBrain`
  resolves with a non-null mesh

### Data Generation
- `/app/scripts/generate_atlases.py` creates MNI152-space volumetric atlas files
  from the actual MNI152 template using Benson 2014 geometric formulas
  (eccentricity from foveal point, polar angle from atan2 in coronal plane).
- Original neuropythy fsaverage surface .mgz files bundled as reference (`lh/rh.benson14_*`, `lh/rh.wang15_*`).

### File Structure
```
/app/frontend/
  src/
    App.js, App.css, index.css
    pages/Dashboard.jsx
    components/
      NiivueViewer.jsx       — Niivue WebGL wrapper (imperative ref API)
      LayerControl.jsx       — Single layer block (toggle/opacity/colormap)
      FileUploader.jsx       — Dashed dropzone for .nii/.mgz uploads
      PolarAngleDisc.jsx     — Conic-gradient color wheel + eccentricity bar
    lib/atlasConfig.js       — All layer URLs + metadata
  public/atlases/
    mni152.nii.gz, wang2015_visual_rois.nii.gz, benson14_*.nii.gz,
    lh/rh.benson14_*.mgz, lh/rh.wang15_*.mgz (reference surface files)
/app/scripts/generate_atlases.py
/app/backend/server.py (FastAPI scaffold)
```

## Personas
- **Neuroscience researcher** — wants quick visual inspection of patient lesions vs. visual cortex retinotopy
- **Clinician** — wants to overlay patient ROIs on standard atlases for surgical/treatment planning
- **Student/educator** — wants to learn the structure of the visual cortex via interactive visualization

## Backlog (P1/P2)
- P1: Voxel value inspector on click (read intensity at crosshair)
- P1: Save/load session as JSON document
- P1: Crosshair coordinates display (MNI mm)
- P2: Mesh overlay support (cortical surface + curvature)
- P2: Multi-subject comparison view
- P2: Backend storage of uploaded lesion masks for sharing/sessions
- P2: DICOM import support

## Next Action Items
- Refactor Dashboard.jsx (800+ lines) into smaller hooks / context providers (P2)
- Add session save/load (P1)

## Recent Changes (2026-02-18)
- Polar angle overlay merged from hemisphere-split files into a single
  benson14_polar_angle.nii.gz (LH 1–180°, RH 180–360°, background=0).
- New circular `polar_angle_360` colormap registered in NiivueViewer.jsx —
  UVM=red, RHM=yellow, LVM=blue, LHM=cyan, wraps back to red.
- Fixed red-flood bug: LUT[0..1] alpha is now 0 (transparent below cal_min)
  and `ignoreZeroVoxels: true` is set on the polar angle volume so trilinear
  interpolation between cortex and background renders transparent.
- visfAtlas fixes:
  · Switched to niivue's built-in `random` colormap (same pattern as AAL /
    HO / Destrieux). The previous custom `visfAtlas` colormap + setColormapLabel
    flood-filled the brain with red because niivue v0.68.2 does not honour
    LUT[0].alpha=0 for user-registered label LUTs. The built-in `random`
    colormap shader special-cases value 0 as transparent.
  · Auto-navigates crosshair to bilateral ROI centroid (~MNI 0,-73,1) on
    toggle so the higher-visual-cortex ROIs are immediately visible.
- AtlasValidationPanel — removed the Interactive 3D toggle entirely (was
  unreliable due to multi-WebGL-context shader-link failures). Static plots
  only. InflatedBrainViewer.jsx deleted.
- CrosshairInfo bar — switched from horizontal-scroll to flex-wrap with
  truncate + tooltip, so long region labels no longer get clipped off the
  right edge of the canvas.
