// Best-effort classification of a NIfTI file dropped on the app via Explorer
// double-click / file association: base anatomical volume, activation/stat
// overlay, or 4D timeseries. Also doubles as the runtime gzip/NIfTI content
// guard for the `.gz` file association (decision 3 in the quick-open plan) —
// a `.gz` that isn't actually gzip, or gzip content that isn't NIfTI, is
// rejected here before anything tries to load it.
//
// Header-only where possible: a 4D file short-circuits on dims alone, and a
// mistakenly-associated non-NIfTI `.gz` (e.g. a `.tar.gz`) is caught by a
// partial, bounded decompress — so opening the wrong file stays cheap.
import * as nifti from "nifti-reader-js";

export const STAT_FILENAME_PATTERNS = [
  "zstat", "tstat", "zmap", "tmap", "spmt", "cope", "pval", "bf10", "activation", "contrast",
];

// NIFTI_INTENT_CORREL(2) .. NIFTI_INTENT_POISSON(24): the statistical-map
// intent range. Excludes 0 (NONE, i.e. "just an image") and 1002 (LABEL,
// handled separately by colormapUtils.isLabelIntentOverlay).
const STAT_INTENT_MIN = 2;
const STAT_INTENT_MAX = 24;

// At least 0.5% of nonzero voxels must be negative before a signed volume
// counts as "activation" — a stray negative from interpolation noise on an
// otherwise-positive anatomical scan shouldn't misroute it.
const NEG_FRACTION_MIN = 0.005;

// Only the datatype codes worth an O(n) sign scan. Unsigned codes can never
// be negative (skip trivially); anything not listed (RGB24, complex,
// 64/128-bit) is rare enough here that we skip rather than special-case it.
const TYPED_ARRAY_BY_CODE = {
  2: Uint8Array, // TYPE_UINT8
  4: Int16Array, // TYPE_INT16
  8: Int32Array, // TYPE_INT32
  16: Float32Array, // TYPE_FLOAT32
  64: Float64Array, // TYPE_FLOAT64
  256: Int8Array, // TYPE_INT8
  512: Uint16Array, // TYPE_UINT16
  768: Uint32Array, // TYPE_UINT32
};
const UNSIGNED_CODES = new Set([2, 512, 768]);

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function baseName(fileName) {
  return String(fileName || "").split(/[\\/]/).pop().toLowerCase();
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} fileName
 * @returns {Promise<{ok:false,error:"not-gzip"|"not-nifti"} | {ok:true,kind:"timeseries",nFrames:number,reason:string} | {ok:true,kind:"base"|"activation",signed:boolean,statIntent:boolean,keyword:string|null,reason:string}>}
 */
export async function classifyNiftiBuffer(bytes, fileName) {
  const buf = toArrayBuffer(bytes);
  const looksGz = /\.gz$/i.test(fileName || "");
  const compressed = nifti.isCompressed(buf);

  if (looksGz && !compressed) {
    return { ok: false, error: "not-gzip" };
  }

  try {
    const headerBuf = compressed ? await nifti.decompressHeaderAsync(buf, 1024) : buf;
    if (!nifti.isNIFTI(headerBuf)) {
      return { ok: false, error: "not-nifti" };
    }

    const partialHeader = nifti.readHeader(headerBuf);
    const dims = partialHeader.dims || [];
    const nFrames = Math.max(dims[4] || 1, dims[5] || 1, dims[6] || 1, dims[7] || 1);
    if (nFrames > 1) {
      return { ok: true, kind: "timeseries", nFrames, reason: `${nFrames}-frame 4D volume` };
    }

    const full = compressed ? await nifti.decompressAsync(buf) : buf;
    const hdr = nifti.readHeader(full);
    const imageBuf = nifti.readImage(hdr, full);

    // Deliberately evaluated on raw stored values, not scl_slope/scl_inter-
    // scaled ones: a CT volume stored as uint16 with a negative scl_inter
    // has negative *scaled* Hounsfield units, but the stored data itself
    // never goes negative, so CT correctly stays classified as base.
    let signed = false;
    const TypedCtor = TYPED_ARRAY_BY_CODE[hdr.datatypeCode];
    if (TypedCtor && !UNSIGNED_CODES.has(hdr.datatypeCode)) {
      const arr = new TypedCtor(imageBuf);
      let min = Infinity;
      let nonZero = 0;
      let neg = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v !== 0) {
          nonZero++;
          if (v < 0) neg++;
        }
        if (v < min) min = v;
      }
      signed = min < 0 && nonZero > 0 && neg / nonZero >= NEG_FRACTION_MIN;
    }

    const statIntent = hdr.intent_code >= STAT_INTENT_MIN && hdr.intent_code <= STAT_INTENT_MAX;
    const name = baseName(fileName);
    const keyword = STAT_FILENAME_PATTERNS.find((k) => name.includes(k)) || null;

    const isActivation = signed || statIntent || !!keyword;
    const reasons = [];
    if (signed) reasons.push("negative voxel values");
    if (statIntent) reasons.push(`statistical intent code (${hdr.intent_code})`);
    if (keyword) reasons.push(`filename contains "${keyword}"`);

    return {
      ok: true,
      kind: isActivation ? "activation" : "base",
      signed,
      statIntent,
      keyword,
      reason: reasons.length ? reasons.join(", ") : "no activation signal detected",
    };
  } catch (_err) {
    return { ok: false, error: compressed ? "not-gzip" : "not-nifti" };
  }
}
