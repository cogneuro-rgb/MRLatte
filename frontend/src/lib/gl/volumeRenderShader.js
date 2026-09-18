// ===== Custom 3D volume raycast render shader installer =====
//
// Takes ownership of nv.renderShader (a plain public property niivue itself
// reassigns in 8 places — see node_modules/@niivue/niivue/src/niivue/index.ts)
// by compiling our own copy of the base render shader (frontend/src/lib/gl/
// volumeShaders.js — vendored from niivue's shader-srcs.ts with two GLSL
// patches: an extra overlayClipExempt sampler and an overlayOcclusion term)
// and assigning it everywhere niivue's own selection logic could possibly
// read from: all four variant slots plus the live `renderShader` field.
//
// Why all four slots: only three call sites reassign nv.renderShader after
// niivue's own constructor first sets it up — setVolumeRenderIllumination(),
// setGradientOpacity(), and loadDocument(). Each picks from
// renderVolumeShader / renderGradientShader / renderSliceShader /
// renderGradientValuesShader depending on the current gradientAmount/opts.
// This app calls none of the illumination/gradient APIs (gradientAmount,
// gradientOpacity, renderSilhouette are always 0 — grepped, zero call
// sites), so the active variant is always the base renderVolumeShader — but
// every slot still gets our shader so a future gradientAmount/illumination
// change can only ever re-select OUR shader, never silently fall back to
// stock (verified against setVolumeRenderIllumination(0)'s own logic: with
// gradientAmount 0 it just does `this.renderShader = this.renderVolumeShader`,
// which is already ours). Only the base variant is actually vendored — see
// the header comment on RENDER_FRAG in volumeShaders.js; enabling
// illumination later would render through our non-gradient shader (losing
// illumination, not correctness) since this app never turns it on.
//
// Reuses compileShader() from tractPrograms.js — the same compile-and-log
// helper already used for the tract pipeline — rather than duplicating it.

import { compileShader } from "@/lib/gl/tractPrograms";
import { RENDER_VERT, RENDER_FRAG } from "@/lib/gl/volumeShaders";

// nv -> the four original shader references, so uninstall can put them back.
const INSTALLED = new WeakMap();

// Mirrors niivue's own Shader constructor (src/shader.ts): populate
// `uniforms` from every `uniform ... name;` declaration in either shader
// source, using the SAME regex niivue uses. That regex captures only the
// LAST identifier per declaration line (e.g. `uniform sampler3D volume,
// overlay;` only registers `overlay`) — volumeShaders.js already declares
// our two new samplers on their own lines for exactly this reason.
function buildUniforms(gl, program, vertSrc, fragSrc) {
  const regexUniform = /uniform[^;]+[ ](\w+);/g;
  const uniforms = {};
  for (const src of [vertSrc, fragSrc]) {
    regexUniform.lastIndex = 0;
    let m;
    while ((m = regexUniform.exec(src)) !== null) {
      uniforms[m[1]] = null;
    }
  }
  for (const name in uniforms) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  // niivue's ShaderManager.initRenderShader does this exact fixup for the
  // stock shader (see shader-manager.ts:244) because
  // `clipPlanes[MAX_CLIP_PLANES]` never matches the regex above at all — the
  // array-subscript syntax breaks the required "<space>\w+;" tail match, so
  // the whole declaration line is skipped by the regex entirely. Without
  // this, uniforms.clipPlanes is null and every
  // gl.uniform4fv(shader.uniforms.clipPlanes, ...) call in
  // VolumeRenderer.drawImage3D silently no-ops (WebGL spec: uniform calls on
  // a null location are ignored, not an error) — 3D clipping stops working
  // with nothing printed anywhere. nv.initRenderShader() below redoes this
  // same assignment on niivue's own copy of `shader`, but we set it here too
  // so `uniforms.clipPlanes` is correct even if that call is ever skipped.
  uniforms.clipPlanes = gl.getUniformLocation(program, "clipPlanes[0]");
  return uniforms;
}

