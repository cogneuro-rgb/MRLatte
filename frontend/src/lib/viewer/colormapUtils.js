import { cmapper } from "@niivue/niivue";

/**
 * Build a custom colormap LUT that is transparent inside [lo, hi] of the
 * volume's full data range, and uses the base colormap's RGB outside. Used
 * by setOverlayInvertThreshold to render the inverse threshold mode.
 *
 * Niivue's `nv.addColormap(key, { R, G, B, A, I })` accepts arrays of
 * control points where I are colormap-input indices 0..255.
 */
// Stable-color thresholding for continuous overlays.
//
// Pins vol.cal_min/cal_max to the global data range so the colormap is
// always normalized to [gMin, gMax] — every LUT position represents a
// fixed data value, regardless of the user's threshold. Visibility is
// controlled by an alpha mask in a per-volume custom LUT:
//
//   normal mode:  alpha = baseAlpha if v in [lo, hi], else 0
//   invert mode:  alpha = baseAlpha if v outside [lo, hi], else 0
//
// Result: voxel at value V always renders the same color; dragging the
// slider only toggles visibility, never remaps colors.
// Reverses a 256×4 RGBA LUT so colormap index 0 becomes index 255 and vice versa.
// Used when vol.__colormapInverted is true to flip colorbar direction in the 3D view.
export function invertLut(lut) {
  const n = lut.length / 4;
  const out = new Uint8ClampedArray(lut.length);
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 4;
    out[i * 4]     = lut[src];
    out[i * 4 + 1] = lut[src + 1];
    out[i * 4 + 2] = lut[src + 2];
    out[i * 4 + 3] = lut[src + 3];
  }
  return out;
}

