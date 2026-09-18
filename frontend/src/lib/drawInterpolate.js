// Shape-based (signed-distance) interpolation of a drawn mask between two
// parallel slices (Raya & Udupa). Given two hand-drawn slices of the SAME
// orientation, fill every slice strictly between them by morphing one contour
// into the other: compute a 2D signed Euclidean distance field (SDF) for each
// slice, linearly blend the fields across the gap, and threshold at zero. This
// gives a smooth translate/grow/shrink morph for the common case of contiguous,
// overlapping regions (a lesion drawn across nearby slices). Two shapes that do
// not overlap at all and sit far apart are genuinely ambiguous and may thin out
// mid-gap — the accepted limitation of this classic method.
//
// Pure functions over a flat draw bitmap (Uint8Array, index = i + nx*(j + ny*k)).

const INF = 1e20;

// 1D squared-distance transform (Felzenszwalb & Huttenlocher 2004). `f` holds
// squared seed costs (0 on foreground/background boundary source, INF else);
// returns the 1D squared distance to the nearest source. O(n).
function edt1d(f, n) {
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
  return d;
}

// 2D Euclidean distance transform of a binary mask (`mask[u + w*v]`, 1 = source).
// Returns Float64Array of Euclidean distances to the nearest source voxel.
function edt2d(mask, w, h) {
  const f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 0 : INF;
  // transform along rows (u)
  const rowBuf = new Float64Array(w);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) rowBuf[u] = f[u + w * v];
    const d = edt1d(rowBuf, w);
    for (let u = 0; u < w; u++) f[u + w * v] = d[u];
  }
  // transform along cols (v)
  const colBuf = new Float64Array(h);
  for (let u = 0; u < w; u++) {
    for (let v = 0; v < h; v++) colBuf[v] = f[u + w * v];
    const d = edt1d(colBuf, h);
    for (let v = 0; v < h; v++) f[u + w * v] = d[v];
  }
  for (let i = 0; i < f.length; i++) f[i] = Math.sqrt(f[i]);
  return f;
}

// Signed distance field: negative inside the mask, positive outside.
function signedDistance(mask, w, h) {
  const outside = edt2d(mask, w, h);
  // invert the mask for the inside distance
  const inv = new Uint8Array(mask.length);
  let anyInside = false;
  for (let i = 0; i < mask.length; i++) {
    inv[i] = mask[i] ? 0 : 1;
    if (mask[i]) anyInside = true;
  }
  const inside = anyInside ? edt2d(inv, w, h) : null;
  const sdf = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    sdf[i] = mask[i] ? -(inside ? inside[i] : 0) : outside[i];
  }
  return sdf;
}

// Per-orientation geometry: in-plane grid size (w,h) and a mapper from in-plane
// (u,v) + slice index → flat voxel index in the draw bitmap.
// axCorSag: 0 = axial (plane i,j / perpendicular k),
//           1 = coronal (plane i,k / perpendicular j),
//           2 = sagittal (plane j,k / perpendicular i).
function planeGeom(axCorSag, nx, ny, nz) {
  if (axCorSag === 0) {
    return { w: nx, h: ny, at: (u, v, s) => u + nx * (v + ny * s) };
  }
  if (axCorSag === 1) {
    return { w: nx, h: nz, at: (u, v, s) => u + nx * (s + ny * v) };
  }
  return { w: ny, h: nz, at: (u, v, s) => s + nx * (u + ny * v) };
}

function extractSliceMask(bitmap, geom, slice) {
  const { w, h, at } = geom;
  const mask = new Uint8Array(w * h);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++)
      mask[u + w * v] = bitmap[at(u, v, slice)] ? 1 : 0;
  return mask;
}

/**
 * Capture the "erased footprint" of a Cutout stroke on ONE slice: the voxels
 * that were nonzero in `preBitmap` and are zero in `postBitmap`, restricted to
 * a single slice of the given orientation. Cutout erases to 0, so the shape it
 * carved is indistinguishable from ordinary background if you only look at the
 * bitmap AFTER the stroke — this diff is how the caller (NiivueViewer's
 * commitPendingStroke) captures the shape at commit time, before it becomes
 * unrecoverable, so it can later be fed into interpolateSlices' `mode: "void"`
 * to carve the same shape through the slices between two Cutout strokes.
 *
 * @param {Uint8Array} preBitmap   full-volume draw bitmap BEFORE the stroke
 * @param {Uint8Array} postBitmap  full-volume draw bitmap AFTER the stroke
 * @param {number[]} dims          [nx, ny, nz]
 * @param {number} axCorSag        0 axial | 1 coronal | 2 sagittal
 * @param {number} slice           slice index the stroke landed on
 * @returns {Uint8Array} in-plane mask (w*h, see planeGeom), 1 = erased here
 */
