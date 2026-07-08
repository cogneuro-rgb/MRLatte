// Browser-side volumetric analysis on niivue NVImage objects.
// vol.img is the typed array (float32 after scl_slope/inter applied for float NIfTI).
// vol.dimsRAS is [3, nx, ny, nz] (length 4, reoriented to RAS).
// vol.matRAS is the voxel->mm affine (column-major mat4).

export function getDims(vol) {
  // Prefer dimsRAS (reoriented), fall back to dims (NIfTI header).
  const d = vol.dimsRAS || vol.dims;
  if (!d) return null;
  // d[0] = number of dims; d[1..3] = nx, ny, nz
  return [d[1], d[2], d[3]];
}

export function voxToMM(vol, [i, j, k]) {
  const M = vol.matRAS;
  if (!M) return [i, j, k];
  return [
    M[0] * i + M[4] * j + M[8] * k + M[12],
    M[1] * i + M[5] * j + M[9] * k + M[13],
    M[2] * i + M[6] * j + M[10] * k + M[14],
  ];
}

export function mmToVox(vol, [x, y, z]) {
  // Inverse of voxToMM via numerical inverse of 4x4 matrix M
  const M = vol.matRAS;
  if (!M) return [x, y, z];
  // Compute inverse mat4 (column-major). Use gl-matrix style adjugate.
  const inv = invertMat4(M);
  if (!inv) return [x, y, z];
  const i = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
  const j = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
  const k = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  return [i, j, k];
}

export function invertMat4(m) {
  const [
    a00, a01, a02, a03,
    a10, a11, a12, a13,
    a20, a21, a22, a23,
    a30, a31, a32, a33,
  ] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const invDet = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * invDet,
    (a02 * b10 - a01 * b11 - a03 * b09) * invDet,
    (a31 * b05 - a32 * b04 + a33 * b03) * invDet,
    (a22 * b04 - a21 * b05 - a23 * b03) * invDet,
    (a12 * b08 - a10 * b11 - a13 * b07) * invDet,
    (a00 * b11 - a02 * b08 + a03 * b07) * invDet,
    (a32 * b02 - a30 * b05 - a33 * b01) * invDet,
    (a20 * b05 - a22 * b02 + a23 * b01) * invDet,
    (a10 * b10 - a11 * b08 + a13 * b06) * invDet,
    (a01 * b08 - a00 * b10 - a03 * b06) * invDet,
    (a30 * b04 - a31 * b02 + a33 * b00) * invDet,
    (a21 * b02 - a20 * b04 - a23 * b00) * invDet,
    (a11 * b07 - a10 * b09 - a12 * b06) * invDet,
    (a00 * b09 - a01 * b07 + a02 * b06) * invDet,
    (a31 * b01 - a30 * b03 - a32 * b00) * invDet,
    (a20 * b03 - a21 * b01 + a22 * b00) * invDet,
  ];
}

