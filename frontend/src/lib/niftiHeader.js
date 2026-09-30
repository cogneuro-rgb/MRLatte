// Make an exported NIfTI-1's qform agree with its sform.
//
// Why: a NIfTI carries two voxel→world transforms, and tools disagree on which
// to trust when both are coded. nibabel, FSL and niivue prefer the sform; ITK
// (ANTs, ITK-SNAP) prefers the qform. The bundled MNI152 template has a qform
// that is pure scaling with NO translation while its sform holds the real
// MNI offset — so every drawing exported against it (niivue copies the base
// volume's header) landed ~150 mm apart depending on which tool opened it,
// with no error anywhere. lqtpy's QC `header` check is what surfaced this.
//
// Rule: the sform is taken as the source of truth (it is what niivue itself
// used to place the drawing on screen). If the two transforms share the same
// rotation/scaling and differ only in translation, the qform's offsets are set
// to the sform's, which is exact. If the rotations genuinely differ, the qform
// is marked unknown (qform_code = 0) so every tool falls back to the sform —
// better than guessing a quaternion. Anything that isn't a NIfTI-1 header, or
// where either transform is uncoded, is returned untouched.
//
// Pure function: takes UNCOMPRESSED bytes, returns the same array (patched in
// place) so callers can gzip it afterwards.

const NIFTI1_HDR_SIZE = 348;
// NIfTI-1 header field offsets (bytes).
const OFF = {
  pixdim: 76,        // float32[8]; pixdim[0] = qfac
  qformCode: 252,    // int16
  sformCode: 254,    // int16
  quatern: 256,      // float32 b, c, d
  qoffset: 268,      // float32 x, y, z
  srow: 280,         // float32[4] x3 (srow_x, srow_y, srow_z)
};

function readQformLinear(dv, le) {
  const b = dv.getFloat32(OFF.quatern, le);
  const c = dv.getFloat32(OFF.quatern + 4, le);
  const d = dv.getFloat32(OFF.quatern + 8, le);
  const aa = 1 - (b * b + c * c + d * d);
  const a = aa < 1e-7 ? 0 : Math.sqrt(aa);
  const R = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
  ];
  const qfac = dv.getFloat32(OFF.pixdim, le) < 0 ? -1 : 1;
  const s = [
    dv.getFloat32(OFF.pixdim + 4, le),
    dv.getFloat32(OFF.pixdim + 8, le),
    dv.getFloat32(OFF.pixdim + 12, le) * qfac,
  ];
  return R.map((row) => row.map((v, j) => v * s[j]));
}

/**
 * @param {Uint8Array} bytes uncompressed NIfTI-1 bytes
 * @returns {{bytes: Uint8Array, action: "unchanged"|"offsets-synced"|"qform-cleared"}}
 */
export function harmonizeQformWithSform(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < NIFTI1_HDR_SIZE) {
    return { bytes, action: "unchanged" };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let le;
  if (dv.getInt32(0, true) === NIFTI1_HDR_SIZE) le = true;
  else if (dv.getInt32(0, false) === NIFTI1_HDR_SIZE) le = false;
  else return { bytes, action: "unchanged" }; // not NIfTI-1 (e.g. NIfTI-2)

  if (dv.getInt16(OFF.qformCode, le) <= 0 || dv.getInt16(OFF.sformCode, le) <= 0) {
    return { bytes, action: "unchanged" };
  }

  const srow = [0, 1, 2].map((i) =>
    [0, 1, 2, 3].map((j) => dv.getFloat32(OFF.srow + 16 * i + 4 * j, le)));
  const q = readQformLinear(dv, le);
  const scale = Math.max(1e-6, ...srow.flatMap((r) => r.slice(0, 3).map(Math.abs)));
  const sameLinear = q.every((row, i) => row.every((v, j) => Math.abs(v - srow[i][j]) <= 1e-3 * scale));

  if (sameLinear) {
    const offsetsMatch = [0, 1, 2].every((i) =>
      Math.abs(dv.getFloat32(OFF.qoffset + 4 * i, le) - srow[i][3]) <= 1e-3);
    if (offsetsMatch) return { bytes, action: "unchanged" };
    for (let i = 0; i < 3; i++) dv.setFloat32(OFF.qoffset + 4 * i, srow[i][3], le);
    return { bytes, action: "offsets-synced" };
  }
  dv.setInt16(OFF.qformCode, 0, le);
  return { bytes, action: "qform-cleared" };
}