export function computeErasedFootprint({ preBitmap, postBitmap, dims, axCorSag, slice }) {
  const [nx, ny, nz] = dims;
  const geom = planeGeom(axCorSag, nx, ny, nz);
  const { w, h, at } = geom;
  const mask = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const idx = at(u, v, slice);
      if (preBitmap[idx] !== 0 && postBitmap[idx] === 0) mask[u + w * v] = 1;
    }
  }
  return mask;
}

/**
 * Fill slices strictly between `sliceA` and `sliceB` (same orientation) by
 * shape-morphing the two drawn masks. Mutates `bitmap` in place, writing
 * `label` into interpolated voxels — but ONLY when the morph stays
 * "connected" all the way across the gap, i.e. every intermediate slice ends
 * up with at least one foreground voxel. Two shapes that don't overlap and
 * sit far apart can make the blended signed-distance field thin to nothing
 * partway through the gap — a genuinely ambiguous case for this classic
 * method (see module header) — and a silently disconnected, broken-looking
 * fill is worse than no fill at all, so the whole pair is rejected instead of
 * partially applied. Slices A and B are left untouched either way, and
 * nothing is written to `bitmap` when rejected (all candidate slices are
 * computed into scratch buffers first, checked, and only written if every
 * one of them is non-empty).
 *
 * @param {Uint8Array} bitmap  draw bitmap (i + nx*(j + ny*k))
 * @param {number[]} dims       [nx, ny, nz]
 * @param {number} axCorSag     0 axial | 1 coronal | 2 sagittal
 * @param {number} sliceA
 * @param {number} sliceB
 * @param {number} label        pen/label value to write (>0) — ignored when mode is "void"
 * @param {"fill"|"void"} [mode="fill"]  "fill" writes `label` into the morphed
 *   shape (Pen interpolation, reads the shape straight off `bitmap`); "void"
 *   writes 0 (Cutout interpolation) and MUST be given `maskA`/`maskB` — the
 *   erased footprint can't be read back off `bitmap` since erased voxels are
 *   plain 0, indistinguishable from untouched background.
 * @param {Uint8Array|null} [maskA]  in-plane erased-footprint mask for
 *   sliceA (only used/required when mode is "void" — see computeErasedFootprint)
 * @param {Uint8Array|null} [maskB]  same, for sliceB
 * @returns {{filled: number, disconnected: boolean}} `filled` = count of
 *   intermediate slices actually written (always 0 when `disconnected` is
 *   true, or when the slices are adjacent/identical).
 */
export function interpolateSlices({ bitmap, dims, axCorSag, sliceA, sliceB, label, mode = "fill", maskA = null, maskB = null }) {
  const [nx, ny, nz] = dims;
  const lo = Math.min(sliceA, sliceB);
  const hi = Math.max(sliceA, sliceB);
  if (hi - lo < 2) return { filled: 0, disconnected: false }; // adjacent or same slice — nothing between them

  const geom = planeGeom(axCorSag, nx, ny, nz);
  const { w, h, at } = geom;
  const isVoid = mode === "void";
  // Explicit masks are keyed by their own slice index (sliceA/sliceB), not by
  // lo/hi — map them in regardless of which order the caller passed them.
  const masksBySlice = new Map();
  if (maskA) masksBySlice.set(sliceA, maskA);
  if (maskB) masksBySlice.set(sliceB, maskB);
  const maskLo = masksBySlice.get(lo) ?? (isVoid ? null : extractSliceMask(bitmap, geom, lo));
  const maskHi = masksBySlice.get(hi) ?? (isVoid ? null : extractSliceMask(bitmap, geom, hi));
  // Both endpoints need real content to "connect" anything at all — should
  // always hold for slices the caller found via lastDraws, guarded anyway.
  if (!maskLo || !maskHi || !maskLo.some(Boolean) || !maskHi.some(Boolean)) {
    return { filled: 0, disconnected: true };
  }
  const sdfLo = signedDistance(maskLo, w, h);
  const sdfHi = signedDistance(maskHi, w, h);
  const writeValue = isVoid ? 0 : (label > 0 ? label : 1);

  // Compute every intermediate slice's blended mask into scratch buffers
  // FIRST, without touching the real bitmap, so a disconnect anywhere in the
  // gap rejects the whole fill before any mutation happens.
  const pending = [];
  for (let s = lo + 1; s < hi; s++) {
    const t = (s - lo) / (hi - lo);
    const mask = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < sdfLo.length; i++) {
      const blended = (1 - t) * sdfLo[i] + t * sdfHi[i];
      if (blended <= 0) { mask[i] = 1; any = true; }
    }
    if (!any) return { filled: 0, disconnected: true }; // thinned to nothing — reject the whole pair
    pending.push({ s, mask });
  }

  for (const { s, mask } of pending) {
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const u = i % w;
      const v = (i - u) / w;
      bitmap[at(u, v, s)] = writeValue;
    }
  }
  return { filled: pending.length, disconnected: false };
}
