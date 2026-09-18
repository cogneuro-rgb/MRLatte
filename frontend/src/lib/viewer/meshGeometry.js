// Colour streamlines of a loaded tract mesh.
//   scalar: a per-vertex data name carried by the .trx ("polar_angle" /
//           "eccentricity"), or "direction" (NiiVue "Local") / "uniform"
//           ("Fixed") / "Global".
// For a named scalar we locate its dpv index, pin its cal_min/cal_max to the
// requested range (so the cyclic polar_angle_360 colormap maps 1..360 around the
// wheel rather than to the bundle's own min..max), set the mesh colormap, then
// switch fiberColor to "dpv<index>". Mirrors the threshold-pinning used for the
// voxel retinotopy overlays in applyThresholdColormap().
export function applyFiberScalarColor(nv, mesh, opts = {}) {
  if (!nv || !mesh) return;
  const { scalar, colormap, calMin, calMax } = opts;
  try {
    if (!scalar || scalar === "direction" || scalar === "Local") {
      nv.setMeshProperty(mesh.id, "fiberColor", "Local");
      return;
    }
    if (scalar === "Global" || scalar === "Fixed") {
      nv.setMeshProperty(mesh.id, "fiberColor", scalar);
      return;
    }
    const dpv = mesh.dpv || [];
    const idx = dpv.findIndex((d) => d.id === scalar);
    if (idx < 0) {
      // Unknown scalar — fall back to direction colouring rather than blank.
      nv.setMeshProperty(mesh.id, "fiberColor", "Local");
      return;
    }
    if (Number.isFinite(calMin)) dpv[idx].cal_min = calMin;
    if (Number.isFinite(calMax)) dpv[idx].cal_max = calMax;
    if (colormap) nv.setMeshProperty(mesh.id, "colormap", colormap);
    nv.setMeshProperty(mesh.id, "fiberColor", `dpv${idx}`);
  } catch (e) {
    console.warn("applyFiberScalarColor failed:", e);
  }
}

// ===== Measurement point markers =====
// A per-measurement colour cycle shared by the 3D sphere mesh and the HTML
// overlay (2D slice marker + 3D hover label), so each measurement reads as one
// consistent colour everywhere. Callers pass a `colorIdx` per point; we take
// it modulo the palette length.
export const MEASURE_COLORS_RGB = [
  [56, 220, 220],  // cyan
  [255, 150, 40],  // orange
  [255, 220, 40],  // yellow
  [120, 235, 120], // green
  [235, 120, 235], // magenta
  [120, 170, 255], // blue
];
export const MEASURE_NBANDS = MEASURE_COLORS_RGB.length;

// Procedural sphere/cylinder geometry for the measurement-point markers,
// appended directly into shared pts/tris/rgba arrays and handed to a plain
// NVMesh (the same construction path NiiVue uses for loaded .obj/.stl/.gii
// surfaces). NiiVue's higher-level connectome API (loadConnectome /
// loadConnectomeAsMesh) builds structurally valid geometry — indexCount,
// vao, buffers are all populated correctly — but the resulting nodes never
// actually appear in the 3D render pass in this NiiVue build (confirmed even
// via NiiVue's own native loadConnectome() call, so it isn't specific to our
// wrapper). Building a plain triangle mesh sidesteps that entirely and reuses
// NVMesh's base updateMesh() path, which is exactly what tract/mesh file
// loading already uses successfully elsewhere in this app.
// Appends one winding direction's worth of sphere ring vertices (a fresh
// vertex block, not shared with the other winding pass — sharing vertices
// between opposite-wound triangle sets would average their face normals to
// near-zero at each vertex, which is worse than a culled face: a degenerate
// normal reads as unlit/black under the mesh shader's lighting model).
export function pushSphereRings(pts, rgba, center, radius, rgb, rings, segs) {
  const base = pts.length / 3;
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI;
    const y = Math.cos(theta) * radius;
    const ringRadius = Math.sin(theta) * radius;
    for (let s = 0; s <= segs; s++) {
      const phi = (s / segs) * 2 * Math.PI;
      const x = Math.cos(phi) * ringRadius;
      const z = Math.sin(phi) * ringRadius;
      pts.push(center[0] + x, center[1] + y, center[2] + z);
      rgba.push(rgb[0], rgb[1], rgb[2], 255);
    }
  }
  return base;
}

// MeshRenderer always enables backface culling, and getting a procedural
// sphere's winding "correct" relative to NiiVue's world/camera handedness
// isn't worth the fragility — instead push the ring vertices TWICE (disjoint
// vertex blocks) and wind each copy oppositely, guaranteeing a front-facing,
// correctly-lit triangle regardless of which winding NiiVue expects.
export function appendSphere(pts, tris, rgba, center, radius, rgb, rings = 8, segs = 10) {
  const perRing = segs + 1;
  const winds = (base, reversed) => {
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = base + r * perRing + s;
        const b = a + perRing;
        if (!reversed) {
          tris.push(a, b, a + 1);
          tris.push(a + 1, b, b + 1);
        } else {
          tris.push(a, a + 1, b);
          tris.push(a + 1, b + 1, b);
        }
      }
    }
  };
  winds(pushSphereRings(pts, rgba, center, radius, rgb, rings, segs), false);
  winds(pushSphereRings(pts, rgba, center, radius, rgb, rings, segs), true);
}

export function pushCylinderRings(pts, rgba, p0, p1, radius, rgb, segs, nx, ny) {
  const base = pts.length / 3;
  for (const center of [p0, p1]) {
    for (let s = 0; s <= segs; s++) {
      const phi = (s / segs) * 2 * Math.PI;
      const ox = Math.cos(phi) * radius, oy = Math.sin(phi) * radius;
      pts.push(
        center[0] + nx[0] * ox + ny[0] * oy,
        center[1] + nx[1] * ox + ny[1] * oy,
        center[2] + nx[2] * ox + ny[2] * oy,
      );
      rgba.push(rgb[0], rgb[1], rgb[2], 255);
    }
  }
  return base;
}

export function appendCylinder(pts, tris, rgba, p0, p1, radius, rgb, segs = 8) {
  const dir = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const nz = [dir[0] / len, dir[1] / len, dir[2] / len];
  const upRef = Math.abs(nz[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const nx = norm3(cross3(upRef, nz));
  const ny = cross3(nz, nx);
  const perRing = segs + 1;
  const winds = (base, reversed) => {
    for (let s = 0; s < segs; s++) {
      const a = base + s, b = a + perRing;
      if (!reversed) {
        tris.push(a, b, a + 1);
        tris.push(a + 1, b, b + 1);
      } else {
        tris.push(a, a + 1, b);
        tris.push(a + 1, b + 1, b);
      }
    }
  };
  winds(pushCylinderRings(pts, rgba, p0, p1, radius, rgb, segs, nx, ny), false);
  winds(pushCylinderRings(pts, rgba, p0, p1, radius, rgb, segs, nx, ny), true);
}
