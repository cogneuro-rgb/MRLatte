---
tags: [overview]
updated: 2026-05-20
sources: []
---

Neuroimaging visualization and clinical analysis dashboard — React + NiiVue + Electron frontend, FastAPI backend.

## What It Does

NeuroVue loads NIfTI and DICOM volumes, renders them with the NiiVue WebGL engine, and supports longitudinal clinical workflows with MongoDB. Runs as both a web app and a cross-platform desktop app (Electron).

## Stack

- **Frontend:** React (CRA), NiiVue, Electron, cross-env
- **Backend:** FastAPI, uvicorn, MongoDB (optional; needed for DICOM import and longitudinal tracking)
- **DICOM conversion:** dcm2niix (must be on PATH)
- **Desktop build:** electron-builder (`yarn dist:win` for Windows)

## Key Architectural Decisions

- Blob URLs (`createObjectURL`) must always be revoked in `try/finally` — NIfTI files are large.
- CORS credentials require explicit origin allowlist, not wildcard.
- All env vars via `os.environ.get()` with startup validation (no `KeyError` on missing vars).
- No external telemetry or CDN scripts without SRI — app handles patient scan data.
- Proximity-warn state mutations must update `proximityWarnRef.current` **synchronously** before `setState` — NiiVue's continuous `onLocationChange` events create race conditions if only the async `useEffect` path is used. See [[eloquent-proximity]].
- All NiiVue mutations route through Dashboard handlers — components never call `viewerRef.current` directly. LongitudinalPanel uses an `onDiffLoaded` callback; diff overlays enter state via `addUserFile`. See [[longitudinal-pipeline]].

See [[electron-setup]], [[cors-config]], [[niivue-integration]] once those pages are created.

## Current State

Active development on `feature/neurovue-alpha` branch (2026-05-20). 13 bugs and UX issues resolved in a single batch — see [[overlay-manager]], [[clip-plane]], and `wiki/log.md` for details.

### Resolved Limitations (as of 2026-05-20)

- Eloquent Warn banner no longer persists after toggling OFF (race with `proximityWarnRef` fixed).
- Mask-zero + colormap change are now consistent (colormapNegative kept in sync).
- Atlas region labels no longer jitter during fast crosshair scrolling (40 ms debounce).
- Longitudinal diff overlay is now tracked in Dashboard state (no orphaned layers).
- Canvas correctly fills container on window resize (ResizeObserver on container div).
- Base volume exposes opacity, colormap, intensity threshold, and colorbar controls.
- Activation maps support multi-file upload and cycle through a colormap palette.
- Crosshair now hides in all 2D and 3D views (crosshairWidth = 0 when off); thickness and color are customizable.
- Workspace files include timestamp and base-volume label in the filename.
- Clip plane exposes azimuth and elevation controls in addition to depth.
- Overlay sidebar cards collapse by default; advanced controls expand on demand.