// Dual-threshold (mrview-style) stable-color LUT. Two independent ranges:
//   [lo, hi]              — the VISIBILITY window (alpha mask). Voxels outside
//                           it are hidden (or inside, when invert=true).
//   [colorMin, colorMax]  — the COLOUR-SCALING range (contrast). A voxel's
//                           colour = colormap position clamped to
//                           (v-colorMin)/(colorMax-colorMin); values below
//                           colorMin take the bottom colour, above colorMax the
//                           top colour.
// cal_min/cal_max stay pinned to a fixed sampled range (see below) so each
// LUT index maps to a fixed data value regardless of either range — dragging
// a slider only re-tints or re-masks, never remaps which voxel is which
// index. When colorMin/colorMax are omitted they default to that sampled
// range.
export function applyThresholdColormap(nv, vol, lo, hi, invert = false, colorMin, colorMax) {
  const baseName = vol.__origColormap || vol.colormap || "warm";
  // Invert the LUT entries when the user has toggled "Invert Color Bar", so
  // the colormap direction flips while threshold alpha-masking still applies.
  let baseLut = cmapper.colormap(baseName, false);
  if (!baseLut) return;
  if (vol.__colormapInverted) baseLut = invertLut(baseLut);

  const naturalMin = vol.__naturalCalMin ?? lo;
  const naturalMax = vol.__naturalCalMax ?? hi;

  // The LUT has a fixed 256 entries. Sampling them across the full global
  // data range wastes most of that resolution on values the visibility
  // threshold [lo, hi] hides anyway, causing visible banding when [lo, hi]
  // is a narrow window (mricrogl-style "see slight differences" use case).
  // Instead, pin the sampled range to just outside [lo, hi] so all 256 color
  // levels resolve contrast within what's actually shown. A small margin
  // keeps the LUT's clamp endpoints (index 0 / 255, where out-of-range
  // voxel values collapse to under NiiVue's cal_min/cal_max clamping)
  // outside [lo, hi], so clamped voxels still resolve to a transparent
  // entry instead of incorrectly inheriting the boundary's visible color.
  // Invert mode's visible region is the two edges outside [lo, hi] (not a
  // single sub-window), so there's no single tight range to pin to — span the
  // FULL data range. Pinning to the auto-contrast display window (naturalMin/
  // Max) instead was the item-17 bug: it's far narrower than the data for a
  // sparse map (NiiVue force-trims zeros, so cal_min lands at ~the 2nd
  // percentile of the nonzero voxels, well inside the true min). Every voxel
  // past that window then clamped onto the boundary LUT index, so the whole
  // outside-window tail flipped visible→invisible in one step the instant
  // [lo, hi] crossed naturalMin, instead of shrinking smoothly toward the true
  // data min. Sampling the true range gives each tail value its own index.
  const dataMin = vol.__trueGlobalMin ?? vol.global_min ?? naturalMin;
  const dataMax = vol.__trueGlobalMax ?? vol.global_max ?? naturalMax;
  let lutMin, lutMax;
  if (invert) {
    lutMin = dataMin;
    lutMax = dataMax;
  } else {
    const span = Math.max(hi - lo, 1e-6);
    const pad = span * 0.05;
    lutMin = lo - pad;
    lutMax = hi + pad;
  }
  if (!(lutMax > lutMin)) {
    lutMin = dataMin;
    lutMax = dataMax;
  }
  const range = lutMax - lutMin;
  if (range <= 0) return;

  // "Mask zero voxels" is the USER TOGGLE and nothing else — __maskZero is its only
  // input. Read here so every rebuild (threshold drag, invert toggle, colour-range
  // change, colormap swap) re-applies it and it's never dropped.
  //
  // Do NOT consult vol.ignoreZeroVoxels: despite the name that is not a rendering
  // flag at all. NiiVue only uses it inside calMinMax to decide whether zeros count
  // toward the cal_min/cal_max percentiles, AND it force-enables it for any volume
  // that is >60% zeros — i.e. every lesion mask and activation map. Reading it here
  // pinned the mask permanently ON and ignored the user's toggle.
  const maskZero = !!vol.__maskZero;
  // A LUT entry spans one bin of the sampled range and the entry nearest 0 sits up
  // to HALF a bin away, so the tolerance must be at least that — use a full bin.
  // (Half a bin exactly is not enough: with a tight window the nearest entry lands
  // on the boundary and floating-point rounding let value 0 stay visible.) Only the
  // one or two entries straddling 0 are affected, which are background by definition.
  const zeroEps = range / 255;

  // Colour-scaling window: default to the sampled range (== old behaviour
  // of defaulting to the full sampled span).
  const cMin = Number.isFinite(colorMin) ? colorMin : lutMin;
  const cMax = Number.isFinite(colorMax) ? colorMax : lutMax;
  const cSpan = cMax - cMin;

  const N = 256;
  const R = [], G = [], B = [], A = [], I = [];
  for (let i = 0; i < N; i++) {
    const v = lutMin + (i / (N - 1)) * range;
    // Colour position: where this data value falls within [cMin, cMax],
    // clamped so out-of-range values take the nearest colormap endpoint.
    const cf = cSpan <= 0 ? (v < cMin ? 0 : 1) : Math.max(0, Math.min(1, (v - cMin) / cSpan));
    const co = (Math.round(cf * (N - 1))) * 4;
    R.push(baseLut[co]);
    G.push(baseLut[co + 1]);
    B.push(baseLut[co + 2]);
    const inRange = v >= lo && v <= hi;
    // Visibility is governed purely by the [lo, hi] window (+ maskZero below).
    // There used to be an extra `inNaturalRange` gate against the auto-contrast
    // display window; it was removed with item 17 because that window is much
    // narrower than the data on a sparse map and silently clipped legitimate
    // tail voxels (the footer's thresholdedVolume count never applied it, so
    // the two disagreed). The LUT is now sampled across the true data range, so
    // every real voxel value is representable; background zeros — the case the
    // old gate was really guarding (e.g. value 0 on a polar-angle map) — are
    // handled by the "mask zero voxels" override just below.
    let visible = invert ? !inRange : inRange;
    // "Mask zero voxels" is a pure OVERRIDE that only ever REMOVES zeros — it can
    // never make them appear (SMALL-FIXES 48). Applied AFTER the threshold test:
    //   toggle ON  → value 0 hidden in every mode/window.
    //   toggle OFF → value 0 follows the threshold logic like any other value
    //                (e.g. visible for inside-mode over a window spanning 0).
    if (maskZero && Math.abs(v) <= zeroEps) visible = false;
    // Visibility depends ONLY on the visibility window [lo,hi] (item 43): a
    // visible voxel is fully opaque, a hidden one fully transparent. Previously
    // alpha was taken from baseLut[co+3] — the COLOUR-range-derived index — so
    // dragging the colour range could change which in-window voxels were shown
    // (any per-entry alpha variation in the colormap leaked into visibility).
    // NiiVue's per-layer opacity still applies globally on top of this.
    A.push(visible ? 255 : 0);
    I.push(i);
  }
  const key = `__thr_${vol.id || vol.name || baseName}`;
  try {
    nv.addColormap(key, { R, G, B, A, I });
    vol.colormap = key;
    // NiiVue's colormap setter re-runs its internal (border-cropped)
    // calMinMax() as a side effect, clobbering global_min/global_max back to
    // the wrong values on every threshold/color-range tick — restore the
    // true cached range fixGlobalMinMax() computed at load (cheap: no rescan).
    restoreGlobalMinMax(vol);
    // Pin cal_min/cal_max to the sampled range above (not the global range)
    // so the LUT's improved resolution actually takes effect; alpha alone
    // still decides visibility.
    vol.cal_min = lutMin;
    vol.cal_max = lutMax;
  } catch (_e) {}
}

