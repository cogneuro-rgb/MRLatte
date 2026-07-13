# NeuroVue — Implementation Progress

Branch: `feature/clinical-roadmap` (not main)
Plan: clinical roadmap — frontend quick wins (Phase 1) → DICOM (Phase 2) → longitudinal (Phase 3)

## How to run

- Web: `cd frontend && yarn start` → http://localhost:3000
- Desktop: `cd frontend && yarn electron:start` (CRA + Electron together)
- Backend (optional): `cd backend && uvicorn server:app --reload --port 8001`

## Log

| Date | Item | Files | Status | Notes |
|------|------|-------|--------|-------|
| 2026-05-18 | Repo init + feature branch | (git) | done | Was not a git repo; `git init`, branch `feature/clinical-roadmap` |
| 2026-05-18 | Pre-work fixes (carried into branch) | index.html, package.json, server.py, NiivueViewer.jsx | done | Emergent badge + PostHog + CDN script removed; CORS credentials/wildcard fixed; blob-URL leaks fixed; `electron:dev` uses `cross-env` for Windows; double-click stale-closure fix |
| 2026-05-18 | Baseline build | frontend | verified | `npx craco build` succeeds (one pre-existing eslint warning in NiivueViewer.jsx, non-blocking) |
| 2026-05-18 | Foundational refactor | volumeAnalysis.js, Dashboard.jsx, eloquent.js | done | Exported voxToMM/mmToVox/getDims/invertMat4; added `ensureAtlasLoaded` (factored from handleLayerLabelAtlasChange); created eloquent.js (Jülich WM = eloquent). Build OK |

| 2026-05-18 | 1.5 Semi-auto segmentation | NiivueViewer.jsx, DrawingPanel.jsx | done | **Deviation:** used Niivue 0.68 native `clickToSegment` (intensity flood-fill + mm³/mL callback) instead of hand-rolled `regionGrow.js`. More robust; eliminates the flagged drawBitmap-orientation risk (Niivue handles bitmap internally). DrawingPanel gains Manual/Smart-Seed mode switch w/ tolerance, max-distance, 3D toggle, last-volume readout. Build OK |

| 2026-05-18 | 1.4 Measurements + windowing | measure.js, windowing.js, MeasurePanel.jsx, NiivueViewer.jsx, Dashboard.jsx | done | Ruler (2-pt mm), lesion max-diameter (PCA approx), landmark midline shift, CT window presets. New "Measurements & Window" sidebar section. Added NiivueViewer getVolume/setBaseWindow/getBaseRange. Build OK |

| 2026-05-18 | 1.2 Eloquent proximity warning | eloquent.js, CrosshairInfo.jsx, Dashboard.jsx, NiivueViewer.jsx | done | "Eloquent Warn" topbar toggle auto-loads Jülich (invisible); crosshair shows amber/red chip within ≤5mm of WM tract. Also fixed onLocationChange stale-closure (ref-routed, same class as dblclick bug). Build OK |

| 2026-05-18 | 1.1 One-click lesion report | lesionReport.js, LesionReportPanel.jsx, Dashboard.jsx, package.json (jspdf) | done | Volume (cm³ via affine det), centroid, per-atlas % involvement (reuses computeAtlasOverlap), nearest eloquent (Jülich), approx vascular territory (heuristic, labelled). TXT + PDF export. Panel in Lesion Masks section. Build OK |

| 2026-05-18 | 1.3 Session save/restore | preload.js, electron.js, workspace.js, Dashboard.jsx | done | IPC (saveWorkspace/openWorkspace/saveFile) via ipcMain+ipcRenderer (contextIsolation kept on). Topbar Save/Open. Self-contained .nvws.json embeds uploaded volume bytes (base64); atlases/retinotopy reload from static URLs. Per-layer cal-range restore for user uploads deferred to v2. Build OK; electron.js/preload.js `node --check` OK; build/ contains electron.js+preload.js+index.html |
| 2026-05-18 | Run-readiness re-check (post-IPC) | — | verified (web) / manual (desktop) | `npx craco build` passes; Electron main/preload syntax-checked & present in build/. Full interactive desktop launch not run here (no display); manual check: `cd frontend && yarn electron:start` |

| 2026-05-18 | Phase 2 DICOM import | server.py, dicom.js, FileUploader.jsx, Dashboard.jsx | done | Backend `/api/convert/dicom` runs dcm2niix (guarded; 503 if absent) + `/available` probe. FileUploader gains directory/multiple mode. "Import DICOM Series" in Base Volume → converts → replaceBaseVolume. **Deviation:** client-side decode dropped (this Niivue build has no bundled DICOM loader); backend-only. **Ops:** needs `dcm2niix` on PATH; `python-multipart` already in requirements. Build OK, server.py compiles |

| 2026-05-18 | Phase 3 Longitudinal | server.py, requirements.txt, longitudinal.js, LongitudinalPanel.jsx, Dashboard.jsx | done | Backend `/api/longitudinal/register` (SimpleITK affine register B→A, diff map, metrics in headers) + `/available` probe + same-grid fast path. New "Longitudinal" sidebar section overlays the diff (warm). **Ops:** `SimpleITK>=2.3` added to requirements. Build OK, server.py compiles. **All phases complete.** |

| 2026-05-19 | Operating guide + doc cross-links | USER_GUIDE.md, README.md | done | Added USER_GUIDE.md (run instructions + how each new feature works); linked from README. All tracking docs current as of all phases complete. |

## Status legend
planned · in-progress · done · verified
