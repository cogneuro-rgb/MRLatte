---
tags: [component, concept]
updated: 2026-05-20
sources: [Dashboard.jsx, NiivueViewer.jsx]
---

Documents the clip-plane control system — depth, azimuth, and elevation parameters, their UI, and workspace persistence.

## NiiVue API

NiiVue exposes clipping via:

```js
nv.setClipPlane([depth, azimuth, elevation])
```

- **depth** — how deep the clip cuts into the volume along the camera axis (−2 to 2; 2 = no clip).
- **azimuth** — rotation around the vertical axis in degrees (0–360, or −180–180 in the UI).
- **elevation** — tilt of the clip normal up/down in degrees (−90 to 90).

NiivueViewer's imperative handle exposes:

```js
viewerRef.current.setClipPlane(depth, az, el)
```

which calls `nv.setClipPlane([depth, az, el])` directly.

## State

Three state variables in `Dashboard.jsx`:

| Variable | Default | Range | Step |
|---|---|---|---|
| `clipDepth` | `2` | −2–2 | 0.05 |
| `clipAz` | `0` | −180–180 | 5° |
| `clipEl` | `0` | −90–90 | 5° |

All three are applied together in a single `useEffect` that runs whenever any of the three changes:

```js
useEffect(() => {
  viewerRef.current?.setClipPlane(clipDepth, clipAz, clipEl);
}, [clipDepth, clipAz, clipEl, viewerReady]);
```

## UI

The **Clip Plane** sidebar section (between Measurements & Window and Atlases) contains three compact inline sliders:

- **depth** — range −1–2; displays "off" when ≥ 2
- **az** — azimuth, range −180–180°
- **el** — elevation, range −90–90°

A **reset** button sets all three back to defaults (depth=2, az=0, el=0). The section is collapsed by default.

> Previously (before 2026-05-20) these controls were in the bottom bar below the viewer. They were moved to the sidebar because the CrosshairInfo bar can expand to two rows when atlas region labels are present, which displaced the bottom bar off screen.

## Workspace Persistence

`clipDepth`, `clipAz`, and `clipEl` are included in `getWorkspaceSnapshot` and restored by `applyWorkspace`. Both v1 (legacy, no az/el fields) and v2 workspaces are accepted — missing fields fall back to defaults (0).
