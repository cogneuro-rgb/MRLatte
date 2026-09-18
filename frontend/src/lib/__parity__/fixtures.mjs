// Synthetic lesion fixtures, generated entirely in code — never read/write
// any .nii/.nii.gz. Each fixture is a plain object shaped like the niivue
// NVImage fields computeAtlasOverlap/computeLesionVolume actually read:
// { img: TypedArray, dimsRAS: [3,nx,ny,nz], matRAS: mat4 (col-major) }.
//
// All "anatomically placed" fixtures (everything except `empty`) share world
// centers that were picked by probing the real AAL / Harvard-Oxford-cortical
// atlases (see __parity__/README.md) so overlap against the real atlases is
// non-trivial rather than landing on background:
//   CENTER_A         [-40, -20, 50]  -> AAL label 61, HO-cort label 7
//   CENTER_A_MIRROR  [ 40, -20, 50]  -> AAL label 62, HO-cort label 7
//   CENTER_B         [-30, -60, 40]  -> AAL label 65, HO-cort label 22
import {
  isotropicAxisAlignedAffine,
  obliqueAffine,
  originForCenteredGrid,
  basisFromAffine,
  voxToMM,
} from "./geom.mjs";

export const CENTER_A = [-40, -20, 50];
export const CENTER_A_MIRROR = [40, -20, 50];
export const CENTER_B = [-30, -60, 40];

function makeVolume(dims, matRAS, fillFn) {
  const [nx, ny, nz] = dims;
  const img = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const mm = voxToMM(matRAS, [i, j, k]);
        img[i + nx * (j + ny * k)] = fillFn(mm, i, j, k);
      }
    }
  }
  return { img, dimsRAS: [3, nx, ny, nz], matRAS, dims };
}

function sphereFill(centers, radiusMM, value = 1) {
  return (mm) => {
    for (const c of centers) {
      const dx = mm[0] - c[0], dy = mm[1] - c[1], dz = mm[2] - c[2];
      if (dx * dx + dy * dy + dz * dz <= radiusMM * radiusMM) return value;
    }
    return 0;
  };
}

// 1. Clean 1mm binary sphere, axis-aligned. The "boring, everything agrees"
// baseline case — on a 1mm atlas this converges across all three axes.
function sphere1mm() {
  const voxSize = 1;
  const dims = [32, 32, 32];
  const basis = [[voxSize, 0, 0], [0, voxSize, 0], [0, 0, voxSize]];
  const origin = originForCenteredGrid(basis, dims, CENTER_A);
  const matRAS = isotropicAxisAlignedAffine(voxSize, origin);
  return makeVolume(dims, matRAS, sphereFill([CENTER_A], 8));
}

// 2. Same physical sphere, but on the lab's real 0.737mm native acquisition
// grid instead of 1mm — this is where direction/denominator start to bite.
function native0737() {
  const voxSize = 0.737;
  const dims = [34, 34, 34];
  const basis = [[voxSize, 0, 0], [0, voxSize, 0], [0, 0, voxSize]];
  const origin = originForCenteredGrid(basis, dims, CENTER_A);
  const matRAS = isotropicAxisAlignedAffine(voxSize, origin);
  return makeVolume(dims, matRAS, sphereFill([CENTER_A], 8));
}

// 3. Same physical sphere again, but on a non-axis-aligned (oblique) 1mm
// grid — exercises the general affine math in voxToMM/mmToVox, not just a
// diagonal scale.
function oblique() {
  const voxSize = 1;
  const dims = [32, 32, 32];
  const matRASNoOrigin = obliqueAffine(voxSize, [0, 0, 0], 25, 15);
  const basis = basisFromAffine(matRASNoOrigin);
  const origin = originForCenteredGrid(basis, dims, CENTER_A);
  const matRAS = obliqueAffine(voxSize, origin, 25, 15);
  return makeVolume(dims, matRAS, sphereFill([CENTER_A], 8));
}

// 4. Probabilistic lesion, values spanning (0,1] with a radial falloff that
// deliberately produces plenty of voxels in (0, 0.5) — JS keeps them
// (threshold `> 0`), LQTpy's `>= 0.5` will drop them.
function probabilistic() {
  const voxSize = 1;
  const dims = [22, 22, 22];
  const radius = 9;
  const basis = [[voxSize, 0, 0], [0, voxSize, 0], [0, 0, voxSize]];
  const origin = originForCenteredGrid(basis, dims, CENTER_B);
  const matRAS = isotropicAxisAlignedAffine(voxSize, origin);
  return makeVolume(dims, matRAS, (mm) => {
    const dx = mm[0] - CENTER_B[0], dy = mm[1] - CENTER_B[1], dz = mm[2] - CENTER_B[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const v = 1 - d / radius;
    return v > 0 ? Math.round(v * 1000) / 1000 : 0;
  });
}

// 5. Two small binary blobs 80mm apart (CENTER_A / CENTER_A_MIRROR), one
// bounding grid. In AAL they fall in two different labels (61 vs 62); in
// Harvard-Oxford-cortical they fall in the SAME label (7) — a real example
// of "straddles a parcel boundary" whose answer depends on which atlas.
function twoBlobsBoundary() {
  const voxSize = 1;
  const dims = [120, 20, 20];
  const origin = [-60, -30, 40];
  const matRAS = isotropicAxisAlignedAffine(voxSize, origin);
  return makeVolume(dims, matRAS, sphereFill([CENTER_A, CENTER_A_MIRROR], 4));
}

// 6. Empty lesion (all zero) — totalLesion === 0 / voxelCount === 0 guard
// paths (percentOfLesion divide-by-zero guard, null centroid, mm3 === 0).
function empty() {
  const voxSize = 1;
  const dims = [10, 10, 10];
  const basis = [[voxSize, 0, 0], [0, voxSize, 0], [0, 0, voxSize]];
  const origin = originForCenteredGrid(basis, dims, CENTER_A);
  const matRAS = isotropicAxisAlignedAffine(voxSize, origin);
  return makeVolume(dims, matRAS, () => 0);
}

export function buildFixtures() {
  return [
    { name: "sphere_1mm", description: "Clean 1mm binary sphere, axis-aligned, r=8mm.", vol: sphere1mm() },
    { name: "native_0737", description: "Same sphere on a 0.737mm native-grid affine (this lab's real acquisition resolution).", vol: native0737() },
    { name: "oblique", description: "Same sphere on a non-axis-aligned (25deg Z, 15deg X) 1mm oblique affine.", vol: oblique() },
    { name: "probabilistic", description: "Radial-falloff probabilistic lesion, values in (0,1], including (0,0.5).", vol: probabilistic() },
    { name: "two_blobs_boundary", description: "Two r=4mm binary blobs 80mm apart, straddling AAL's L/R boundary.", vol: twoBlobsBoundary() },
    { name: "empty", description: "All-zero lesion (edge case: no lesion voxels).", vol: empty() },
  ];
}
