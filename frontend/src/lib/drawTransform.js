// Move / turn / resize a drawn label volume (the drawing bitmap), redrawn on
// its own grid.
//
// Unlike an overlay, whose position is changed in its file's header
// (lib/overlayTransform.js), the drawing lives on the base volume's grid and is
// saved with the base's header — so moving it means moving the voxels. Each
// output voxel takes the label of the source voxel it came from (nearest
// neighbour), so pen colours survive and no new values are invented.
//
// Pure functions; the viewer (lib/viewer/drawingApi.js) supplies the bitmap,
// its grid size and its voxel→mm matrix.
import { transformMatrix } from "@/lib/overlayTransform";

/** 4x4 row-major inverse (general, Gauss–Jordan). */
export function invert4(m) {
  const a = m.map((row, i) => [...row, ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) throw new Error("matrix is not invertible");
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 8; j++) a[c][j] /= d;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f) for (let j = 0; j < 8; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(4));
}

const mul4 = (a, b) => a.map((row) => [0, 1, 2, 3].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j] + row[3] * b[3][j]));
const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + m[i][3]);

/** Bounding box [lo, hi] (voxel indices) of the non-zero voxels, or null. */
export function labelBounds(src, dims) {
  const [nx, ny, nz] = dims;
  const lo = [nx, ny, nz], hi = [-1, -1, -1];
  for (let k = 0, idx = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        if (!src[idx]) continue;
        if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i;
        if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j;
        if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k;
      }
    }
  }
  return hi[0] < 0 ? null : [lo, hi];
}

/**
 * @param {Uint8Array} src     labels, index i + nx*(j + ny*k)
 * @param {number[]} dims      [nx, ny, nz]
 * @param {number[][]} vox2mm  4x4 row-major voxel→world matrix of that grid
 * @param {object} transform   { translation mm, rotation degrees, scale }, as in lib/overlayTransform.js;
 *                             turns and resizing pivot on the centre of the drawn voxels
 * @param {Uint8Array} [out]   where to write (same length); a new array if omitted
 * @returns {Uint8Array}
 */
export function transformLabels(src, dims, vox2mm, transform, out) {
  const [nx, ny, nz] = dims;
  const dst = out || new Uint8Array(src.length);
  dst.fill(0);
  const box = labelBounds(src, dims);
  if (!box) return dst;
  // Turns pivot on transform.pivot (world mm) when set, else on the centre of
  // the drawn voxels' bounding box.
  const pivot = Array.isArray(transform?.pivot) && transform.pivot.length >= 3
    ? transform.pivot
    : apply(vox2mm, [0, 1, 2].map((i) => (box[0][i] + box[1][i]) / 2));
  const world = transformMatrix(transform, pivot);
  const mm2vox = invert4(vox2mm);
  const fwd = mul4(mm2vox, mul4(world, vox2mm));            // source voxel -> destination voxel
  const back = invert4(fwd);                               // destination voxel -> source voxel
  // Only the destination box the drawing can land in is visited.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = apply(fwd, [c & 1 ? box[1][0] + 0.5 : box[0][0] - 0.5, c & 2 ? box[1][1] + 0.5 : box[0][1] - 0.5, c & 4 ? box[1][2] + 0.5 : box[0][2] - 0.5]);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  }
  const i0 = Math.max(0, Math.floor(lo[0]) - 1), i1 = Math.min(nx - 1, Math.ceil(hi[0]) + 1);
  const j0 = Math.max(0, Math.floor(lo[1]) - 1), j1 = Math.min(ny - 1, Math.ceil(hi[1]) + 1);
  const k0 = Math.max(0, Math.floor(lo[2]) - 1), k1 = Math.min(nz - 1, Math.ceil(hi[2]) + 1);
  const [b0, b1, b2] = back;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      // source position at i = 0 on this row, plus a fixed step per i
      let x = b0[1] * j + b0[2] * k + b0[3] + b0[0] * i0;
      let y = b1[1] * j + b1[2] * k + b1[3] + b1[0] * i0;
      let z = b2[1] * j + b2[2] * k + b2[3] + b2[0] * i0;
      for (let i = i0; i <= i1; i++, x += b0[0], y += b1[0], z += b2[0]) {
        const si = Math.round(x), sj = Math.round(y), sk = Math.round(z);
        if (si < 0 || sj < 0 || sk < 0 || si >= nx || sj >= ny || sk >= nz) continue;
        const v = src[si + nx * (sj + ny * sk)];
        if (v) dst[i + nx * (j + ny * k)] = v;
      }
    }
  }
  return dst;
}

/**
 * niivue's matRAS as a 4x4 array of rows. It is a gl-matrix mat4 but filled in
 * ROW order — niivue's own vox2mm transposes it before use — so the
 * translation sits at [3], [7], [11], not [12..14].
 */
export function mat4ToRows(m) {
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => m[i * 4 + j]));
}
