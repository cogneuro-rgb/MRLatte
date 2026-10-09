// Readable summary of a loaded volume's NIfTI header, for the header viewer
// (NiftiHeaderDialog). Pure: takes niivue's NVImage.hdr (a nifti-reader-js
// NIFTI1/NIFTI2 object — plain fields are read, its helper methods are not
// relied on) and returns [{ title, rows: [[label, value]] }].
//
// Values are shown as niivue parsed them. One exception is flagged: a file
// with neither a qform nor an sform gets re-centred by the viewer
// (correctDegenerateAffineIfNeeded), so its displayed affine is the app's, not
// the file's.

const DATATYPES = {
  1: "binary", 2: "uint8", 4: "int16", 8: "int32", 16: "float32", 32: "complex64",
  64: "float64", 128: "RGB24", 256: "int8", 512: "uint16", 768: "uint32",
  1024: "int64", 1280: "uint64", 1536: "float128", 1792: "complex128",
  2048: "complex256", 2304: "RGBA32",
};

const XFORMS = {
  0: "unknown", 1: "scanner anatomical", 2: "aligned anatomical",
  3: "Talairach", 4: "MNI152", 5: "template",
};

const SPACE_UNITS = { 0: "", 1: "m", 2: "mm", 3: "µm" };
const TIME_UNITS = { 0: "", 8: "s", 16: "ms", 24: "µs", 32: "Hz", 40: "ppm", 48: "rad/s" };

const INTENTS = {
  0: "none", 2: "correlation", 3: "t-test", 4: "F-test", 5: "z-score",
  6: "χ²", 1001: "estimate", 1002: "label", 1003: "NeuroName", 1004: "general matrix",
  1005: "symmetric matrix", 1006: "displacement vector", 1007: "vector",
  1008: "point set", 1009: "triangle", 1010: "quaternion", 1011: "dimensionless",
  2001: "time series", 2002: "node index", 2003: "RGB vector", 2004: "RGBA vector", 2005: "shape",
};

const num = (v, digits = 4) => {
  if (v == null || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return String(v);
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(digits));
};
const named = (map, code) => (code in map ? `${map[code]} (${code})` : `code ${code}`);
const text = (s) => (s && String(s).replace(/\0/g, "").trim()) || "—";

/**
 * Every field on the parsed header, uncurated, for the dialog's "Show all
 * fields" view: [[fieldName, value]] in the parser's own order. Methods are
 * skipped; arrays and matrices are flattened to text; extension payloads are
 * summarised rather than dumped (they can be large binary blobs).
 */
export function allNiftiHeaderFields(hdr) {
  if (!hdr) return [];
  const fmt = (v) => {
    if (v == null) return "—";
    if (typeof v === "number") return num(v, 6);
    if (typeof v === "string") return text(v);
    if (typeof v === "boolean") return String(v);
    if (ArrayBuffer.isView(v)) return `${v.length} values`;
    if (Array.isArray(v)) {
      return v.some(Array.isArray) ? v.map((row) => fmt(row)).join("  |  ") : v.map((x) => fmt(x)).join(", ");
    }
    return JSON.stringify(v).slice(0, 200);
  };
  return Object.keys(hdr)
    .filter((k) => typeof hdr[k] !== "function")
    .map((k) => [k, k === "extensions" ? `${hdr[k]?.length ?? 0} extension(s)` : fmt(hdr[k])]);
}

export function summarizeNiftiHeader(hdr) {
  if (!hdr) return [];
  const dims = hdr.dims || [];
  const nd = Math.max(0, Math.min(7, dims[0] || 0));
  const pix = hdr.pixDims || [];
  const space = SPACE_UNITS[(hdr.xyzt_units ?? 0) & 0x07] ?? "";
  const time = TIME_UNITS[(hdr.xyzt_units ?? 0) & 0x38] ?? "";
  const size = dims.slice(1, 1 + nd).join(" × ") || "—";
  const voxel = pix.slice(1, 1 + Math.min(nd, 3)).map((v) => num(v)).join(" × ");
  const noTransform = hdr.qform_code === 0 && hdr.sform_code === 0;

  const sections = [
    {
      title: "File",
      rows: [
        ["Format", hdr.magic ? `${String(hdr.magic).startsWith("n+2") || String(hdr.magic).startsWith("ni2") ? "NIfTI-2" : "NIfTI-1"} (${text(hdr.magic)})` : "—"],
        ["Byte order", hdr.littleEndian === false ? "big-endian" : "little-endian"],
        ["Description", text(hdr.description)],
        ["Aux file", text(hdr.aux_file)],
      ],
    },
    {
      title: "Dimensions",
      rows: [
        ["Size", `${size}${nd > 3 ? `  (${nd}D)` : ""}`],
        ["Voxel size", voxel ? `${voxel}${space ? ` ${space}` : ""}` : "—"],
        ...(nd > 3 ? [["Time step", `${num(pix[4])}${time ? ` ${time}` : ""}`]] : []),
        ["Data type", `${named(DATATYPES, hdr.datatypeCode)}, ${hdr.numBitsPerVoxel ?? "?"} bits`],
      ],
    },
    {
      title: "Intensity",
      rows: [
        ["Scale (slope / intercept)", `${num(hdr.scl_slope)} / ${num(hdr.scl_inter)}`],
        ["Display range (cal_min / cal_max)", `${num(hdr.cal_min)} / ${num(hdr.cal_max)}`],
        ["Intent", `${named(INTENTS, hdr.intent_code ?? 0)}${text(hdr.intent_name) !== "—" ? ` "${text(hdr.intent_name)}"` : ""}`],
      ],
    },
    {
      title: "Orientation",
      rows: [
        ["qform", named(XFORMS, hdr.qform_code ?? 0)],
        ["sform", named(XFORMS, hdr.sform_code ?? 0)],
        ["Quaternion (b, c, d)", [hdr.quatern_b, hdr.quatern_c, hdr.quatern_d].map((v) => num(v)).join(", ")],
        ["qform offset (x, y, z)", [hdr.qoffset_x, hdr.qoffset_y, hdr.qoffset_z].map((v) => num(v, 2)).join(", ")],
        ...(Array.isArray(hdr.affine)
          ? hdr.affine.slice(0, 3).map((row, i) => [
            i === 0 ? "Affine (voxel → mm)" : "",
            row.map((v) => num(v, 3)).join("   "),
          ])
          : []),
        ...(noTransform
          ? [["Note", "The file has no qform or sform, so MRLatte centred it for display — the affine above is the app's, not the file's."]]
          : []),
      ],
    },
  ];
  if (hdr.extensions?.length) {
    sections.push({
      title: "Extensions",
      rows: hdr.extensions.map((e, i) => [`#${i + 1}`, `code ${e.ecode ?? e.code ?? "?"}, ${e.esize ?? e.size ?? "?"} bytes`]),
    });
  }
  return sections;
}