export function findClusters(vol, threshold, sign = "pos", minSize = 10) {
  if (!vol || !vol.img) return { clusters: [], stats: { reason: "no img" } };
  const dims = getDims(vol);
  if (!dims) return { clusters: [], stats: { reason: "no dims" } };
  const [nx, ny, nz] = dims;
  const data = vol.img;
  const N = nx * ny * nz;
  if (data.length < N) return { clusters: [], stats: { reason: `len ${data.length} < ${N}` } };

  // Diagnostics
  let aboveCount = 0;
  let maxVal = -Infinity;
  let minVal = Infinity;
  for (let i = 0; i < N; i++) {
    const v = data[i];
    if (v > maxVal) maxVal = v;
    if (v < minVal) minVal = v;
    if (sign === "pos" && v >= threshold) aboveCount++;
    else if (sign === "neg" && v <= -threshold) aboveCount++;
    else if (sign === "abs" && Math.abs(v) >= threshold) aboveCount++;
  }

  const mask = new Uint8Array(N);
  for (let idx = 0; idx < N; idx++) {
    const v = data[idx];
    let keep = false;
    if (sign === "pos") keep = v >= threshold;
    else if (sign === "neg") keep = v <= -threshold;
    else keep = Math.abs(v) >= threshold;
    mask[idx] = keep ? 1 : 0;
  }

  const visited = new Uint8Array(N);
  const clusters = [];
  const idxOf = (i, j, k) => i + nx * (j + ny * k);
  for (let k0 = 0; k0 < nz; k0++) {
    for (let j0 = 0; j0 < ny; j0++) {
      for (let i0 = 0; i0 < nx; i0++) {
        const start = idxOf(i0, j0, k0);
        if (!mask[start] || visited[start]) continue;
        const queue = [start];
        visited[start] = 1;
        let head = 0;
        const members = [];
        let peakIdx = start;
        let peakVal = Math.abs(data[start]);
        let sumI = 0, sumJ = 0, sumK = 0;
        while (head < queue.length) {
          const cur = queue[head++];
          members.push(cur);
          const ci = cur % nx;
          const cj = Math.floor(cur / nx) % ny;
          const ck = Math.floor(cur / (nx * ny));
          sumI += ci; sumJ += cj; sumK += ck;
          const av = Math.abs(data[cur]);
          if (av > peakVal) { peakVal = av; peakIdx = cur; }
          const neigh = [
            [ci - 1, cj, ck], [ci + 1, cj, ck],
            [ci, cj - 1, ck], [ci, cj + 1, ck],
            [ci, cj, ck - 1], [ci, cj, ck + 1],
          ];
          for (const [ni, nj, nk] of neigh) {
            if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
            const nidx = idxOf(ni, nj, nk);
            if (mask[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
        }
        if (members.length < minSize) continue;
        const peakI = peakIdx % nx;
        const peakJ = Math.floor(peakIdx / nx) % ny;
        const peakK = Math.floor(peakIdx / (nx * ny));
        const centerI = sumI / members.length;
        const centerJ = sumJ / members.length;
        const centerK = sumK / members.length;
        clusters.push({
          size: members.length,
          peakValue: data[peakIdx],
          peakVox: [peakI, peakJ, peakK],
          peakMM: voxToMM(vol, [peakI, peakJ, peakK]),
          centerVox: [centerI, centerJ, centerK],
          centerMM: voxToMM(vol, [centerI, centerJ, centerK]),
        });
      }
    }
  }
  clusters.sort((a, b) => b.size - a.size);
  return {
    clusters,
    stats: {
      dataLen: data.length,
      voxels: N,
      minVal,
      maxVal,
      aboveThreshold: aboveCount,
      clustersFound: clusters.length,
    },
  };
}

/**
 * Compute lesion ∩ atlas overlap with affine-aware sampling.
 * Works even when lesion and atlas live in different grids.
 */
export function computeAtlasOverlap(lesionVol, atlasVol, labelMap) {
  if (!lesionVol?.img || !atlasVol?.img) return { rows: [], stats: { reason: "missing img" } };
  const lDims = getDims(lesionVol);
  const aDims = getDims(atlasVol);
  if (!lDims || !aDims) return { rows: [], stats: { reason: "missing dims" } };
  const [lnx, lny, lnz] = lDims;
  const [anx, any, anz] = aDims;

  const lImg = lesionVol.img;
  const aImg = atlasVol.img;
  const sameGrid =
    lnx === anx && lny === any && lnz === anz && lImg.length >= lnx * lny * lnz;

  const lesionByRegion = {};
  const regionCount = {};
  let totalLesion = 0;

  if (sameGrid) {
    for (let i = 0; i < lImg.length; i++) {
      const a = Math.round(aImg[i] || 0);
      if (a > 0) regionCount[a] = (regionCount[a] || 0) + 1;
      if (lImg[i] > 0) {
        totalLesion++;
        if (a > 0) lesionByRegion[a] = (lesionByRegion[a] || 0) + 1;
      }
    }
  } else {
    // Affine-aware path: for each lesion voxel, map to MNI mm,
    // then map MNI mm to atlas voxel via inverse atlas affine.
    // Also count total atlas region sizes by iterating atlas grid once.
    for (let k = 0; k < anz; k++) {
      for (let j = 0; j < any; j++) {
        for (let i = 0; i < anx; i++) {
          const a = Math.round(aImg[i + anx * (j + any * k)] || 0);
          if (a > 0) regionCount[a] = (regionCount[a] || 0) + 1;
        }
      }
    }
    for (let k = 0; k < lnz; k++) {
      for (let j = 0; j < lny; j++) {
        for (let i = 0; i < lnx; i++) {
          if (lImg[i + lnx * (j + lny * k)] <= 0) continue;
          totalLesion++;
          const mm = voxToMM(lesionVol, [i, j, k]);
          const [ai, aj, ak] = mmToVox(atlasVol, mm).map(Math.round);
          if (ai < 0 || ai >= anx || aj < 0 || aj >= any || ak < 0 || ak >= anz) continue;
          const a = Math.round(aImg[ai + anx * (aj + any * ak)] || 0);
          if (a > 0) lesionByRegion[a] = (lesionByRegion[a] || 0) + 1;
        }
      }
    }
  }

  const rows = [];
  for (const [k, n] of Object.entries(lesionByRegion)) {
    const lab = parseInt(k, 10);
    const tot = regionCount[lab] || 0;
    rows.push({
      label: lab,
      regionName: labelMap?.[lab] || `region-${lab}`,
      voxelCount: n,
      percentOfLesion: totalLesion > 0 ? (n / totalLesion) * 100 : 0,
      percentOfRegion: tot > 0 ? (n / tot) * 100 : 0,
    });
  }
  rows.sort((a, b) => b.voxelCount - a.voxelCount);
  return {
    rows,
    stats: { sameGrid, totalLesion, regions: Object.keys(lesionByRegion).length },
  };
}

export function clustersToCSV(clusters, atlasName = null, labelByVoxel = null) {
  const headers = ["cluster", "size_voxels", "peak_value",
    "peak_mni_x", "peak_mni_y", "peak_mni_z",
    "center_mni_x", "center_mni_y", "center_mni_z"];
  if (atlasName) headers.push(`${atlasName}_region`);
  const lines = [headers.join(",")];
  clusters.forEach((c, i) => {
    const row = [i + 1, c.size, c.peakValue.toFixed(4),
      c.peakMM[0].toFixed(1), c.peakMM[1].toFixed(1), c.peakMM[2].toFixed(1),
      c.centerMM[0].toFixed(1), c.centerMM[1].toFixed(1), c.centerMM[2].toFixed(1)];
    if (atlasName && labelByVoxel) row.push(`"${labelByVoxel(c.peakVox) || ""}"`);
    lines.push(row.join(","));
  });
  return lines.join("\n");
}

export function overlapToCSV(rows, atlasName) {
  const headers = ["region", "voxels", "percent_of_lesion", `percent_of_${atlasName}_region`];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([`"${r.regionName}"`, r.voxelCount, r.percentOfLesion.toFixed(2), r.percentOfRegion.toFixed(2)].join(","));
  }
  return lines.join("\n");
}

export function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
