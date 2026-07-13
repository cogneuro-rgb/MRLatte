---
tags: [component, decision]
updated: 2026-05-20
sources: [Dashboard.jsx, LayerControlAdvanced.jsx, FileUploader.jsx]
---

Documents the overlay layer management system — how overlays enter state, how cards are rendered, and the multi-upload flow for activation maps.

## Overlay Types

NeuroVue supports five overlay types, each tracked in different state slices:

| Type | State | ID prefix |
|---|---|---|
| Activation map | `userLayers` (type `"activation"`) | `act-` |
| Lesion mask | `userLayers` (type `"lesion"`) | `lesion-` |
| ROI | `userLayers` (type `"roi"`) | `roi-` |
| Custom atlas | `userLayers` (type `"atlas"`) | `atlas-` |
| Tract / mesh | `tractLayers` | `tract-` |

Standard atlases (AAL, HO, Jülich) and retinotopy layers are tracked separately (`atlasState`, `retState`).

## addUserFile Pipeline

All user-uploaded overlays — including longitudinal diff maps — enter Dashboard state through `addUserFile(file, type, opts?)`. This function:

1. Generates a unique `id` (`${type}-${Date.now()}`).
2. Picks a layer name: for `activation` type, uses `file.name` directly (no prefix); for other types, prepends the type label (`Lesion · …`, `ROI · …`).
3. Picks a colormap from the appropriate palette (see Colormap Palettes below).
4. Calls `viewerRef.current.addOverlayFromFile(file, { colormap, opacity })`.
5. Appends a layer entry to `userLayers` state.
6. Caches the file in `userFileCache.current` for workspace save/restore.
7. Schedules a `refreshOverlayMeta(id)` after 60 ms to populate threshold metadata.

The `opts` parameter allows overriding `name`, `colormap`, and `opacity` — used by the longitudinal diff flow.

## Colormap Palettes

```js
const ROI_CMAP_PALETTE      = ["green", "blue", "winter", "plasma", "viridis", "warm"];
const ACTIVATION_CMAP_PALETTE = ["warm", "cool", "plasma", "viridis", "inferno", "hot", "actc", "winter"];
```

Each new overlay of its type picks `palette[count % palette.length]`, where `count` is the current number of layers of that type. This ensures consecutive uploads get distinct colormaps automatically.

## Collapsed Card Model

`LayerControlAdvanced` renders each overlay as a card with two states:

**Collapsed (default):**
- Visibility toggle (eye icon)
- Layer name (truncated)
- Remove button (if `removable`)
- Expand chevron `▸`
- Opacity slider (compact inline row, only when visible)

**Expanded (chevron clicked → `▾`):**
- All collapsed controls, plus:
- Dual-handle threshold slider with live colormap gradient background
- Threshold direction toggle (inside ↔ outside)
- Mask-zero toggle (signed data only)
- Colormap dropdown
- Label atlas selector (activation layers only)

Collapsed height: ~70 px. Expanded height: ~200–220 px depending on which optional controls are present.

Overlay lists that can exceed four items are wrapped in `max-h-[500px] overflow-y-auto thin-scroll` in `Dashboard.jsx` to keep the sidebar scrollable without hiding the section header.

## Multi-Upload for Activation Maps

The activation maps `FileUploader` accepts `multiple={true}` and calls `onFiles(files[])` instead of `onFile(file)`. `Dashboard.jsx` processes files sequentially (each `await addUserFile` completes before the next) to avoid NiiVue race conditions from concurrent overlay loads.

## Longitudinal Diff Integration

`LongitudinalPanel` never accesses `viewerRef` directly. After a successful registration:

1. It calls `onDiffLoaded(file, { colormap: "warm", opacity: 0.7 })`.
2. Dashboard's handler calls `addUserFile(file, "activation", { ...opts, name: "Longitudinal Diff · <date>" })`.
3. The diff overlay is registered in `userLayers`, `userFileCache`, and `overlayMeta` — it gets a full layer card, threshold controls, and is cleared by "Clear All" like any other overlay.

See [[longitudinal-pipeline]] for the registration flow.

## Workspace Persistence

`getWorkspaceSnapshot` embeds each user file as base64 via `fileToBase64`. On restore, `base64ToFile` reconstructs the `File` object and `addUserFile` re-loads it. Overlay metadata (colormap, opacity, calMin/calMax, ignoreZeroVoxels, invertThreshold, labelAtlasId) is stored per-layer and applied after reload.
