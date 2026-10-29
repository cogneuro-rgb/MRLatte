import { rleEncode, rleDecode, hasAnyNonZero, sameBytes } from "./drawHistory";

// The plain one-byte-at-a-time encoder the fast one must match exactly.
function referenceEncode(arr) {
  const runs = [];
  let i = 0;
  while (i < arr.length) {
    let j = i + 1;
    while (j < arr.length && arr[j] === arr[i]) j++;
    runs.push(arr[i], j - i);
    i = j;
  }
  return { len: arr.length, runs };
}

function sparse(n, seed) {
  const a = new Uint8Array(n);
  let x = seed;
  for (let k = 0; k < 40; k++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const start = x % n, len = 1 + (x % 37);
    a.fill(1 + (k % 3), start, Math.min(n, start + len));
  }
  return a;
}

describe("drawing history snapshots", () => {
  test("encoding is identical to the plain encoder, and round-trips", () => {
    for (const n of [0, 1, 3, 4, 5, 1023, 4096, 10007]) {
      for (const seed of [1, 7, 99]) {
        const a = sparse(Math.max(n, 1), seed).subarray(0, n);
        expect(rleEncode(a)).toEqual(referenceEncode(a));
        expect(rleDecode(rleEncode(a))).toEqual(a);
      }
    }
  });

  test("works on a view that doesn't start on a 4-byte boundary", () => {
    const base = sparse(5000, 3);
    for (const off of [1, 2, 3]) {
      const v = base.subarray(off, 4000 + off);
      expect(rleEncode(v)).toEqual(referenceEncode(v));
    }
  });

  test("all-background and all-painted bitmaps", () => {
    expect(rleEncode(new Uint8Array(1000))).toEqual({ len: 1000, runs: [0, 1000] });
    expect(rleEncode(new Uint8Array(1001).fill(2))).toEqual({ len: 1001, runs: [2, 1001] });
  });
});

describe("bitmap checks", () => {
  test("hasAnyNonZero finds one painted voxel anywhere", () => {
    for (const n of [1, 4, 7, 4099]) {
      const a = new Uint8Array(n);
      expect(hasAnyNonZero(a)).toBe(false);
      for (const at of [0, n - 1, n >> 1]) {
        a.fill(0); a[at] = 5;
        expect(hasAnyNonZero(a)).toBe(true);
        expect(hasAnyNonZero(a.subarray(1))).toBe(at >= 1);
      }
    }
    expect(hasAnyNonZero(null)).toBe(false);
  });

  test("sameBytes spots a difference in the last byte and across views", () => {
    const a = sparse(4099, 11), b = a.slice();
    expect(sameBytes(a, b)).toBe(true);
    b[4098] ^= 1;
    expect(sameBytes(a, b)).toBe(false);
    expect(sameBytes(a.subarray(1, 101), a.slice(1, 101))).toBe(true);
    expect(sameBytes(a, a.subarray(0, 10))).toBe(false);
  });
});
