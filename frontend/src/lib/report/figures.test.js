import { volumeSampler, extentMM, slicePositions, tileGeometry, displayWindow } from "./figures";

// A 4×4×4 volume whose native i axis runs right→left (x = 2 - i): a flipped,
// non-RAS grid like the LIA atlases, so a sampler that ignores the affine fails.
function vol(fill, { slope } = {}) {
  const img = new Float32Array(64);
  fill(img, (i, j, k) => i + 4 * (j + 4 * k));
  return {
    img,
    hdr: {
      dims: [3, 4, 4, 4],
      affine: [[-1, 0, 0, 2], [0, 1, 0, -1], [0, 0, 2, -3], [0, 0, 0, 1]],
      scl_slope: slope ?? 1, scl_inter: 0,
    },
  };
}

describe("report figures: sampling in world mm", () => {
  test("a voxel is found at its world position through a flipped affine", () => {
    const v = vol((img, at) => { img[at(0, 1, 2)] = 7; });   // world (2, 0, 1)
    const s = volumeSampler(v);
    expect(s.at(2, 0, 1)).toBe(7);
    expect(s.at(-1, 0, 1)).toBe(0);                          // i = 3, same row: empty
    expect(Number.isNaN(s.at(50, 0, 0))).toBe(true);         // outside the grid
  });

  test("values are scaled by the header's slope", () => {
    const v = vol((img, at) => { img[at(1, 1, 1)] = 2; }, { slope: 0.5 });
    expect(volumeSampler(v).at(1, 0, -1)).toBe(1);
  });

  test("extent and centroid of a mask, in world mm", () => {
    const v = vol((img, at) => { img[at(0, 0, 0)] = 1; img[at(2, 0, 0)] = 1; });
    const e = extentMM(v, (x) => x > 0.5);
    expect(e.min).toEqual([0, -1, -3]);
    expect(e.max).toEqual([2, -1, -3]);
    expect(e.centroid).toEqual([1, -1, -3]);
    expect(extentMM(v, (x) => x > 5)).toBeNull();
  });
});

describe("report figures: layout", () => {
  test("slices sit at the centres of equal bands across the extent", () => {
    expect(slicePositions(0, 12, 3)).toEqual([2, 6, 10]);
    expect(slicePositions(5, 5, 2)).toEqual([5, 5]);
  });

  test("axial and coronal tiles are neurological: left on the left, top is anterior/superior", () => {
    const bounds = { min: [-90, -126, -72], max: [90, 90, 108] };
    const ax = tileGeometry("axial", 10, bounds, 1);
    const [xl, yt, z] = ax.toMM(0, 0);
    expect(xl).toBeLessThan(-89);          // first column = patient's left (−x)
    expect(yt).toBeGreaterThan(89);        // first row = anterior (+y)
    expect(z).toBe(10);
    expect(ax.ends).toEqual(["L", "R"]);
    const co = tileGeometry("coronal", -20, bounds, 1);
    expect(co.toMM(0, 0)[2]).toBeGreaterThan(107);           // superior at the top
    const sa = tileGeometry("sagittal", 30, bounds, 1);
    expect(sa.toMM(0, 0)[1]).toBeLessThan(-125);             // posterior on the left
    expect(sa.ends).toEqual(["P", "A"]);
  });

  test("the display window ignores background zeros", () => {
    const v = vol((img) => { for (let n = 0; n < 32; n++) img[n] = 100 + n; });
    const [lo, hi] = displayWindow(v);
    expect(lo).toBeGreaterThanOrEqual(100);
    expect(hi).toBeLessThanOrEqual(131);
  });
});
