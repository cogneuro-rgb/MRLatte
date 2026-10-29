// Manual move / rotate / scale of an overlay (lesion mask, activation map).
//
// A transform is { translation: [x, y, z] mm, rotation: [x, y, z] degrees,
// scale: number } in world (RAS) space: +x right, +y anterior, +z superior.
// Scale is uniform on purpose — a per-axis scale applied after a rotation
// shears the voxel grid, and a sheared grid cannot be written as a NIfTI qform,
// which is the transform ITK-based tools (ANTs, ITK-SNAP) read.
//
// Rotation and scale turn about the overlay's own centre, not the world origin.
// niivue's built-in applyVolumeTransform pivots on the origin, so rotating a
// lesion that sits 60 mm lateral would also swing it sideways; pivoting on the
// volume centre keeps "rotate" meaning rotate.
//
// ONE matrix drives both the screen and the file: the viewer displays
// transformMatrix(t, pivot) x baseAffine, and that same product is written into
// the header of the file that analyses, downloads and workspaces use (see
// lib/overlayBake.js). Pure functions only — no niivue import here, so the
// maths can be unit-tested.

export const IDENTITY_TRANSFORM = Object.freeze({
  translation: Object.freeze([0, 0, 0]),
  rotation: Object.freeze([0, 0, 0]),
  scale: 1,
});

// Rotation has no limit: an angle is kept as the same turn within (-180, 180]
// (wrapAngle), so turning keeps going round.
export const TRANSFORM_LIMITS = { translation: 200, scaleMin: 0.25, scaleMax: 4 };

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** An angle in degrees as the same turn within (-180, 180]: 190 -> -170, -180 -> 180. */
export function wrapAngle(deg) {
  if (deg > -180 && deg <= 180) return deg;           // untouched: no float noise in the number box
  const r = Math.round((((((deg + 180) % 360) + 360) % 360) - 180) * 1e6) / 1e6;
  return r === -180 ? 180 : r;
}

export const PIVOT_MODES = ["centre", "mass", "crosshair"];

/** Fill in defaults, clamp move and size, wrap angles. Accepts null/partial input.
 *  Keeps the turn pivot when there is one: `pivot` (world mm, in the layer's
 *  own untransformed frame), `pivotMode` and `pivotSig` (what the pivot was
 *  computed from, so the UI can tell when it is out of date). A transform with
 *  no pivot turns about the volume's grid centre, as every transform did
 *  before 0.5.0 — saved positions keep meaning what they meant. */
export function normalizeTransform(t) {
  const L = TRANSFORM_LIMITS;
  const tr = t?.translation || [];
  const ro = t?.rotation || [];
  const out = {
    translation: [0, 1, 2].map((i) => clamp(num(tr[i], 0), -L.translation, L.translation)),
    rotation: [0, 1, 2].map((i) => wrapAngle(num(ro[i], 0))),
    scale: clamp(num(t?.scale, 1) || 1, L.scaleMin, L.scaleMax),
  };
  if (Array.isArray(t?.pivot) && t.pivot.length >= 3 && t.pivot.slice(0, 3).every((v) => Number.isFinite(Number(v)))) {
    out.pivot = t.pivot.slice(0, 3).map(Number);
    out.pivotMode = PIVOT_MODES.includes(t.pivotMode) ? t.pivotMode : "centre";
    if (t.pivotSig != null) out.pivotSig = String(t.pivotSig);
  }
  return out;
}

/** The 3x3 rotation-times-scale part of a transform. */
export function linearPart(t) {
  const m = transformMatrix(t, [0, 0, 0]);
  return [0, 1, 2].map((i) => [m[i][0], m[i][1], m[i][2]]);
}

/**
 * The same pose, turning about a new pivot from now on: moving the pivot of a
 * turned layer would otherwise swing it, so the translation absorbs the
 * difference (t' = t + (I - M)(p - p'), M = rotation x scale).
 * `from` is the pivot the transform currently turns about.
 */
