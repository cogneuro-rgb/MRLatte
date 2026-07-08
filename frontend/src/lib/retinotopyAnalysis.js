// Pure functions that turn a lesion ∩ retinotopy-atlas intersection into the
// data the legend components render: which per-degree bins are affected, how
// to merge them into arc segments (handling polar wrap at 0°/360°), which
// hemifield is implicated, and a short summary string for the user.
//
// Reuses voxel-grid math (getDims, voxToMM, mmToVox) from volumeAnalysis.js
// so the affine-aware path is identical to computeAtlasOverlap.

import { getDims, voxToMM, mmToVox } from "./volumeAnalysis";

/**
 * Per-lesion: Map<int, int> from rounded atlas voxel value → lesion voxel count.
 * Atlas values < 1 are treated as background (polar cal_min=1, eccen cal_min=0.5).
 */
export function computeVoxelCounts(lesionVol, atlasVol) {
  const out = new Map();
  if (!lesionVol?.img || !atlasVol?.img) return out;
  const lDims = getDims(lesionVol);
  const aDims = getDims(atlasVol);
  if (!lDims || !aDims) return out;
  const [lnx, lny, lnz] = lDims;
  const [anx, any, anz] = aDims;
  const lImg = lesionVol.img;
  const aImg = atlasVol.img;
  const sameGrid =
    lnx === anx && lny === any && lnz === anz && lImg.length >= lnx * lny * lnz;

  const bump = (key) => out.set(key, (out.get(key) || 0) + 1);

  if (sameGrid) {
    const N = lnx * lny * lnz;
    for (let i = 0; i < N; i++) {
      if (lImg[i] <= 0) continue;
      const v = Math.round(aImg[i] || 0);
      if (v >= 1) bump(v);
    }
    return out;
  }
  for (let k = 0; k < lnz; k++) {
    for (let j = 0; j < lny; j++) {
      for (let i = 0; i < lnx; i++) {
        if (lImg[i + lnx * (j + lny * k)] <= 0) continue;
        const mm = voxToMM(lesionVol, [i, j, k]);
        const [ai, aj, ak] = mmToVox(atlasVol, mm).map(Math.round);
        if (ai < 0 || ai >= anx || aj < 0 || aj >= any || ak < 0 || ak >= anz) continue;
        const v = Math.round(aImg[ai + anx * (aj + any * ak)] || 0);
        if (v >= 1) bump(v);
      }
    }
  }
  return out;
}

/** Sum counts across selected lesions. */
export function unionCounts(maps) {
  const out = new Map();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, n] of m) out.set(k, (out.get(k) || 0) + n);
  }
  return out;
}

/** Convert a per-bin count Map → Set<int> of affected bins under the threshold. */
export function affectedSet(counts, { mode = "any", minVoxels = 1 } = {}) {
  const out = new Set();
  if (!counts) return out;
  if (mode === "any") {
    for (const [k, n] of counts) if (n > 0) out.add(k);
    return out;
  }
  const m = Math.max(1, minVoxels | 0);
  for (const [k, n] of counts) if (n >= m) out.add(k);
  return out;
}

/**
 * Merge a Set<int> of affected bins into contiguous ranges.
 *
 * Returns:
 *   - arcSegments: ranges suitable for SVG arc paths (never cross 0/360 — a
 *     wrap range is split into two arcs).
 *   - displayRanges: same data but a wrap range is collapsed to one tuple
 *     (e.g., [350, 10]) so user-facing text reads naturally.
 *
 * For non-wrap maps (eccen), the two arrays are identical.
 */
export function mergeRanges(affected, { wrap = false, maxDeg = 360 } = {}) {
  if (!affected || affected.size === 0) return { arcSegments: [], displayRanges: [] };
  const sorted = [...affected].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const segs = [];
  let s = sorted[0];
  let e = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    if (v === e + 1) {
      e = v;
    } else {
      segs.push([s, e]);
      s = e = v;
    }
  }
  segs.push([s, e]);

  if (!wrap || segs.length < 2) {
    return { arcSegments: segs, displayRanges: segs };
  }
  // Wrap merge: if first segment starts at 1 and last ends at maxDeg
  // (or the bin just below it), merge them into one display range.
  const first = segs[0];
  const last = segs[segs.length - 1];
  const startsAtLow = first[0] <= 1;
  const endsAtHigh = last[1] >= maxDeg - 1;
  if (startsAtLow && endsAtHigh) {
    const display = [...segs.slice(1, -1), [last[0], first[1]]];
    return { arcSegments: segs, displayRanges: display };
  }
  return { arcSegments: segs, displayRanges: segs };
}

/**
 * Classify which visual hemifield is affected, based on polar bin distribution.
 *
 *   LH cortex (atlas 1–180)  → patient's RIGHT visual hemifield
 *   RH cortex (atlas 181–360) → patient's LEFT visual hemifield
 *
 * "bilateral" when both sides hold more than `bilateralFraction` (default 20%)
 * of the affected voxel-count total.
 */
export function classifyHemifield(counts, bilateralFraction = 0.2) {
  if (!counts || counts.size === 0) return "none";
  let right = 0; // LH cortex bins
  let left = 0;  // RH cortex bins
  for (const [bin, n] of counts) {
    if (bin >= 1 && bin <= 180) right += n;
    else if (bin >= 181 && bin <= 360) left += n;
  }
  const total = right + left;
  if (total === 0) return "none";
  const rightFrac = right / total;
  const leftFrac = left / total;
  if (rightFrac >= bilateralFraction && leftFrac >= bilateralFraction) return "bilateral";
  return right >= left ? "right" : "left";
}