// NiiVue colormaps that encode DISCRETE integer labels rather than continuous
// data. `random` assigns each label a distinct hue and keeps label 0
// transparent — the parcellation atlases (AAL / Harvard-Oxford / Destrieux /
// Jülich / HCP1065 / visfAtlas) all use it.
export const DISCRETE_COLORMAPS = new Set(["random"]);

// Continuous overlays get stable thresholding via applyThresholdColormap.
// Base volume and categorical label atlases keep NiiVue's native behavior.
//
// Label atlases must be excluded: they are not continuous data, and running them
// through the dual-threshold LUT broke them two ways — (1) the LUT is sampled over
// [cal_min, cal_max], so labels below NiiVue's percentile-trimmed cal_min were
// clamped out entirely (AAL's regions 1–11 vanished), and (2) since the threshold
// LUT drives alpha from the visibility window, a window that includes 0 painted the
// value-0 background opaque, flooding the brain (SMALL-FIXES 46). Rendered natively
// they get per-label hues with a transparent 0, which is exactly what's wanted.
export function isContinuousOverlay(nv, vol) {
  if (!nv || !vol) return false;
  if (vol === nv.volumes[0]) return false;
  if (vol.colormapLabel) return false;
  // __origColormap is the user-facing colormap; vol.colormap may already have been
  // swapped to a derived "__thr_*" key by a previous applyThresholdColormap call.
  const cmap = String(vol.__origColormap || vol.colormap || "").toLowerCase();
  if (DISCRETE_COLORMAPS.has(cmap)) return false;
  return true;
}

// NiiVue's own GL code (setupVolumeTextureData / renderToOutputTexture in the
// niivue bundle) silently routes uint8/int16/uint16 volumes whose header sets
// intent_code = 1002 (NIFTI_INTENT_LABEL) through a completely different
// "atlas" fragment shader — one that samples the colormap texture by the RAW
// integer voxel value, not by (v - cal_min) / (cal_max - cal_min) like every
// other shader. It does this unconditionally, based only on the NIfTI header,
// with no way for app code to opt out. applyThresholdColormap's LUT assumes
// the normalized sampling, so a label-intent overlay run through it renders
// invisible: a label like 1 lands on a LUT texel that was built to represent
// a completely unrelated data value, and typically resolves to alpha 0 (this
// is exactly what happened to a real user-supplied ROI mask that showed fine
// in MRIcroGL but not here — traced via the header dump: uint8 + intent_code
// 1002, vs. a working file that was float64 with no intent set).
const NII_INTENT_LABEL = 1002;
const NII_LABEL_ATLAS_DATATYPES = new Set([2 /* uint8 */, 4 /* int16 */, 512 /* uint16 */]);
export function isLabelIntentOverlay(vol) {
  const hdr = vol?.hdr;
  return !!hdr && hdr.intent_code === NII_INTENT_LABEL && NII_LABEL_ATLAS_DATATYPES.has(hdr.datatypeCode);
}

