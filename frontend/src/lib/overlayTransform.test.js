import {
  IDENTITY_TRANSFORM, isIdentityTransform, normalizeTransform, transformMatrix,
  transformedAffine, volumeCentreMM, describeTransform,
} from "./overlayTransform";
import { setNiftiAffine, readNiftiTransforms } from "./niftiHeader";

const apply = (m, p) => [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3]);
const close = (a, b, tol = 1e-3) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));

// 2 mm MNI-like grid: x flipped (radiological storage), origin at the AC
const MNI = [[-2, 0, 0, 90], [0, 2, 0, -126], [0, 0, 2, -72], [0, 0, 0, 1]];
const DIMS = [91, 109, 91];

function blankNifti({ sformCode = 4, qformCode = 4 } = {}) {
  const bytes = new Uint8Array(352);
  const dv = new DataView(bytes.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(252, qformCode, true);
  dv.setInt16(254, sformCode, true);
  dv.setFloat32(76, 1, true);
  return bytes;
}

describe("overlay transform maths", () => {
  test("identity leaves the affine alone", () => {
    expect(isIdentityTransform(null)).toBe(true);
    expect(isIdentityTransform(IDENTITY_TRANSFORM)).toBe(true);
    expect(transformedAffine(MNI, DIMS, IDENTITY_TRANSFORM)).toEqual(MNI);
  });

  test("translation moves every point by exactly that many mm", () => {
    const a = transformedAffine(MNI, DIMS, { translation: [5, -3, 2], rotation: [0, 0, 0], scale: 1 });
    close(apply(a, [10, 20, 30]), apply(MNI, [10, 20, 30]).map((v, i) => v + [5, -3, 2][i]));
  });

  test("rotation and scale pivot on the volume centre, which stays put", () => {
    const centreVox = DIMS.map((d) => (d - 1) / 2);
    const before = volumeCentreMM(MNI, DIMS);
    const a = transformedAffine(MNI, DIMS, { translation: [0, 0, 0], rotation: [10, 25, -40], scale: 1.3 });
    close(apply(a, centreVox), before);
  });

  test("a 90 degree turn about z sends +x to +y", () => {
    const m = transformMatrix({ translation: [0, 0, 0], rotation: [0, 0, 90], scale: 1 });
    close(apply(m, [1, 0, 0]), [0, 1, 0]);
  });

  test("scale changes distances from the centre by that factor", () => {
    const c = volumeCentreMM(MNI, DIMS);
    const a = transformedAffine(MNI, DIMS, { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 2 });
    const p0 = apply(MNI, [0, 0, 0]);
    const p1 = apply(a, [0, 0, 0]);
    close(p1.map((v, i) => v - c[i]), p0.map((v, i) => 2 * (v - c[i])));
  });

  test("input is clamped and defaults are filled in", () => {
    const n = normalizeTransform({ translation: [1e9, "x"], scale: 0 });
    expect(n.translation).toEqual([200, 0, 0]);
    expect(n.rotation).toEqual([0, 0, 0]);
    expect(n.scale).toBe(1);
  });

  test("summary text", () => {
    expect(describeTransform(null)).toBe("");
    expect(describeTransform({ translation: [3, 4, 0], rotation: [0, 0, 5], scale: 1.1 })).toBe("moved 5 mm, rotated 5°, scaled 110%");
  });
});

describe("writing the adjusted position into a NIfTI header", () => {
  const cases = {
    "translation only": { translation: [12, -7, 3], rotation: [0, 0, 0], scale: 1 },
    "rotation + scale": { translation: [4, 0, -2], rotation: [12, -30, 75], scale: 1.25 },
    "large rotation (quaternion fallback branch)": { translation: [0, 0, 0], rotation: [0, 0, 179], scale: 1 },
  };
  for (const [name, t] of Object.entries(cases)) {
    test(`sform, qform and pixdim all agree: ${name}`, () => {
      const affine = transformedAffine(MNI, DIMS, t);
      const bytes = blankNifti();
      const res = setNiftiAffine(bytes, affine);
      expect(res).toEqual({ ok: true, qform: "written" });
      const back = readNiftiTransforms(bytes);
      for (let i = 0; i < 3; i++) {
        close(back.srow[i], affine[i], 2e-3);
        close(back.qform[i], affine[i], 2e-3);     // an ITK tool would land in the same place
      }
      close(back.pixdim, [2 * t.scale, 2 * t.scale, 2 * t.scale]);
      expect(back.sformCode).toBe(4);
      expect(back.qformCode).toBe(4);
    });
  }

  test("a file with no coded transform gets one", () => {
    const bytes = blankNifti({ sformCode: 0, qformCode: 0 });
    expect(setNiftiAffine(bytes, MNI).ok).toBe(true);
    const back = readNiftiTransforms(bytes);
    expect(back.sformCode).toBe(2);
    expect(back.qformCode).toBe(2);
  });

  test("a sheared affine clears the qform instead of writing a wrong one", () => {
    const sheared = [[2, 1, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
    const bytes = blankNifti();
    expect(setNiftiAffine(bytes, sheared)).toEqual({ ok: true, qform: "cleared" });
    expect(readNiftiTransforms(bytes).qformCode).toBe(0);
  });

  test("anything that is not NIfTI-1 is refused, not corrupted", () => {
    const junk = new Uint8Array(400).fill(7);
    const copy = junk.slice();
    expect(setNiftiAffine(junk, MNI).ok).toBe(false);
    expect(junk).toEqual(copy);
  });
});
