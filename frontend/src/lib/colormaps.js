// Colormap helpers — read niivue's colormap LUTs (Uint8ClampedArray, RGBA)
// and produce CSS linear-gradient strings, useful for slider tracks and
// custom vertical colorbars.

import { cmapper } from "@niivue/niivue";

const cache = new Map();

// Custom colormaps that NiivueViewer registers per-instance via nv.addColormap().
// niivue's global cmapper doesn't know about them, so we keep a hard-coded
// stop table here and synthesize the 256-entry LUT on first use.
const CUSTOM_STOPS = {
  // Matches polar_angle_360 in NiivueViewer.jsx (1..360 → 0..255 indices)
  polar_angle_360: [
    [0,   255,   0,   0  ],
    [45,  255, 165,   0  ],
    [90,  255, 255,   0  ],
    [135,  60, 220,  60  ],
    [180,   0,   0, 255  ],
    [225,   0, 180, 200  ],
    [270,   0, 255, 255  ],
    [315, 200, 100, 255  ],
    [360, 255,   0,   0  ],
  ],
};

function synthesizeLUT(stops) {
  const N = 256;
  const out = new Uint8ClampedArray(N * 4);
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  for (let i = 0; i < N; i++) {
    const x = lo + (i / (N - 1)) * (hi - lo);
    let s0 = 0;
    while (s0 < stops.length - 2 && stops[s0 + 1][0] < x) s0++;
    const s1 = s0 + 1;
    const f = (x - stops[s0][0]) / (stops[s1][0] - stops[s0][0]);
    const o = i * 4;
    out[o]     = Math.round(stops[s0][1] * (1 - f) + stops[s1][1] * f);
    out[o + 1] = Math.round(stops[s0][2] * (1 - f) + stops[s1][2] * f);
    out[o + 2] = Math.round(stops[s0][3] * (1 - f) + stops[s1][3] * f);
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Returns the raw 256x4 RGBA Uint8ClampedArray for a niivue colormap key.
 * Cached so repeated component renders don't hit niivue's internal lookup.
 */
export function getColormapLUT(name) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  if (CUSTOM_STOPS[name]) {
    const lut = synthesizeLUT(CUSTOM_STOPS[name]);
    cache.set(name, lut);
    return lut;
  }
  try {
    const lut = cmapper.colormap(name, false);
    cache.set(name, lut);
    return lut;
  } catch (_e) {
    return null;
  }
}

/**
 * CSS linear-gradient(...) string sampling the colormap at `steps` evenly
 * spaced stops between `frac0` and `frac1` (0..1 of the full LUT).
 * Useful for drawing a slider's "active" region inside the threshold handles.
 */
export function colormapGradient(name, opts = {}) {
  const { steps = 16, frac0 = 0, frac1 = 1, direction = "to right", invert = false } = opts;
  const lut = getColormapLUT(name);
  if (!lut) return `linear-gradient(${direction}, #444, #888)`;
  const total = Math.floor(lut.length / 4);
  const stops = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const lutT = frac0 + t * (frac1 - frac0);
    // Item 55 follow-up: mirror invertLut()'s index-reversal (out[i] =
    // lut[n-1-i]) so this gradient (LayerControlAdvanced's swatch/ramp,
    // ColorBarStack's on-canvas bar) matches the actually-rendered, possibly
    // colormap-inverted volume instead of always showing the raw LUT.
    const sampleT = invert ? 1 - lutT : lutT;
    const idx = Math.max(0, Math.min(total - 1, Math.round(sampleT * (total - 1))));
    const o = idx * 4;
    const r = lut[o], g = lut[o + 1], b = lut[o + 2];
    stops.push(`rgb(${r},${g},${b}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

/**
 * CSS gradient of the true value→colour function across the full [gMin, gMax]
 * axis, given a colour-scaling window [colorMinFrac, colorMaxFrac] (both 0..1
 * of that axis). Below colorMinFrac the ramp is flat at the colormap's bottom
 * colour; above colorMaxFrac it's flat at the top colour; in between it ramps.
 * This is exactly what the dual-threshold colour-range slider must depict.
 */
export function colormapRampGradient(name, colorMinFrac, colorMaxFrac, opts = {}) {
  const { steps = 24, direction = "to right", invert = false } = opts;
  const lut = getColormapLUT(name);
  if (!lut) return `linear-gradient(${direction}, #444, #888)`;
  const total = Math.floor(lut.length / 4);
  const lo = Math.max(0, Math.min(1, Math.min(colorMinFrac, colorMaxFrac)));
  const hi = Math.max(0, Math.min(1, Math.max(colorMinFrac, colorMaxFrac)));
  const span = hi - lo;
  const rgbAt = (t) => {
    // Same invertLut()-mirroring index reversal as colormapGradient above.
    const sampleT = invert ? 1 - t : t;
    const idx = Math.max(0, Math.min(total - 1, Math.round(sampleT * (total - 1))));
    const o = idx * 4;
    return `rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]})`;
  };
  const stops = [];
  for (let i = 0; i < steps; i++) {
    const p = i / (steps - 1);              // 0..1 across the element (data axis)
    // Map data-axis position p to a colormap position, clamped outside [lo,hi].
    const t = span <= 0 ? (p < lo ? 0 : 1) : Math.max(0, Math.min(1, (p - lo) / span));
    stops.push(`${rgbAt(t)} ${(p * 100).toFixed(1)}%`);
  }
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}

/** Returns the RGB string at a single fractional position 0..1. */
export function colormapSample(name, frac) {
  const lut = getColormapLUT(name);
  if (!lut) return "#888";
  const total = Math.floor(lut.length / 4);
  const idx = Math.max(0, Math.min(total - 1, Math.round(frac * (total - 1))));
  const o = idx * 4;
  return `rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]})`;
}