// Solid-color discrete LUT for a label-intent overlay (see isLabelIntentOverlay):
// every distinct nonzero integer value present gets the SAME solid color — the
// normal single-color look of a lesion/ROI mask — while 0 stays transparent.
// Built via NiiVue's own colormapLabel mechanism, which is (a) the one
// isContinuousOverlay() already treats as non-continuous, so setting it here
// routes the volume around applyThresholdColormap entirely, the same way the
// built-in/custom atlases already are, and (b) indexed by raw voxel value,
// which is exactly what the atlas shader this overlay is forced into expects
// — unlike applyThresholdColormap's LUT, this one's positions actually line up.
// Does not itself trigger a redraw — callers already re-render after loading.
export function applyLabelOverlayColor(vol, colorName = "red") {
  const img = vol?.img;
  if (!img || !img.length) return;
  const labels = new Set();
  for (let i = 0; i < img.length; i++) {
    const v = Math.round(img[i]);
    if (v !== 0) labels.add(v);
  }
  if (!labels.size) return;
  const baseLut = cmapper.colormap(colorName, false);
  const rgb = baseLut ? [baseLut[255 * 4], baseLut[255 * 4 + 1], baseLut[255 * 4 + 2]] : [255, 0, 0];
  const idxs = [0, ...labels];
  const n = idxs.length;
  vol.colormapLabel = cmapper.makeLabelLut({
    R: new Array(n).fill(rgb[0]),
    G: new Array(n).fill(rgb[1]),
    B: new Array(n).fill(rgb[2]),
    I: idxs,
  });
}

// Whether the volume actually contains any (near-)zero voxel — this is what
// the "mask zero voxels" toggle needs to be USEFUL for, not whether the data
// range straddles zero. A range-sign check (min < 0 && max > 0) wrongly hides
// the toggle for an all-non-negative map whose zeros sit at the low end of
// the range rather than mid-range (e.g. min exactly 0, never negative) —
// those zeros are just as real and just as maskable. Same tolerance as the
// existing interpolation-drift allowance used elsewhere (e.g. polar-angle
// .mgz reads land at -0.001 instead of exactly 0). Scans `vol.img` once and
// caches the result on the volume — getOverlayInfo() is called frequently
// for UI refresh and must not rescan the full array every time.
export function computeHasZeroVoxels(vol) {
  if (vol.__hasZeroVoxels !== undefined) return vol.__hasZeroVoxels;
  const img = vol?.img;
  let has = false;
  if (img && img.length) {
    for (let i = 0; i < img.length; i++) {
      if (Math.abs(img[i]) < 1e-3) { has = true; break; }
    }
  }
  vol.__hasZeroVoxels = has;
  return has;
}

