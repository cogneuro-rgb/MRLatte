// Atlas loading: real repo atlases (data/modules/atlases/*, checked-in,
// small) parsed with the frontend's own "nifti-reader-js" dependency — no
// new NIfTI-parsing code — plus one synthetic hand-built atlas for a fully
// controlled cross-check. See README.md for why both are included.
import fs from "node:fs";
import path from "node:path";
import * as nifti from "nifti-reader-js";
import { isotropicAxisAlignedAffine } from "./geom.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODULE_ROOT = path.join(REPO_ROOT, "data", "modules", "atlases");

function typedArrayFor(datatypeCode, buf) {
  const T = nifti.NIFTI1;
  switch (datatypeCode) {
    case T.TYPE_UINT8: return new Uint8Array(buf);
    case T.TYPE_INT8: return new Int8Array(buf);
    case T.TYPE_INT16: return new Int16Array(buf);
    case T.TYPE_UINT16: return new Uint16Array(buf);
    case T.TYPE_INT32: return new Int32Array(buf);
    case T.TYPE_UINT32: return new Uint32Array(buf);
    case T.TYPE_FLOAT32: return new Float32Array(buf);
    case T.TYPE_FLOAT64: return new Float64Array(buf);
    default: throw new Error(`Unsupported NIfTI datatype code ${datatypeCode}`);
  }
}

// hdr.affine is row-major [row][col] (nifti-reader-js), matching the
// convention volumeAnalysis.js's regionCentroidMM already assumes for raw
// hdr.affine. Convert to the column-major mat4 matRAS/voxToMM expects.
function mat4FromHeaderAffine(A) {
  return [
    A[0][0], A[1][0], A[2][0], 0,
    A[0][1], A[1][1], A[2][1], 0,
    A[0][2], A[1][2], A[2][2], 0,
    A[0][3], A[1][3], A[2][3], 1,
  ];
}

function loadRealAtlas(atlasId, fileBase) {
  const niiPath = path.join(MODULE_ROOT, atlasId, `${fileBase}.nii.gz`);
  const labelsPath = path.join(MODULE_ROOT, atlasId, `${fileBase}.labels.json`);
  const raw = fs.readFileSync(niiPath);
  let data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  if (nifti.isCompressed(data)) data = nifti.decompress(data);
  const hdr = nifti.readHeader(data);
  const imgBuf = nifti.readImage(hdr, data);
  let arr = typedArrayFor(hdr.datatypeCode, imgBuf);
  const slope = hdr.scl_slope || 0;
  if (slope !== 0 && (slope !== 1 || hdr.scl_inter !== 0)) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] * slope + hdr.scl_inter;
    arr = out;
  }
  const [nx, ny, nz] = hdr.dims.slice(1, 4);
  const matRAS = mat4FromHeaderAffine(hdr.affine);

  let labelMap = {};
  if (fs.existsSync(labelsPath)) {
    const parsed = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
    // This repo's *.labels.json is {schemaVersion, regions: [{value,name}]}.
    // Normalize that plus a couple of plausible alternate shapes defensively.
    const list = parsed.regions || parsed.labels || (Array.isArray(parsed) ? parsed : null);
    if (list) {
      for (const e of list) labelMap[e.value ?? e.label ?? e.id] = e.name ?? e.label ?? String(e);
    } else if (typeof parsed === "object") {
      labelMap = parsed;
    }
  }

  return {
    vol: { img: arr, dimsRAS: [3, nx, ny, nz], matRAS, dims: [nx, ny, nz] },
    labelMap,
    source: "real",
    file: path.relative(REPO_ROOT, niiPath).replace(/\\/g, "/"),
  };
}

// Synthetic hemisphere-split atlas: label 1 where world x<0, label 2 where
// x>=0. Built on the exact grid/affine of the real AAL atlas it's loaded
// alongside (91x109x91 @ 2mm MNI) so it covers the same fixture placements
// with a hand-verifiable rule, purely for cross-checking the real-atlas
// numbers — see README.md "Atlases used".
function buildSyntheticHemiAtlas(referenceDims, referenceMatRAS) {
  const [nx, ny, nz] = referenceDims;
  const img = new Int16Array(nx * ny * nz);
  const M = referenceMatRAS;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = M[0] * i + M[4] * j + M[8] * k + M[12];
        img[i + nx * (j + ny * k)] = x < 0 ? 1 : 2;
      }
    }
  }
  return {
    vol: { img, dimsRAS: [3, nx, ny, nz], matRAS: M, dims: [nx, ny, nz] },
    labelMap: { 1: "synthetic-left (x<0)", 2: "synthetic-right (x>=0)" },
    source: "synthetic",
    file: null,
  };
}

export function loadAtlases() {
  const aal = loadRealAtlas("aal", "aal");
  const hoCort = loadRealAtlas("harvard_oxford_cort", "harvard_oxford_cort");
  const synthetic = buildSyntheticHemiAtlas(aal.vol.dims, aal.vol.matRAS);
  return [
    { id: "aal", name: "AAL", ...aal },
    { id: "harvard_oxford_cort", name: "Harvard-Oxford Cortical", ...hoCort },
    { id: "synthetic_hemi", name: "Synthetic hemisphere split (x<0 / x>=0)", ...synthetic },
  ];
}
