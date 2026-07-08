// Eloquent-structure proximity, computed against the Jülich atlas.
//
// Jülich region names are prefixed "GM " (grey matter) or "WM " (white-matter
// tract). White-matter tracts are treated as eloquent. A few grey-matter
// regions (Broca, primary motor/sensory, optic radiation) are also clinically
// eloquent and matched by keyword.
//
// Distances are sampled in MNI mm by expanding spherical shells around the
// query point and are therefore discretised — present them as approximate.

import { mmToVox, getDims } from "@/lib/volumeAnalysis";

const ELOQUENT_GM_KEYWORDS = [
  "broca", "wernicke", "primary motor", "primary somatosensory",
  "motor cortex", "sensory cortex", "optic radiation", "geniculate",
];

export function isEloquentName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  if (n.startsWith("wm ")) return true;
  return ELOQUENT_GM_KEYWORDS.some((kw) => n.includes(kw));
}

function labelAt(juelichVol, dims, vox) {
  const [nx, ny, nz] = dims;
  const i = Math.round(vox[0]);
  const j = Math.round(vox[1]);
  const k = Math.round(vox[2]);
  if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return 0;
  return Math.round(juelichVol.img[i + nx * (j + ny * k)] || 0);
}

/**
 * Nearest eloquent structure to an MNI mm point.
 * Returns { name, distanceMM, eloquent } or null if none found within maxMM.
 * `maxMM` bounds the search (default 6mm — keep tight; called on pointer move).
 */
export function nearestEloquentAtMM(mm, juelichVol, juelichLabels, maxMM = 6) {
  if (!mm || !juelichVol?.img || !juelichLabels) return null;
  const dims = getDims(juelichVol);
  if (!dims) return null;

  // Step 0: structure exactly at the point.
  const here = labelAt(juelichVol, dims, mmToVox(juelichVol, mm));
  if (here > 0) {
    const name = juelichLabels[here];
    if (name) return { name, distanceMM: 0, eloquent: isEloquentName(name) };
  }

  // Expanding shells: 26 directions per radius, 1mm step.
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        if (dx || dy || dz) dirs.push([dx, dy, dz]);

  for (let r = 1; r <= maxMM; r++) {
    let best = null;
    for (const [dx, dy, dz] of dirs) {
      const p = [mm[0] + dx * r, mm[1] + dy * r, mm[2] + dz * r];
      const lab = labelAt(juelichVol, dims, mmToVox(juelichVol, p));
      if (lab > 0) {
        const name = juelichLabels[lab];
        if (name && isEloquentName(name)) {
          return { name, distanceMM: r, eloquent: true };
        }
        if (name && !best) best = { name, distanceMM: r, eloquent: false };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Nearest eloquent structure to a lesion: scans lesion border voxels (a voxel
 * with at least one zero 6-neighbour) and reports the closest eloquent hit.
 */
export function nearestEloquentForLesion(lesionVol, juelichVol, juelichLabels) {
  if (!lesionVol?.img || !juelichVol?.img || !juelichLabels) return null;
  const ld = getDims(lesionVol);
  if (!ld) return null;
  const [lnx, lny, lnz] = ld;
  const img = lesionVol.img;
  const idx = (i, j, k) => i + lnx * (j + lny * k);

  let best = null;
  for (let k = 0; k < lnz; k++) {
    for (let j = 0; j < lny; j++) {
      for (let i = 0; i < lnx; i++) {
        if (img[idx(i, j, k)] <= 0) continue;
        const border =
          i === 0 || i === lnx - 1 || j === 0 || j === lny - 1 ||
          k === 0 || k === lnz - 1 ||
          img[idx(i - 1, j, k)] <= 0 || img[idx(i + 1, j, k)] <= 0 ||
          img[idx(i, j - 1, k)] <= 0 || img[idx(i, j + 1, k)] <= 0 ||
          img[idx(i, j, k - 1)] <= 0 || img[idx(i, j, k + 1)] <= 0;
        if (!border) continue;
        const mm = [
          lesionVol.matRAS[0] * i + lesionVol.matRAS[4] * j + lesionVol.matRAS[8] * k + lesionVol.matRAS[12],
          lesionVol.matRAS[1] * i + lesionVol.matRAS[5] * j + lesionVol.matRAS[9] * k + lesionVol.matRAS[13],
          lesionVol.matRAS[2] * i + lesionVol.matRAS[6] * j + lesionVol.matRAS[10] * k + lesionVol.matRAS[14],
        ];
        const hit = nearestEloquentAtMM(mm, juelichVol, juelichLabels, 8);
        if (hit?.eloquent && (!best || hit.distanceMM < best.distanceMM)) {
          best = hit;
          if (best.distanceMM === 0) return best;
        }
      }
    }
  }
  return best;
}