// NiiVue's own global_min/global_max (set by its internal calMinMax) sample
// only the central 75% of the volume by default — a heuristic to dodge
// scanner edge artifacts on anatomical scans. Statistical/activation maps
// (e.g. a Bayes-factor or t-map) can have their true extrema anywhere in the
// volume, including that excluded 25% border, silently capping the slider's
// max below the file's real data max. Rescan the full raw array ourselves,
// cache the true range on the volume (__trueGlobalMin/Max — see
// restoreGlobalMinMax below), and correct global_min/global_max (cal_min/
// cal_max — the default display window — are left as NiiVue's
// percentile-trimmed values).
export function fixGlobalMinMax(vol) {
  if (!vol?.img || !vol?.hdr) return;
  let slope = vol.hdr.scl_slope;
  if (!slope) slope = 1;
  const inter = vol.hdr.scl_inter || 0;
  const img = vol.img;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < img.length; i++) {
    const v = img[i];
    if (Number.isNaN(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return;
  vol.__trueGlobalMin = mn * slope + inter;
  vol.__trueGlobalMax = mx * slope + inter;
  vol.global_min = vol.__trueGlobalMin;
  vol.global_max = vol.__trueGlobalMax;
}

// Assigning vol.colormap (applyThresholdColormap does this on every load AND
// every threshold/color-range/invert tick) runs through NiiVue's own
// colormap setter, which re-triggers its internal (border-cropped)
// calMinMax() and silently overwrites global_min/global_max back to the
// wrong values. Restore the cached true range instead of re-scanning the
// full volume on every slider tick.
export function restoreGlobalMinMax(vol) {
  if (vol.__trueGlobalMin === undefined) return;
  vol.global_min = vol.__trueGlobalMin;
  vol.global_max = vol.__trueGlobalMax;
}

// ── Atlas region colours + region isolation ──────────────────────────────────
//
// Both features are one mechanism: a per-volume `colormapLabel` LUT indexed by
// raw voxel value (NiiVue's makeLabelLut), the same pathway
// applyLabelOverlayColor above already uses.
//
//   * a per-region colour becomes that region's RGB entry;
//   * "isolate" sets alpha 0 on every region NOT in the allow-list.
//
// Neither touches voxel data, so both are instant and fully reversible, and
// the atlas on disk is never rewritten. Regions with no explicit colour get a
// deterministic hue from the golden-angle sequence, so the palette looks like
// NiiVue's `random` colormap but is STABLE across reloads (`random` reshuffles,
// which makes a region the user just recoloured jump to a different hue).

/** Distinct nonzero integer labels present in a volume. Cached on the volume. */
function labelsPresent(vol) {
  if (vol.__labelsPresent) return vol.__labelsPresent;
  const img = vol?.img;
  const seen = new Set();
  if (img) {
    for (let i = 0; i < img.length; i++) {
      const v = Math.round(img[i]);
      if (v !== 0) seen.add(v);
    }
  }
  vol.__labelsPresent = [...seen].sort((a, b) => a - b);
  return vol.__labelsPresent;
}

/** Deterministic, well-spread RGB for label index `n`. */
function autoColor(n) {
  const h = (n * 137.508) % 360;      // golden angle -> maximal hue separation
  const s = 0.62;
  const l = n % 2 ? 0.62 : 0.48;      // alternate lightness so neighbours differ
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return seg.map((v) => Math.round((v + m) * 255));
}

/**
 * Apply per-region colours and/or a region allow-list to a label atlas.
 *
 * @param vol        the NVImage
 * @param regions    canonical regions ([{value, name, color}]) — may be empty
 * @param only       array of label values to show, or null/empty for all
 * @returns true when a LUT was installed, false when it was cleared
 */
export function applyAtlasLabelLut(vol, regions, only) {
  if (!vol?.img) return false;
  const explicit = new Map();
  for (const r of regions || []) if (r?.color) explicit.set(Number(r.value), r.color);
  const allow = only && only.length ? new Set(only.map(Number)) : null;

  // Nothing to express — hand the volume back to its plain colormap.
  if (!explicit.size && !allow) {
    if (vol.colormapLabel) delete vol.colormapLabel;
    return false;
  }

  const present = labelsPresent(vol);
  const I = [0, ...present];
  const R = [0], G = [0], B = [0], A = [0];   // label 0 is background: transparent
  for (let i = 0; i < present.length; i++) {
    const v = present[i];
    const rgb = explicit.get(v) || autoColor(i + 1);
    R.push(rgb[0]); G.push(rgb[1]); B.push(rgb[2]);
    A.push(allow && !allow.has(v) ? 0 : 255);
  }
  vol.colormapLabel = cmapper.makeLabelLut({ R, G, B, A, I });
  return true;
}
