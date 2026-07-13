# NeuroVue Wiki Log

Append-only. Each entry: `## [YYYY-MM-DD] <operation> | <subject>`
Operations: `ingest`, `query`, `lint`

---

## [2026-05-19] ingest | Wiki initialized

Set up wiki structure: `index.md`, `log.md`, `overview.md`. No sources ingested yet.

## [2026-05-20] fix | 13-issue batch (bugfix + UX)

Resolved 13 confirmed bugs and UX gaps across `Dashboard.jsx`, `NiivueViewer.jsx`, `LayerControlAdvanced.jsx`, `LongitudinalPanel.jsx`, `lib/workspace.js`.

**Root causes addressed:**
- Eloquent Warn race: `proximityWarnRef.current` was only updated in an async `useEffect`; NiiVue's `onLocationChange` events fired in the gap. Fixed with a synchronous handler.
- Mask-zero / colormap mismatch: `colormapNegative` not updated when `setOverlayColormap` was called while mask-zero was active. Fixed by checking `__maskZeroPrev` and syncing both fields.
- Atlas label jitter: rapid `setCrosshairLabels` calls on every crosshair move. Fixed with 40 ms debounce (`labelsDebounceRef`).
- Longitudinal orphaned overlay: `LongitudinalPanel` called `viewerRef.current` directly, bypassing Dashboard state. Fixed with `onDiffLoaded` callback routed through `addUserFile`.
- Canvas resize: NiiVue's built-in ResizeObserver watched the canvas element, not the flex container. Fixed with a container-level ResizeObserver + `window.resize` fallback.
- Crosshair 2D views hidden: `setCrosshair` only toggled `show3Dcrosshair`; `crosshairWidth = 0` is required to hide 2D slice crosshairs. Fixed in the imperative handle.

**New capabilities:**
- Base volume: opacity slider, colormap selector, intensity threshold, colorbar toggle.
- Activation maps: multi-file upload, sequential colormap palette (8 colors).
- Clip plane: azimuth (−180–180°) and elevation (−90–90°) sliders added alongside depth.
- Crosshair: thickness (1–5) and color preset (white/red/yellow/cyan/green) controls.
- Workspace: filenames now include base-volume label and ISO date; version bumped to 2.
- Overlay cards: collapsed by default (opacity only visible), expand chevron reveals advanced controls.

**Files changed:** `Dashboard.jsx`, `NiivueViewer.jsx`, `LayerControlAdvanced.jsx`, `LongitudinalPanel.jsx`, `lib/workspace.js`
**Wiki pages added/updated:** `overview.md`, `overlay-manager.md`, `clip-plane.md`, `index.md`
