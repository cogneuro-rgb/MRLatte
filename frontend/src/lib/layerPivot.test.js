import { visiblePivot, visibilityTest, pivotSignature } from "./layerPivot";
import { repivot, pivotForDisplayedPoint, transformMatrix, normalizeTransform, transformedAffine, volumeCentreMM } from "./overlayTransform";

const EYE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const apply = (m, p) => [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3]);
const T = (translation, rotation, scale = 1, extra = {}) => ({ translation, rotation, scale, ...extra });

describe("turn pivot from the visible voxels", () => {
  const dims = [10, 10, 10];
  const img = new Float32Array(1000);
  const at = (i, j, k) => i + 10 * (j + 10 * k);
  img[at(1, 1, 1)] = 1; img[at(1, 1, 2)] = 1; img[at(1, 1, 3)] = 1; img[at(7, 1, 1)] = 1;   // L-shaped

  test("centre is the middle of the bounding box, mass the mean", () => {
    const vis = visibilityTest({ lo: 0.5, hi: 1 });
    expect(visiblePivot(img, dims, EYE, vis, "centre").pivot).toEqual([4, 1, 2]);
    expect(visiblePivot(img, dims, EYE, vis, "mass").pivot).toEqual([2.5, 1, 1.75]);
  });

  test("goes through the layer's own voxel-to-mm matrix", () => {
    const mm2 = [[2, 0, 0, -10], [0, 2, 0, 0], [0, 0, 2, 5], [0, 0, 0, 1]];
    expect(visiblePivot(img, dims, mm2, visibilityTest({ lo: 0.5, hi: 1 }), "centre").pivot).toEqual([-2, 2, 9]);
  });

  test("only what the layer shows counts, and nothing visible gives null", () => {
    const img2 = img.slice(); img2[at(9, 9, 9)] = 5;                                    // outside the window
    expect(visiblePivot(img2, dims, EYE, visibilityTest({ lo: 0.5, hi: 1 }), "centre").pivot).toEqual([4, 1, 2]);
    expect(visiblePivot(img2, dims, EYE, visibilityTest({ lo: 2, hi: 3 }), "centre")).toBeNull();
    // "show outside thresholds": the 5 is visible now, the 1s are not; zeros masked
    expect(visiblePivot(img2, dims, EYE, visibilityTest({ lo: 0.5, hi: 1, invert: true, maskZero: true }), "centre").pivot).toEqual([9, 9, 9]);
  });

  test("signature changes with the window, or with the crosshair in crosshair mode", () => {
    expect(pivotSignature("centre", { lo: 1, hi: 2 })).not.toEqual(pivotSignature("centre", { lo: 1, hi: 3 }));
    expect(pivotSignature("crosshair", { crosshair: [1, 2, 3] })).not.toEqual(pivotSignature("crosshair", { crosshair: [1, 2, 4] }));
  });
});

describe("changing the pivot keeps the layer where it is", () => {
  const t = normalizeTransform(T([4, -2, 7], [20, -35, 60], 1.3, { pivot: [10, 0, -5] }));
  const pose = (tr) => transformMatrix(tr, tr.pivot);
  const pts = [[0, 0, 0], [30, -12, 8], [-7, 44, 19]];

  test("repivot gives the same pose about a new point", () => {
    const moved = repivot(t, [-3, 8, 12], t.pivot);
    for (const p of pts) apply(pose(moved), p).forEach((v, i) => expect(v).toBeCloseTo(apply(pose(t), p)[i], 9));
    expect(moved.pivot).toEqual([-3, 8, 12]);
  });

  test("the crosshair pivot turns about the crosshair as shown", () => {
    const shown = [25, -6, 3];
    const p = pivotForDisplayedPoint(t, shown, t.pivot);
    const moved = repivot(t, p, t.pivot);
    // its turning centre (pivot after the transform) sits on the crosshair
    apply(pose(moved), p).forEach((v, i) => expect(v).toBeCloseTo(shown[i], 9));
  });

  test("a transform saved without a pivot still turns about the grid centre", () => {
    const affine = [[1, 0, 0, -50], [0, 1, 0, -60], [0, 0, 1, -40], [0, 0, 0, 1]];
    const legacy = T([0, 0, 0], [0, 0, 90]);
    const c = volumeCentreMM(affine, [101, 121, 81]);
    const a = transformedAffine(affine, [101, 121, 81], legacy);
    apply(a, [50, 60, 40]).forEach((v, i) => expect(v).toBeCloseTo(c[i], 9));     // the centre voxel stays put
  });
});