function linkProgram(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`[volumeRenderShader] program link error:\n${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * Compiles our vendored render shader and installs it into every slot
 * niivue's own shader-selection logic can read from. Idempotent (safe to
 * call twice / across HMR remounts). If compilation or linking fails, logs
 * the error and leaves the stock niivue shader in place rather than
 * producing a black 3D render.
 */
export function installCustomRenderShader(nv) {
  if (INSTALLED.has(nv)) return;
  const gl = nv.gl;
  if (!gl) return;

  const vs = compileShader(gl, gl.VERTEX_SHADER, RENDER_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, RENDER_FRAG);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    console.error("[volumeRenderShader] falling back to stock niivue render shader — see compile errors above");
    return;
  }

  const program = linkProgram(gl, vs, fs);
  if (!program) return;

  const uniforms = buildUniforms(gl, program, RENDER_VERT, RENDER_FRAG);
  // Duck-typed to match niivue's (unexported) Shader class — program,
  // uniforms, use(gl) is its entire public surface, and nothing in niivue
  // does `instanceof Shader` (grepped).
  const shader = {
    program,
    uniforms,
    use(glCtx) {
      glCtx.useProgram(this.program);
    },
  };

  const original = {
    renderShader: nv.renderShader,
    renderVolumeShader: nv.renderVolumeShader,
    renderGradientShader: nv.renderGradientShader,
    renderSliceShader: nv.renderSliceShader,
    renderGradientValuesShader: nv.renderGradientValuesShader,
  };

  nv.renderShader = shader;
  nv.renderVolumeShader = shader;
  nv.renderGradientShader = shader;
  nv.renderSliceShader = shader;
  nv.renderGradientValuesShader = shader;

  // Public API (niivue/index.ts:6378). Resolves the fixed texture-unit
  // uniforms (volume=0, colormap=1, overlay=2, drawing=7, paqd=8),
  // gradientAmount, silhouettePower, the gradientOpacity LUT, and redoes the
  // uniforms.clipPlanes fixup buildUniforms() above already applied
  // (harmless — niivue's version reads shader.program directly, same
  // result).
  nv.initRenderShader(shader, nv.opts.gradientAmount);

  // Our extra sampler. Texture unit 9 is free: niivue's private
  // bindTextures() (called every drawSceneCore()) only touches units
  // 0,1,2,3,5,6,8; unit 7 (drawing) and unit 9 (orientation cube) are bound
  // elsewhere and don't rotate every frame. The orientation cube is drawn
  // AFTER the volume raycast within the same draw3D() call (draw3D calls
  // drawImage3D() first, drawOrientationCube() last), so it can only ever
  // clobber unit 9 for the FOLLOWING draw — which is exactly why
  // volumeClip.js's drawScene wrapper rebinds our clip-mask texture to unit
  // 9 on every single drawScene() call rather than once here. This
  // gl.uniform1i only needs to run once, same as volume/overlay/colormap
  // above — only the actual texture BOUND to unit 9 changes per frame.
  shader.use(gl);
  gl.uniform1i(shader.uniforms.overlayClipExempt, 9);

  nv.updateGLVolume();
  nv.drawScene();

  INSTALLED.set(nv, original);
}

/**
 * Restores whatever nv.renderShader and the three other variant slots
 * pointed to before installCustomRenderShader() ran, and deletes our
 * compiled program. Idempotent; safe to call on an nv that was never
 * installed (e.g. shader compilation failed) or twice (HMR/StrictMode).
 */
export function uninstallCustomRenderShader(nv) {
  const original = INSTALLED.get(nv);
  if (!original) return;
  const gl = nv.gl;
  const ours = nv.renderShader;
  nv.renderShader = original.renderShader;
  nv.renderVolumeShader = original.renderVolumeShader;
  nv.renderGradientShader = original.renderGradientShader;
  nv.renderSliceShader = original.renderSliceShader;
  nv.renderGradientValuesShader = original.renderGradientValuesShader;
  if (gl && ours && ours.program) {
    try { gl.deleteProgram(ours.program); } catch (_e) {}
  }
  INSTALLED.delete(nv);
}