/** Format display ranges as text: "45°–92°, 178°–205°". */
export function rangesToText(displayRanges) {
  if (!displayRanges || displayRanges.length === 0) return "";
  return displayRanges
    .map(([s, e]) => (s === e ? `${s}°` : `${s}°–${e}°`))
    .join(", ");
}

/**
 * Build the one-line summary shown under each legend.
 *
 *   polar overlap:   "affects 45°–92°, 178°–205° · right hemifield"
 *   eccen overlap:   "affects 12°–34°"
 *   no overlap:      "no overlap with retinotopy atlas"
 */
export function buildSummary({ displayRanges, hemifield, kind }) {
  const text = rangesToText(displayRanges);
  if (!text) return "no overlap with retinotopy atlas";
  if (kind === "polar") {
    const tail =
      hemifield === "right" ? " · right hemifield"
      : hemifield === "left" ? " · left hemifield"
      : hemifield === "bilateral" ? " · bilateral"
      : "";
    return `affects ${text}${tail}`;
  }
  return `affects ${text}`;
}

/**
 * 2D version: builds a flat Uint32Array grid[angleIdx * 90 + eccIdx]
 * where angleIdx = floor((pa - 1) / angleBinSize) and eccIdx = floor(ecc).
 * Always covers the full 0–90° eccentricity range; callers clip at render time.
 */
export function computeVoxelCounts2D(lesionVol, polarAtlasVol, eccenAtlasVol, { angleBinSize = 5 } = {}) {
  const nAngle = Math.round(360 / angleBinSize);
  const nEcc = 90;
  const grid = new Uint32Array(nAngle * nEcc);

  if (!lesionVol?.img || !polarAtlasVol?.img || !eccenAtlasVol?.img) {
    return { grid, nAngle, nEcc, angleBinSize };
  }

  const lDims = getDims(lesionVol);
  const paDims = getDims(polarAtlasVol);
  const eDims = getDims(eccenAtlasVol);
  if (!lDims || !paDims || !eDims) return { grid, nAngle, nEcc, angleBinSize };

  const [lnx, lny, lnz] = lDims;
  const [panx, pany, panz] = paDims;
  const lImg = lesionVol.img;
  const paImg = polarAtlasVol.img;
  const eImg = eccenAtlasVol.img;

  const paAtlasesSameGrid = panx === eDims[0] && pany === eDims[1] && panz === eDims[2];
  const allSameGrid = lnx === panx && lny === pany && lnz === panz && paAtlasesSameGrid;

  if (allSameGrid) {
    const N = lnx * lny * lnz;
    for (let i = 0; i < N; i++) {
      if (lImg[i] <= 0) continue;
      const pa = Math.round(paImg[i] || 0);
      if (pa < 1 || pa > 360) continue;
      const ecc = eImg[i] || 0;
      if (ecc <= 0) continue;
      const ai = Math.floor((pa - 1) / angleBinSize);
      const ei = Math.min(Math.floor(ecc), nEcc - 1);
      grid[ai * nEcc + ei]++;
    }
    return { grid, nAngle, nEcc, angleBinSize };
  }

  for (let k = 0; k < lnz; k++) {
    for (let j = 0; j < lny; j++) {
      for (let i = 0; i < lnx; i++) {
        if (lImg[i + lnx * (j + lny * k)] <= 0) continue;
        const mm = voxToMM(lesionVol, [i, j, k]);

        const [pai, paj, pak] = mmToVox(polarAtlasVol, mm).map(Math.round);
        if (pai < 0 || pai >= panx || paj < 0 || paj >= pany || pak < 0 || pak >= panz) continue;
        const pa = Math.round(paImg[pai + panx * (paj + pany * pak)] || 0);
        if (pa < 1 || pa > 360) continue;

        let ei_x, ei_y, ei_z;
        if (paAtlasesSameGrid) {
          [ei_x, ei_y, ei_z] = [pai, paj, pak];
        } else {
          [ei_x, ei_y, ei_z] = mmToVox(eccenAtlasVol, mm).map(Math.round);
          if (ei_x < 0 || ei_x >= eDims[0] || ei_y < 0 || ei_y >= eDims[1] || ei_z < 0 || ei_z >= eDims[2]) continue;
        }
        const ecc = eImg[ei_x + eDims[0] * (ei_y + eDims[1] * ei_z)] || 0;
        if (ecc <= 0) continue;

        const ai = Math.floor((pa - 1) / angleBinSize);
        const ei = Math.min(Math.floor(ecc), nEcc - 1);
        grid[ai * nEcc + ei]++;
      }
    }
  }
  return { grid, nAngle, nEcc, angleBinSize };
}

/** Sum multiple computeVoxelCounts2D results into one. Returns null if all inputs are falsy. */
export function unionGrids(gridResults) {
  const valid = (gridResults || []).filter(Boolean);
  if (valid.length === 0) return null;
  const { nAngle, nEcc, angleBinSize } = valid[0];
  const combined = new Uint32Array(nAngle * nEcc);
  for (const g of valid) {
    for (let i = 0; i < combined.length; i++) combined[i] += g.grid[i];
  }
  return { grid: combined, nAngle, nEcc, angleBinSize };
}
