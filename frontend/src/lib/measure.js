// Lightweight clinical measurements on MNI-mm coordinates / NVImage volumes.

import { getDims } from "@/lib/volumeAnalysis";

export function distanceMM(a, b) {
  if (!a || !b) return null;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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
