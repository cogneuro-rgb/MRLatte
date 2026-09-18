// Lightweight clinical measurements on MNI-mm coordinates / NVImage volumes.

import { getDims, mmToVox } from "@/lib/volumeAnalysis";

export function distanceMM(a, b) {
  if (!a || !b) return null;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Flatten a measurements list (+ optional midline landmark) into the
 * { points, edges } shape the viewer's setMeasurementPoints expects. Each
 * measurement's points share a colour index (its position in the list); a
 * distance connects its two points, an angle connects the vertex (index 1) to
 * each ray endpoint. Shared by MeasurePanel and workspace restore.
 */
export function measurementsToMarkers(measurements = [], landmark = null, pins = []) {
  const points = [];
  const edges = [];
  measurements.forEach((m, mi) => {
    const local = (m.points || []).map((pt) => {
      if (!pt.mm) return null;
      const idx = points.length;
      points.push({ id: `${m.id}-${pt.label}`, mm: pt.mm, label: `${m.name} ${pt.label}`, colorIdx: mi });
      return idx;
    });
    if (m.type === "distance" && local[0] != null && local[1] != null) edges.push([local[0], local[1]]);
    if (m.type === "angle") {
      if (local[1] != null && local[0] != null) edges.push([local[1], local[0]]);
      if (local[1] != null && local[2] != null) edges.push([local[1], local[2]]);
    }
  });
  if (landmark) points.push({ id: "landmark", mm: landmark, label: "Midline", colorIdx: measurements.length });
  // Pins each get their own single point (no edges) — placed after
  // measurements/landmark so their colour cycle continues from there.
  pins.forEach((p, pi) => {
    if (!p.mm) return;
    points.push({ id: `pin-${p.id}`, mm: p.mm, label: p.name, colorIdx: measurements.length + 1 + pi });
  });
  return { points, edges };
}

/**
 * Angle (degrees) at `vertex` between the rays vertex→a and vertex→b, via the
 * dot product of the two mm vectors. Returns null if any point is missing or a
 * ray has zero length.
 */
export function angleDeg(a, vertex, b) {
  if (!a || !vertex || !b) return null;
  const u = [a[0] - vertex[0], a[1] - vertex[1], a[2] - vertex[2]];
  const v = [b[0] - vertex[0], b[1] - vertex[1], b[2] - vertex[2]];
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu === 0 || lv === 0) return null;
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cos = Math.max(-1, Math.min(1, dot / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Intensity statistics of `intensityVol` sampled at every voxel where
 * `maskVol` > 0. The two volumes may be on different grids — each mask voxel's
 * mm position is mapped into the intensity volume (nearest-neighbour). Returns
 * { count, mean, min, max, sd } or null when the mask is empty / inputs bad.
 */
export function maskIntensityStats(maskVol, intensityVol) {
  if (!maskVol?.img || !intensityVol?.img) return null;
  const md = getDims(maskVol);
  const idims = getDims(intensityVol);
  if (!md || !idims) return null;
  const [mnx, mny, mnz] = md;
  const [inx, iny, inz] = idims;
  const mimg = maskVol.img;
  const iimg = intensityVol.img;
  // Same-grid fast path: identical dims → index directly, skip mm round-trip.
  const sameGrid = mnx === inx && mny === iny && mnz === inz;

  let count = 0, sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
  for (let k = 0; k < mnz; k++) {
    for (let j = 0; j < mny; j++) {
      for (let i = 0; i < mnx; i++) {
        if (mimg[i + mnx * (j + mny * k)] <= 0) continue;
        let v;
        if (sameGrid) {
          v = iimg[i + inx * (j + iny * k)];
        } else {
          const mm = voxToMM(maskVol.matRAS, i, j, k);
          const [vi, vj, vk] = mmToVox(intensityVol, mm).map((n) => Math.round(n));
          if (vi < 0 || vi >= inx || vj < 0 || vj >= iny || vk < 0 || vk >= inz) continue;
          v = iimg[vi + inx * (vj + iny * vk)];
        }
        if (!Number.isFinite(v)) continue;
        count++;
        sum += v;
        sumSq += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (count === 0) return null;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return { count, mean, min, max, sd: Math.sqrt(variance) };
}

function voxToMM(M, i, j, k) {
  return [
    M[0] * i + M[4] * j + M[8] * k + M[12],
    M[1] * i + M[5] * j + M[9] * k + M[13],
    M[2] * i + M[6] * j + M[10] * k + M[14],
  ];
}

/**
 * Approximate maximum lesion diameter (mm) via PCA principal-axis extent.
 * A true max-pairwise diameter is O(n^2); the principal-axis extent is a
 * fast, stable approximation — labelled approximate in the UI.
 */
export function lesionMaxDiameter(lesionVol) {
  if (!lesionVol?.img || !lesionVol.matRAS) return null;
  const dims = getDims(lesionVol);
  if (!dims) return null;
  const [nx, ny, nz] = dims;
  const img = lesionVol.img;
  const M = lesionVol.matRAS;

  // Collect lesion voxel centres in mm (subsample if very large).
  const pts = [];
  const total = nx * ny * nz;
  const stride = total > 2_000_000 ? 2 : 1;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < nz; k += stride) {
    for (let j = 0; j < ny; j += stride) {
      for (let i = 0; i < nx; i += stride) {
        if (img[i + nx * (j + ny * k)] > 0) {
          const p = voxToMM(M, i, j, k);
          pts.push(p);
          cx += p[0]; cy += p[1]; cz += p[2];
        }
      }
    }
  }
  const n = pts.length;
  if (n < 2) return { diameterMM: 0, voxelCount: n };
  cx /= n; cy /= n; cz /= n;

  // 3x3 covariance
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;

  // Power iteration for the dominant eigenvector of the covariance matrix.
  let v = [1, 1, 1];
  for (let it = 0; it < 50; it++) {
    const nx2 = xx * v[0] + xy * v[1] + xz * v[2];
    const ny2 = xy * v[0] + yy * v[1] + yz * v[2];
    const nz2 = xz * v[0] + yz * v[1] + zz * v[2];
    const mag = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1;
    v = [nx2 / mag, ny2 / mag, nz2 / mag];
  }

  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const proj = (p[0] - cx) * v[0] + (p[1] - cy) * v[1] + (p[2] - cz) * v[2];
    if (proj < lo) lo = proj;
    if (proj > hi) hi = proj;
  }
  return { diameterMM: hi - lo, voxelCount: n, axis: v };
}

/**
 * Estimate lesion volume from a binary/labelled mask volume.
 * Counts voxels with value > 0 and multiplies by the physical voxel volume,
 * derived from the affine (matRAS) as the product of the Euclidean norms of
 * its first three columns (per-axis mm spacing). Returns voxel count plus
 * volume in mm³ and cm³.
 */
// Deliberately left on the JS engine (MeasurePanel's display readout, not
// the Overlap/Lesion Report path) — its `> 0` binarization may differ
// slightly from the lqtpy-backed report numbers (lib/lesionReport.js),
// which use `> 0.5` and lqtpy's own morphometry.
export function lesionVolume(lesionVol) {
  if (!lesionVol?.img || !lesionVol.matRAS) return null;
  const dims = getDims(lesionVol);
  if (!dims) return null;
  const [nx, ny, nz] = dims;
  const img = lesionVol.img;
  const M = lesionVol.matRAS;

  // Per-axis spacing = norm of each of the first three affine columns.
  const sx = Math.hypot(M[0], M[1], M[2]);
  const sy = Math.hypot(M[4], M[5], M[6]);
  const sz = Math.hypot(M[8], M[9], M[10]);
  const voxelVolumeMM3 = sx * sy * sz;

  let count = 0;
  const total = nx * ny * nz;
  for (let idx = 0; idx < total; idx++) {
    if (img[idx] > 0) count++;
  }

  const volumeMM3 = count * voxelVolumeMM3;
  return {
    voxelCount: count,
    voxelVolumeMM3,
    spacingMM: [sx, sy, sz],
    volumeMM3,
    volumeCM3: volumeMM3 / 1000,
  };
}

/**
 * Same idea as lesionVolume, but counts voxels of a continuous overlay
 * (e.g. an activation map) that fall inside its own [lo, hi] visibility
 * threshold window (outside it, when invert=true) instead of a fixed
 * binary mask. Used for the live "N voxels / X.XX mL visible" readout next
 * to a dual-threshold slider.
 *
 * maskZero mirrors the overlay's "mask zero voxels" toggle so this count matches
 * what is actually rendered. It used to exclude zeros unconditionally, which
 * under-reported whenever the toggle was off and the window spanned 0 (those
 * zeros ARE drawn) — see the LUT's matching rule in applyThresholdColormap.
 */
// Deliberately left on the JS engine, same as lesionVolume() above — a live
// slider readout, not the lqtpy-backed report path.
export function thresholdedVolume(vol, lo, hi, invert = false, maskZero = false) {
  if (!vol?.img || !vol.matRAS) return null;
  const dims = getDims(vol);
  if (!dims) return null;
  const [nx, ny, nz] = dims;
  const img = vol.img;
  const M = vol.matRAS;

  const sx = Math.hypot(M[0], M[1], M[2]);
  const sy = Math.hypot(M[4], M[5], M[6]);
  const sz = Math.hypot(M[8], M[9], M[10]);
  const voxelVolumeMM3 = sx * sy * sz;

  let count = 0;
  const total = nx * ny * nz;
  for (let idx = 0; idx < total; idx++) {
    const v = img[idx];
    if (!Number.isFinite(v)) continue;
    if (maskZero && v === 0) continue; // toggle ON: zeros never counted, any mode
    const inRange = v >= lo && v <= hi;
    if (invert ? inRange : !inRange) continue;
    count++;
  }

  const volumeMM3 = count * voxelVolumeMM3;
  return {
    voxelCount: count,
    voxelVolumeMM3,
    volumeMM3,
    volumeCM3: volumeMM3 / 1000,
  };
}

/**
 * Landmark-assisted midline shift. The user places the crosshair on a
 * structure that should sit on the anatomical midline (e.g. septum
 * pellucidum). In MNI152 the midline is x = 0, so the shift magnitude is
 * |x_mm| with the sign indicating the displaced side (+ = right).
 */
export function midlineShift(landmarkMM) {
  if (!landmarkMM) return null;
  const x = landmarkMM[0];
  return { shiftMM: Math.abs(x), signedX: x, side: x > 0 ? "right" : x < 0 ? "left" : "midline" };
}
