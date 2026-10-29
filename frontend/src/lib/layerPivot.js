// Where a layer turns about (the position block's "turn about" choice).
//
//   centre — the centre of the bounding box of the visible voxels
//   mass   — the centre of mass of the visible voxels (each voxel counts once)
//
// "Visible" is whatever the layer currently shows: inside its visibility window
// (or outside it in "show outside thresholds" mode), minus zeros when they are
// masked. The pivot is returned in world mm through `affine`, the layer's OWN
// voxel→mm matrix before any hand adjustment — transforms are applied on top of
// that frame (lib/overlayTransform.js).
//
// Pure: the viewer supplies the voxels and the test.

/**
 * @param {ArrayLike<number>} img     voxel values, index i + nx*(j + ny*k)
 * @param {number[]} dims             [nx, ny, nz]
 * @param {number[][]} affine         4x4 row-major voxel→mm
 * @param {(v: number) => boolean} isVisible
 * @param {"centre"|"mass"} mode
 * @param {{slope?: number, inter?: number}} [scaling]  stored value → real value
 * @returns {{ pivot: number[], count: number } | null}  null when nothing is visible
 */
export function visiblePivot(img, dims, affine, isVisible, mode, scaling = {}) {
  const [nx, ny, nz] = dims;
  const slope = Number.isFinite(scaling.slope) && scaling.slope !== 0 ? scaling.slope : 1;
  const inter = Number.isFinite(scaling.inter) ? scaling.inter : 0;
  let n = 0, si = 0, sj = 0, sk = 0;
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, k0 = Infinity, k1 = -Infinity;
  for (let k = 0, idx = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        if (!isVisible(img[idx] * slope + inter)) continue;
        n++;
        si += i; sj += j; sk += k;
        if (i < i0) i0 = i; if (i > i1) i1 = i;
        if (j < j0) j0 = j; if (j > j1) j1 = j;
        if (k < k0) k0 = k; if (k > k1) k1 = k;
      }
    }
  }
  if (!n) return null;
  const v = mode === "mass" ? [si / n, sj / n, sk / n] : [(i0 + i1) / 2, (j0 + j1) / 2, (k0 + k1) / 2];
  const pivot = [0, 1, 2].map((r) => affine[r][0] * v[0] + affine[r][1] * v[1] + affine[r][2] * v[2] + affine[r][3]);
  return { pivot, count: n };
}

/** The visibility test a layer's current settings imply. */
export function visibilityTest({ lo, hi, invert = false, maskZero = false }) {
  const inWindow = (v) => v >= lo && v <= hi;
  return (v) => {
    if (!Number.isFinite(v)) return false;
    if (maskZero && v === 0) return false;
    return invert ? !inWindow(v) : inWindow(v);
  };
}

/** A short string that changes whenever what the pivot was computed from
 *  changes — the "out of date" check behind the yellow Update button. */
export function pivotSignature(mode, inputs) {
  const r = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : "-");
  if (mode === "crosshair") return `crosshair:${(inputs.crosshair || []).map(r).join(",")}`;
  return `${mode}:${r(inputs.lo)},${r(inputs.hi)},${inputs.invert ? 1 : 0},${inputs.maskZero ? 1 : 0}`;
}
