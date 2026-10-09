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

// Give a NIfTI-1 a new voxel→world transform, without touching its voxels.
//
// Why: a manually moved overlay (lib/overlayTransform.js) must be analysed
// where it is shown. Every analysis reads the overlay's FILE, so the adjusted
// position has to live in the file's header — and in all three places a tool
// may look: the sform rows, the qform quaternion, and pixdim (voxel size, which
// a scale changes and which nibabel reports as the zooms).
//
// The qform can only hold rotation + positive voxel sizes (+ one flip). If the
// new affine's axes are not perpendicular it is marked unknown (qform_code = 0)
// so every tool falls back to the sform, same rule as above. A file that had no
// coded transform at all gets code 2 ("aligned") for whichever is written.
//
// Pure function: takes UNCOMPRESSED bytes, patches them in place.
/**
 * @param {Uint8Array} bytes uncompressed NIfTI-1 bytes
 * @param {number[][]} affine 4x4 row-major voxel→world matrix
 * @returns {{ok: boolean, qform: "written"|"cleared"|null, reason?: string}}
 */
export function setNiftiAffine(bytes, affine) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < NIFTI1_HDR_SIZE) {
    return { ok: false, qform: null, reason: "not a NIfTI-1 file" };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let le;
  if (dv.getInt32(0, true) === NIFTI1_HDR_SIZE) le = true;
  else if (dv.getInt32(0, false) === NIFTI1_HDR_SIZE) le = false;
  else return { ok: false, qform: null, reason: "not a NIfTI-1 file" };
  if (!affine || affine.length < 3 || affine.slice(0, 3).some((r) => r.length < 4 || r.some((v) => !Number.isFinite(v)))) {
    return { ok: false, qform: null, reason: "invalid affine" };
  }

  const col = (j) => [affine[0][j], affine[1][j], affine[2][j]];
  const norm = (v) => Math.hypot(v[0], v[1], v[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cols = [col(0), col(1), col(2)];
  const size = cols.map(norm);
  if (size.some((s) => !(s > 1e-9))) return { ok: false, qform: null, reason: "degenerate affine" };

  // sform
  const prevS = dv.getInt16(OFF.sformCode, le);
  const prevQ = dv.getInt16(OFF.qformCode, le);
  const code = prevS > 0 ? prevS : prevQ > 0 ? prevQ : 2;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) dv.setFloat32(OFF.srow + 16 * i + 4 * j, affine[i][j], le);
  }
  dv.setInt16(OFF.sformCode, code, le);
  for (let j = 0; j < 3; j++) dv.setFloat32(OFF.pixdim + 4 * (j + 1), size[j], le);

  // qform — only when the axes are perpendicular
  const u = cols.map((c, j) => c.map((v) => v / size[j]));
  const perpendicular = Math.abs(dot(u[0], u[1])) < 1e-3 && Math.abs(dot(u[0], u[2])) < 1e-3 && Math.abs(dot(u[1], u[2])) < 1e-3;
  if (!perpendicular) {
    dv.setInt16(OFF.qformCode, 0, le);
    return { ok: true, qform: "cleared" };
  }
  const det = u[0][0] * (u[1][1] * u[2][2] - u[1][2] * u[2][1])
    - u[1][0] * (u[0][1] * u[2][2] - u[0][2] * u[2][1])
    + u[2][0] * (u[0][1] * u[1][2] - u[0][2] * u[1][1]);
  const qfac = det < 0 ? -1 : 1;
  if (qfac < 0) u[2] = u[2].map((v) => -v);
  // r[i][j]: row i, column j of the proper rotation
  const r = [0, 1, 2].map((i) => [u[0][i], u[1][i], u[2][i]]);
  let a = r[0][0] + r[1][1] + r[2][2] + 1;
  let b; let c; let d;
  if (a > 0.5) {
    a = 0.5 * Math.sqrt(a);
    b = 0.25 * (r[2][1] - r[1][2]) / a;
    c = 0.25 * (r[0][2] - r[2][0]) / a;
    d = 0.25 * (r[1][0] - r[0][1]) / a;
  } else {
    const xd = 1 + r[0][0] - (r[1][1] + r[2][2]);
    const yd = 1 + r[1][1] - (r[0][0] + r[2][2]);
    const zd = 1 + r[2][2] - (r[0][0] + r[1][1]);
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = 0.25 * (r[0][1] + r[1][0]) / b;
      d = 0.25 * (r[0][2] + r[2][0]) / b;
      a = 0.25 * (r[2][1] - r[1][2]) / b;
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = 0.25 * (r[0][1] + r[1][0]) / c;
      d = 0.25 * (r[1][2] + r[2][1]) / c;
      a = 0.25 * (r[0][2] - r[2][0]) / c;
    } else {
      d = 0.5 * Math.sqrt(zd);
      b = 0.25 * (r[0][2] + r[2][0]) / d;
      c = 0.25 * (r[1][2] + r[2][1]) / d;
      a = 0.25 * (r[1][0] - r[0][1]) / d;
    }
    if (a < 0) { b = -b; c = -c; d = -d; }
  }
  dv.setFloat32(OFF.quatern, b, le);
  dv.setFloat32(OFF.quatern + 4, c, le);
  dv.setFloat32(OFF.quatern + 8, d, le);
  for (let i = 0; i < 3; i++) dv.setFloat32(OFF.qoffset + 4 * i, affine[i][3], le);
  dv.setFloat32(OFF.pixdim, qfac, le);
  dv.setInt16(OFF.qformCode, prevQ > 0 ? prevQ : code, le);
  return { ok: true, qform: "written" };
}

/** Read the sform (rows) and the full qform matrix back out — used by tests. */
export function readNiftiTransforms(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = dv.getInt32(0, true) === NIFTI1_HDR_SIZE;
  const srow = [0, 1, 2].map((i) => [0, 1, 2, 3].map((j) => dv.getFloat32(OFF.srow + 16 * i + 4 * j, le)));
  const lin = readQformLinear(dv, le);
  const qform = lin.map((row, i) => [...row, dv.getFloat32(OFF.qoffset + 4 * i, le)]);
  return {
    sformCode: dv.getInt16(OFF.sformCode, le),
    qformCode: dv.getInt16(OFF.qformCode, le),
    srow,
    qform,
    pixdim: [1, 2, 3].map((j) => dv.getFloat32(OFF.pixdim + 4 * j, le)),
  };
}
