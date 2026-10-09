// Is a volume on a standard MNI152 template grid?
//
// Why: lqtpy's brain checks (outside the brain, not in MNI space) only make
// sense for a drawing made in MNI space. That used to be decided by comparing
// the base's display NAME with the bundled template's, so a user's own copy of
// an MNI template, or a renamed one, silently switched the checks off.
//
// The test is deliberately an exact one — the extent of the voxel centres must
// equal that of a known template to within half a millimetre — not "roughly
// brain-sized and centred". A native scan can easily be roughly that; it cannot
// plausibly land on these exact numbers, and a false "yes" would make the brain
// checks cry wolf on every native-space drawing.

// [min corner, max corner] of the voxel centres, world mm (RAS).
const TEMPLATE_EXTENTS = [
  [[-90, -126, -72], [90, 90, 108]],     // FSL / MNI152NLin6 at 2 mm: 91x109x91
  [[-91, -126, -72], [90, 91, 109]],     // FSL / MNI152NLin6 at 1 mm: 182x218x182 (an even count, so one side is 1 mm longer)
  [[-96, -132, -78], [96, 96, 114]],     // MNI152NLin2009c: 193x229x193 at 1 mm, 97x115x97 at 2 mm
];
const TOLERANCE_MM = 0.5;

/**
 * @param {number[][]} affine 4x4 row-major voxel→world
 * @param {number[]} dims [nx, ny, nz]
 */
export function isMniTemplateGrid(affine, dims) {
  if (!affine || !dims || dims.length < 3 || dims.some((d) => !(d > 1))) return false;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const v = [c & 1 ? dims[0] - 1 : 0, c & 2 ? dims[1] - 1 : 0, c & 4 ? dims[2] - 1 : 0];
    for (let i = 0; i < 3; i++) {
      const w = affine[i][0] * v[0] + affine[i][1] * v[1] + affine[i][2] * v[2] + affine[i][3];
      if (!Number.isFinite(w)) return false;
      lo[i] = Math.min(lo[i], w);
      hi[i] = Math.max(hi[i], w);
    }
  }
  return TEMPLATE_EXTENTS.some(([a, b]) =>
    [0, 1, 2].every((i) => Math.abs(lo[i] - a[i]) <= TOLERANCE_MM && Math.abs(hi[i] - b[i]) <= TOLERANCE_MM));
}

/** Same question for the viewer's current base volume. Never throws. */
export function baseIsMniTemplateGrid(viewer) {
  try {
    const nv = viewer?.getNiivue?.();
    const base = nv?.volumes?.[0];
    if (!base?.hdr) return false;
    const d = base.hdr.dims;
    return isMniTemplateGrid(nv.getVolumeAffine(0), [d[1], d[2], d[3]]);
  } catch (_e) {
    return false;
  }
}
