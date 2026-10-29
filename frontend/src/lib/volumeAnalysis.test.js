import { lockedColorRange, robustRange } from "./volumeAnalysis";

describe("colour range locked to the visibility values", () => {
  test("a visibility window: the colour range is that window", () => {
    expect(lockedColorRange({ global_min: 0, global_max: 90 }, 20, 60)).toEqual([20, 60]);
  });
  test("an inverted threshold on a positive map: from the threshold to the maximum", () => {
    // Stat-map default: hide −1…1, show the rest. Locking to −1…1 itself
    // would saturate every visible voxel.
    expect(lockedColorRange({ invertThreshold: true, global_min: 0, global_max: 91.5 }, -1, 1)).toEqual([1, 91.5]);
  });
  test("an inverted threshold on a two-sided map: everything visible, both tails", () => {
    expect(lockedColorRange({ invertThreshold: true, global_min: -8, global_max: 6 }, -3, 3)).toEqual([-8, 6]);
  });
  test("an inverted threshold on a negative map: from the minimum to the threshold", () => {
    expect(lockedColorRange({ invertThreshold: true, global_min: -10, global_max: 0 }, -2, 2)).toEqual([-10, -2]);
  });
  test("no data range known: falls back to the visibility values", () => {
    expect(lockedColorRange({ invertThreshold: true }, -1, 1)).toEqual([-1, 1]);
  });
});

describe("robust range of an integer volume with a scale factor", () => {
  // niivue keeps vol.img raw for scaled integer NIfTI (e.g. the MNI152
  // template: uint8, scl_slope ≈ 0.3587); the window must come back in the
  // displayed units that cal_min/cal_max and global_min/max use.
  const img = new Uint8Array(200); // zeros: background, skipped
  img.fill(1, 0, 5);
  img.fill(128, 5, 95);
  img.fill(255, 95, 100);
  test("the window is in scaled units", () => {
    const [lo, hi] = robustRange({ img, hdr: { scl_slope: 0.5, scl_inter: 10 } });
    expect(lo).toBeCloseTo(10.5); // 1 * 0.5 + 10
    expect(hi).toBeCloseTo(137.5); // 255 * 0.5 + 10
  });
  test("a negative slope still returns [lo, hi]", () => {
    const [lo, hi] = robustRange({ img, hdr: { scl_slope: -0.5, scl_inter: 0 } });
    expect(lo).toBeCloseTo(-127.5);
    expect(hi).toBeCloseTo(-0.5);
  });
});
