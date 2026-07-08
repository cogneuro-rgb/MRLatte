# Changelog

All notable changes on the `feature/clinical-roadmap` branch.

## [Unreleased]

### Changed
- Lesion report: removed the approximate vascular-territory (ACA/MCA/PCA…) line. It was a coarse centroid heuristic with no validated vascular atlas behind it and was clinically unreliable; an expert review flagged it as inaccurate. The prose/empty-state handling was also tightened (sub-1% atlas regions omitted from the summary).
- Lesion report: removed the nearest-eloquent-structure line. The "involves the eloquent structure" claim rested on a single border voxel and an over-broad white-matter heuristic; the report now covers volume, MNI centroid, and per-atlas % involvement only. The topbar Eloquent-Warn proximity toggle is unchanged.

### Security / fixes (pre-Phase-1)
- Removed the "Made with Emergent" badge, the external `assets.emergent.sh` CDN script, and the PostHog session-recording script from `frontend/public/index.html` (privacy: tool may handle patient scan data).
- Fixed CORS misconfiguration in `backend/server.py`: `allow_credentials=True` with wildcard origins is spec-invalid; credentials are now only enabled when explicit `CORS_ORIGINS` are set.
- Fixed blob-URL memory leaks in `NiivueViewer.jsx` (`replaceBaseVolume`, `addOverlayFromFile`, `addMeshFromFile` now revoke object URLs).
- Fixed double-click slice-swap stale-closure bug in `NiivueViewer.jsx` (uses live ref).
- Fixed `electron:dev` script to use `cross-env NEUROVUE_DEV=1` so the desktop dev build works on Windows.

### Added (Phase 1)
- Semi-automatic lesion segmentation: Smart Seed mode in the Draw Lesion panel — click inside a lesion and it grows by intensity similarity (Niivue native click-to-segment). Adjustable tolerance, max distance, 2D/3D, with a live segmented-volume (mL) readout.

- Measurements & Window panel: 2-point ruler (mm), approximate lesion max diameter (PCA principal axis), landmark-assisted midline shift, and CT windowing presets (Brain/Stroke/Soft/Bone/Full) for the base volume.

- Eloquent-structure proximity warning: "Eloquent Warn" toggle shows an amber/red chip in the crosshair bar when within ~5 mm of a Jülich white-matter tract (atlas auto-loaded invisibly).
- Fixed an `onLocationChange` stale-closure bug in NiivueViewer (same class as the earlier double-click fix).

- One-click structured lesion report: generates a clinical paragraph (volume in cm³, centroid, per-atlas % involvement) with TXT and PDF export. Lives in the Lesion Masks section.

- Session save/restore: topbar Save/Open buttons persist the full workspace (view, overlays, atlas/retinotopy visibility, uploaded volumes embedded as base64) to a self-contained `.nvws.json`. Native file dialogs in the desktop app; blob download / file picker in the browser.

### Phase 1 complete
All five Phase 1 quick wins are implemented and build-verified.

### Added (Phase 2)
- DICOM import: "Import DICOM Series" in the Base Volume section. Select a folder of `.dcm` files (or a `.zip`); the backend converts via `dcm2niix` and the result loads as the base volume. Requires the `dcm2niix` binary on the server PATH (a `/api/convert/dicom/available` probe reports readiness). Client-side DICOM decoding is intentionally not used (no decoder bundled in this Niivue build).

### Added (Phase 3)
- Longitudinal comparison: new "Longitudinal" sidebar section. Pick a baseline and follow-up scan; the backend affine-registers (SimpleITK) the follow-up to the baseline and returns a signed difference map (overlaid in warm) plus change metrics (changed-voxel %, registration metric, same-grid flag). Requires `SimpleITK` on the server (added to `backend/requirements.txt`); a `/api/longitudinal/available` probe reports readiness; a same-grid fast path skips registration when scans already align.

### Docs
- Added `USER_GUIDE.md` — operating instructions and a walkthrough of every new feature. Cross-linked from `README.md`.

### Ops notes
- Backend Phase 2/3 need extra runtime deps: the `dcm2niix` binary on PATH, and the `SimpleITK` Python package (`pip install -r backend/requirements.txt`). Both features degrade gracefully (HTTP 503 + UI toast) when unavailable.