export function repivot(t, newPivot, from, extra = {}) {
  const n = normalizeTransform(t);
  const M = linearPart(n);
  const d = [0, 1, 2].map((i) => from[i] - newPivot[i]);
  const translation = [0, 1, 2].map((i) =>
    n.translation[i] + d[i] - (M[i][0] * d[0] + M[i][1] * d[1] + M[i][2] * d[2]));
  return { ...n, ...extra, translation, pivot: [...newPivot] };
}

/**
 * The pivot (in the layer's own frame) whose turning centre lands on a point
 * as DISPLAYED (e.g. the crosshair), once the pose is kept by repivot():
 * p' = M^-1 (c - t - p) + p.
 */
export function pivotForDisplayedPoint(t, displayed, from) {
  const n = normalizeTransform(t);
  const M = linearPart(n);
  const r = [0, 1, 2].map((i) => displayed[i] - n.translation[i] - from[i]);
  const inv = invert3(M);
  return [0, 1, 2].map((i) => inv[i][0] * r[0] + inv[i][1] * r[1] + inv[i][2] * r[2] + from[i]);
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, k]] = m;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return [
    [A / det, -(b * k - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * k - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

export function isIdentityTransform(t, eps = 1e-6) {
  if (!t) return true;
  const n = normalizeTransform(t);
  return n.translation.every((v) => Math.abs(v) < eps)
    && n.rotation.every((v) => Math.abs(v) < eps)
    && Math.abs(n.scale - 1) < eps;
}

/** 4x4 row-major product a x b. */
export function multiply4(a, b) {
  const out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i][k] * b[k][j];
      out[i][j] = s;
    }
  }
  return out;
}

/** World-mm position of the centre voxel of a grid. dims = [nx, ny, nz]. */
export function volumeCentreMM(affine, dims) {
  const c = [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2];
  return [0, 1, 2].map((i) => affine[i][0] * c[0] + affine[i][1] * c[1] + affine[i][2] * c[2] + affine[i][3]);
}

/**
 * World-space matrix for a transform: translate x (rotate and scale about pivot).
 * Rotation order is Rx x Ry x Rz, the same order niivue's own transform uses.
 */
export function transformMatrix(t, pivot = [0, 0, 0]) {
  const n = normalizeTransform(t);
  const [rx, ry, rz] = n.rotation.map((d) => (d * Math.PI) / 180);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul3 = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  const R = mul3(mul3(Rx, Ry), Rz).map((row) => row.map((v) => v * n.scale));
  // x' = R (x - pivot) + pivot + translation
  const off = [0, 1, 2].map((i) =>
    pivot[i] + n.translation[i] - (R[i][0] * pivot[0] + R[i][1] * pivot[1] + R[i][2] * pivot[2]));
  return [
    [R[0][0], R[0][1], R[0][2], off[0]],
    [R[1][0], R[1][1], R[1][2], off[1]],
    [R[2][0], R[2][1], R[2][2], off[2]],
    [0, 0, 0, 1],
  ];
}

/**
 * The affine an overlay should have once `t` is applied to it.
 * @param {number[][]} baseAffine the overlay's affine as first displayed (4x4 row-major)
 * @param {number[]} dims [nx, ny, nz]
 */
export function transformedAffine(baseAffine, dims, t) {
  if (isIdentityTransform(t)) return baseAffine.map((row) => [...row]);
  const pivot = normalizeTransform(t).pivot || volumeCentreMM(baseAffine, dims);
  return multiply4(transformMatrix(t, pivot), baseAffine);
}

/** Short human summary for tooltips and reports, e.g. "moved 5 mm, rotated 3°, scaled 110%". */
export function describeTransform(t) {
  if (isIdentityTransform(t)) return "";
  const n = normalizeTransform(t);
  const parts = [];
  const dist = Math.hypot(...n.translation);
  const rot = Math.max(...n.rotation.map(Math.abs));
  const r1 = (v) => String(Math.round(v * 10) / 10);
  if (dist > 1e-6) parts.push(`moved ${r1(dist)} mm`);
  if (rot > 1e-6) parts.push(`rotated ${r1(rot)}°`);
  if (Math.abs(n.scale - 1) > 1e-6) parts.push(`scaled ${r1(n.scale * 100)}%`);
  return parts.join(", ");
}
