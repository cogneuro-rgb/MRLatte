// ===== White viewer background: see-through empty space =====
//
// With the optional white background the 2D slices should sit on white, not in
// black boxes. niivue can make base-volume voxels see-through
// (opts.isAlphaClipDark: the 2D slice shader drops any voxel whose texture
// alpha is 0), but alpha 0 means "at or below the bottom of the display
// window" — on the MNI template (window 40–80) that is the ventricles and
// all CSF too, which then show as white holes in the brain.
//
// So this swaps in patched copies of niivue's "orient" shaders — the pass
// that turns raw intensities into the RGBA volume texture — where, for the
// base volume only (layer 0) and only while switched on, alpha is decided by
// RAW intensity instead: 0 at the volume's floor (its minimum plus 1 % of
// its range: the empty space round the head, air on CT), and at least 1/255
// everywhere else, so dark tissue stays drawn (black, as before). Colours are
// untouched; the 1/255 floor is invisible in the 3D render.
//
// The shader source is read back from niivue's own compiled programs
// (gl.getShaderSource), so nothing is vendored and a niivue upgrade carries
// its own shader. If the expected line is missing (niivue changed the
// shader) or compiling fails, the stock shaders stay and the slices simply
// keep their black background.
//
// niivue reads nv.orientShaderU / I / F afresh on every layer refresh
// (refreshLayers → setupVolumeTextureData), so swapping the fields is enough.
// The RGB and label-atlas variants are left alone: neither is a normal base
// scan.

import { compileShader } from "@/lib/gl/tractPrograms";

const SLOTS = ["orientShaderU", "orientShaderI", "orientShaderF"];
const ANCHOR = "\tFragColor.a *= opacity;";
const PATCH = `\tif (bgClip && layer < 0.5) {
\t\tif (f <= bgFloor) FragColor.a = 0.0;
\t\telse FragColor.a = max(FragColor.a, 1.0 / 255.0);
\t}
`;
const FLOOR_FRACTION = 0.01;

// nv -> { slot: original shader, on: bool }
const INSTALLED = new WeakMap();

function sourcesOf(gl, program) {
  let vert = null, frag = null;
  for (const sh of gl.getAttachedShaders(program) || []) {
    const src = gl.getShaderSource(sh);
    if (gl.getShaderParameter(sh, gl.SHADER_TYPE) === gl.VERTEX_SHADER) vert = src;
    else frag = src;
  }
  return { vert, frag };
}

function build(gl, original, state) {
  const { vert, frag } = sourcesOf(gl, original.program);
  if (!vert || !frag || frag.split(ANCHOR).length !== 2 || !frag.includes("uniform float opacity;")) return null;
  const patched = frag
    .replace("uniform float opacity;", "uniform float opacity;\nuniform bool bgClip;\nuniform float bgFloor;")
    .replace(ANCHOR, PATCH + ANCHOR);
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, patched);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`[sliceBackgroundShader] link error:\n${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return null;
  }
  // Same uniform names niivue resolved for the stock shader, plus ours.
  const uniforms = {};
  for (const name of [...Object.keys(original.uniforms || {}), "bgClip", "bgFloor"]) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  // Duck-typed like niivue's Shader (program, uniforms, use) — see
  // volumeRenderShader.js. use() is called before each layer's uniforms are
  // set, so it is where ours go.
  return {
    program,
    uniforms,
    use(glCtx) {
      glCtx.useProgram(this.program);
      const back = state.nv.back;
      const lo = Number(back?.global_min), hi = Number(back?.global_max);
      const on = state.on && Number.isFinite(lo) && Number.isFinite(hi);
      glCtx.uniform1i(this.uniforms.bgClip, on ? 1 : 0);
      // Read from the current base every time, so a new base needs nothing.
      glCtx.uniform1f(this.uniforms.bgFloor, on ? lo + FLOOR_FRACTION * (hi - lo) : 0);
    },
  };
}

/** Compile and install the patched shaders (idempotent). Starts switched off. */
export function installSliceBackgroundShader(nv) {
  if (INSTALLED.has(nv) || !nv?.gl) return;
  const gl = nv.gl;
  const state = { nv, on: false, originals: {} };
  for (const slot of SLOTS) {
    const original = nv[slot];
    if (!original?.program) continue;
    const ours = build(gl, original, state);
    if (!ours) {
      console.warn(`[sliceBackgroundShader] ${slot}: stock shader kept (with the white background, slices keep a black surround)`);
      continue;
    }
    state.originals[slot] = original;
    nv[slot] = ours;
  }
  INSTALLED.set(nv, state);
}

/**
 * Switch see-through empty space on (white background) or off, and rebuild the
 * volume textures so it takes effect. Does nothing (slices stay on black)
 * if the patched shaders could not be installed — clipping with the stock
 * ones would punch holes where the CSF is.
 */
export function setSliceBackgroundClip(nv, on) {
  const state = INSTALLED.get(nv);
  if (!state || !Object.keys(state.originals).length) return;
  state.on = !!on;
  nv.opts.isAlphaClipDark = state.on;
  try { nv.updateGLVolume(); } catch (_e) {}
}

/** Put niivue's own shaders back and free ours. Idempotent. */
export function uninstallSliceBackgroundShader(nv) {
  const state = INSTALLED.get(nv);
  if (!state) return;
  for (const [slot, original] of Object.entries(state.originals)) {
    const ours = nv[slot];
    nv[slot] = original;
    if (nv.gl && ours?.program && ours !== original) {
      try { nv.gl.deleteProgram(ours.program); } catch (_e) {}
    }
  }
  if (nv.opts) nv.opts.isAlphaClipDark = false;
  INSTALLED.delete(nv);
}
