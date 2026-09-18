import { BASE_THICKNESS_MM, TRACT_OPACITY_GAMMA } from "@/lib/gl/tractShaders";

// ===== mrview-parity tractography renderer: pure UI<->render-state math =====
// No GL, no React. These are
// unit-testable in isolation and are the single place the sidebar's slider
// positions get translated into the values tractRenderer.js reads every frame.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export const DEFAULT_TRACT_RENDER = {
  // "tubes" is the default for mrview parity: lit pseudotubes, not a 1px
  // line, is the default tract appearance mrview ships. It requires
  // lib/gl/tractBuffers.js — bindTractGeometry draws nothing for any geometry
  // other than 'lines' without the compacted instanced buffer.
  geometry: "tubes",
  lighting: false,         // mrview parity: off by default
  thicknessUI: 50,         // 0..100 slider position
  // slabEnabled is
  // gone — the slab is always on, so there is no "off" state to
  // default to. slabMM defaults to 5, not 10: with no toggle, this is the
  // value that must preserve the documented optic-radiation behaviour, i.e.
  // the literal `5` NiivueViewer.jsx's Niivue constructor still carries for
  // meshThicknessOn2D (see the comment above that constructor line — 5mm
  // keeps the slab inside the head extent everywhere; a larger default
  // projected the optic radiation's occipital end onto an empty edge slice).
  slabMM: 5,
  displayPct: 100,
};

// UI 0..100  ->  mrview slider -1000..1000  ->  mm.
// mrview: thickness is screen-space and FOV-relative; 0.35 mm at slider 0.
export function sliderToThicknessMM(ui) {
  const mrview = (clamp(ui, 0, 100) - 50) * 20;       // [-1000, 1000]
  return BASE_THICKNESS_MM * Math.exp(2e-3 * mrview); // [0.047, 2.6] mm
}

// Tract opacity slider percent -> mrview's line_opacity (quadratic). Not
// currently wired into the opacity slider's own onChange (that slider writes
// mesh.opacity 0..1 directly, and TRACT_OPACITY_GAMMA is applied per-frame
// inside tractRenderer.js) — exported per the module map for anything that
// needs to display or reason about the *effective* mrview-equivalent opacity.
export function opacityToLineOpacity(pct) {
  const t = clamp(pct, 0, 100) / 100;
  return Math.pow(t, TRACT_OPACITY_GAMMA);
}

// Display-fraction percent -> niivue fiberDecimationStride.
export function pctToStride(pct) {
  return clamp(Math.round(100 / clamp(pct, 1, 100)), 1, 100);
}

// mrview's own default: 2x voxel size, floored at 2.5 mm. Offered as a
// preset, NOT used as our default — see DEFAULT_TRACT_RENDER.slabMM = 5.
// mrview defaults crop-to-slab ON at 2x voxel size. Here the slab is confined
// to the 2D slice views only (the 3D shader-side discard is permanently
// off), so this no longer risks hiding a whole-brain tract in the 3D render;
// the 5mm default is instead the value that keeps the 2D slab from clipping
// the optic-radiation bundle off empty edge slices (see the comment above
// `meshThicknessOn2D: 5,` in NiivueViewer.jsx).
//
// Verified ground truth: pixDims lives at nv.volumes[0].hdr.pixDims[1..3]
// (grep "pixDims" in dist/index.js — NVImage stores the NIfTI header's own
// pixDims array under .hdr, there is no top-level nv.volumes[0].pixDims).
export function defaultSlabMM(nv) {
  const pixDims = nv?.volumes?.[0]?.hdr?.pixDims;
  if (!pixDims || pixDims.length < 4) return 2.5;
  const mean = (Math.abs(pixDims[1]) + Math.abs(pixDims[2]) + Math.abs(pixDims[3])) / 3;
  if (!Number.isFinite(mean) || mean <= 0) return 2.5;
  return Math.max(mean * 2, 2.5);
}
