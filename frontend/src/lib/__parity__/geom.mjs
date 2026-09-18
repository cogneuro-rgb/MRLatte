// Tiny affine-construction helpers shared by fixtures.mjs and atlases.mjs.
// These build the same {img, dimsRAS, matRAS} shape volumeAnalysis.js/
// lesionReport.js expect from a niivue NVImage (see volumeAnalysis.js:1-4 and
// the geometry note at :97-101) — matRAS is a column-major voxel->mm mat4:
//   M[4*c+r] = basis[r][c]  (c<3),  M[12+r] = origin[r],  M[15] = 1
// which matches voxToMM's `M[0]*i + M[4]*j + M[8]*k + M[12]` convention.
//
// We don't actually reorient anything to true RAS here (no niivue in Node) —
// the functions under test only require that `img`'s voxel order and
// `matRAS` describe the SAME grid consistently, which these fixtures do by
// construction. See __parity__/README.md for why that's a safe substitution.

export function affineFromBasis(basis, origin) {
  return [
    basis[0][0], basis[1][0], basis[2][0], 0,
    basis[0][1], basis[1][1], basis[2][1], 0,
    basis[0][2], basis[1][2], basis[2][2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

export function isotropicAxisAlignedAffine(voxSizeMM, originMM) {
  return affineFromBasis(
    [
      [voxSizeMM, 0, 0],
      [0, voxSizeMM, 0],
      [0, 0, voxSizeMM],
    ],
    originMM
  );
}

// Rotation about Z then X (degrees), scaled by voxSizeMM — an oblique,
// non-axis-aligned voxel->mm basis.
export function obliqueAffine(voxSizeMM, originMM, degZ, degX) {
  const rz = (degZ * Math.PI) / 180;
  const rx = (degX * Math.PI) / 180;
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const cx = Math.cos(rx), sx = Math.sin(rx);
  // Rx * Rz (apply Z-rotation first, then X-rotation)
  const Rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  const Rx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const R = matmul3(Rx, Rz);
  const basis = R.map((row) => row.map((v) => v * voxSizeMM));
  return affineFromBasis(basis, originMM);
}

function matmul3(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
    }
  }
  return out;
}

// World-mm origin (voxel [0,0,0]) such that the given voxel index maps to
// worldCenterMM, for the given basis (3x3 row-major, A[r][c]).
export function originForCenteredGrid(basis, dims, worldCenterMM) {
  const half = dims.map((d) => d / 2);
  const shift = [0, 1, 2].map(
    (r) => basis[r][0] * half[0] + basis[r][1] * half[1] + basis[r][2] * half[2]
  );
  return [0, 1, 2].map((r) => worldCenterMM[r] - shift[r]);
}

export function basisFromAffine(M) {
  return [
    [M[0], M[4], M[8]],
    [M[1], M[5], M[9]],
    [M[2], M[6], M[10]],
  ];
}

export function voxToMM(matRAS, [i, j, k]) {
  const M = matRAS;
  return [
    M[0] * i + M[4] * j + M[8] * k + M[12],
    M[1] * i + M[5] * j + M[9] * k + M[13],
    M[2] * i + M[6] * j + M[10] * k + M[14],
  ];
}

// affineDet3 now lives in volumeAnalysis.js and is exported, so the harness
// runs the REAL function rather than a copy of it — re-exported here so
// run.mjs keeps its single geometry import. (It was module-private in
// lesionReport.js when this harness was first written; it moved when the
// percentOfRegion unit bug was fixed — see README.md.)
export { affineDet3 } from "@/lib/volumeAnalysis";
