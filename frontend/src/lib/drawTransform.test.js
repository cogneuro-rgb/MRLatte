import { transformLabels, labelBounds, invert4, mat4ToRows } from "./drawTransform";

const DIMS = [40, 40, 40];
const EYE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const MM2 = [[-2, 0, 0, 40], [0, 2, 0, -40], [0, 0, 2, -40], [0, 0, 0, 1]];   // 2 mm, x flipped
const idx = (i, j, k) => i + 40 * (j + 40 * k);
const T = (translation = [0, 0, 0], rotation = [0, 0, 0], scale = 1) => ({ translation, rotation, scale });

function block(lo, hi, label = 1) {
  const a = new Uint8Array(40 * 40 * 40);
  for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) a[idx(i, j, k)] = label;
  return a;
}
const count = (a) => a.reduce((n, v) => n + (v ? 1 : 0), 0);

describe("moving the drawing", () => {
  test("no change leaves it exactly as it was", () => {
    const src = block([10, 12, 14], [15, 18, 20], 3);
    expect(transformLabels(src, DIMS, MM2, T())).toEqual(src);
  });

  test("a move in mm becomes a move in voxels, in the right direction", () => {
    const src = block([10, 10, 10], [14, 14, 14]);
    // +4 mm in world x is -2 voxels here (x is flipped); +6 mm in y is +3 voxels
    const out = transformLabels(src, DIMS, MM2, T([4, 6, 0]));
    expect(labelBounds(out, DIMS)).toEqual([[8, 13, 10], [12, 17, 14]]);
    expect(count(out)).toBe(count(src));
  });

  test("pen colours are kept", () => {
    const src = block([10, 10, 10], [12, 12, 12], 2);
    src[idx(11, 11, 11)] = 5;
    const out = transformLabels(src, DIMS, EYE, T([3, 0, 0]));
    expect(out[idx(14, 11, 11)]).toBe(5);
    expect(new Set(out.filter(Boolean))).toEqual(new Set([2, 5]));
  });

  test("a quarter turn about its own centre keeps it in place and its size", () => {
    const src = block([10, 18, 15], [29, 21, 25]);            // 20 x 4 x 11, centre (19.5, 19.5, 20)
    const out = transformLabels(src, DIMS, EYE, T([0, 0, 0], [0, 0, 90]));
    const [lo, hi] = labelBounds(out, DIMS);
    expect(hi[0] - lo[0] + 1).toBe(4);                        // the long side now runs along y
    expect(hi[1] - lo[1] + 1).toBe(20);
    expect((lo[0] + hi[0]) / 2).toBeCloseTo(19.5, 0);
    expect((lo[1] + hi[1]) / 2).toBeCloseTo(19.5, 0);
    expect(Math.abs(count(out) - count(src)) / count(src)).toBeLessThan(0.02);
  });

  test("doubling the size gives about eight times the voxels", () => {
    const src = block([16, 16, 16], [21, 21, 21]);            // 6^3
    const out = transformLabels(src, DIMS, EYE, T([0, 0, 0], [0, 0, 0], 2));
    expect(count(out)).toBe(12 ** 3);
  });

  test("anything moved past the edge of the grid is dropped, not wrapped", () => {
    const src = block([35, 10, 10], [39, 12, 12]);
    const out = transformLabels(src, DIMS, EYE, T([3, 0, 0]));
    expect(labelBounds(out, DIMS)).toEqual([[38, 10, 10], [39, 12, 12]]);
  });

  test("an empty drawing stays empty", () => {
    expect(count(transformLabels(new Uint8Array(40 ** 3), DIMS, EYE, T([5, 0, 0])))).toBe(0);
  });
});

describe("matrix helpers", () => {
  test("invert4 undoes a matrix", () => {
    const inv = invert4(MM2);
    const p = [7, -3, 11];
    const w = [0, 1, 2].map((i) => MM2[i][0] * p[0] + MM2[i][1] * p[1] + MM2[i][2] * p[2] + MM2[i][3]);
    const back = [0, 1, 2].map((i) => inv[i][0] * w[0] + inv[i][1] * w[1] + inv[i][2] * w[2] + inv[i][3]);
    back.forEach((v, i) => expect(v).toBeCloseTo(p[i], 9));
  });

  test("niivue's matRAS (stored in row order) is read the right way round", () => {
    const matRAS = [-2, 0, 0, 40, 0, 2, 0, -40, 0, 0, 2, -40, 0, 0, 0, 1];
    expect(mat4ToRows(matRAS)).toEqual(MM2);
  });
});
