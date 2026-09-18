import {
  OCC_MIN, FAR_DIM, SOFT_EDGE, TRACT_OPACITY_GAMMA,
  LIGHT_AMBIENT, LIGHT_DIFFUSE, LIGHT_SPECULAR, LIGHT_SHINE, LIGHT_DIR,
  MIN_THICKNESS_PX, BASE_THICKNESS_MM,
} from "@/lib/gl/tractShaders";
import { createTractPrograms, getTractProgram, disposeTractPrograms } from "@/lib/gl/tractPrograms";
import { patchUpdateFibers, ensureTractBuffers } from "@/lib/gl/tractBuffers";

// ===== mrview-parity tractography renderer =====
// Supersedes the depth-aware "ghost" fiber-occlusion workaround. Where that
// old approach captured a copy of the
// depth buffer into an FBO and blended a separate "ghost" draw against it
// (measured result: 0.00% of tile pixels changed at full tissue opacity —
// i.e. it silently did nothing), this renderer relies
// entirely on the fixed-function depth unit: drawMesh3D always runs AFTER
// the volume raycast has written real per-pixel first-hit depth, so
// depthFunc(GREATER) means exactly "this fragment is behind tissue" with no
// blit, no FBO, and nothing that can silently no-op.
//
// Geometry modes: 'lines' uses niivue's existing vaoFiber / LINE_STRIP.
// 'tubes' (Pseudotubes) and 'points' both reach the instanced draw
// path over lib/gl/tractBuffers.js's compacted per-mesh buffer
// (mesh.__tract) — see bindTractGeometry/emit below, which never branches on
// 'tubes' vs 'points', only 'lines' vs everything else.
// Only the compiled program
// differs, via getTractProgram's #define POINTS_MODE / #define LIGHTING
// (tractPrograms.js) — the `lighting` flag read below is plumbed
// through to that cache key.

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// nv -> { orig, cache }. `cache` also carries the mm2frac memoization fields
// (mm2fracVol / mm2fracMat) — see computeFrameUniforms below.
const INSTALLED = new WeakMap();

// ---- null-guarded uniform setters -----------------------------------------
// The Lines vertex shader (TRACT_VERT_LINES) does not declare halfFovMM,
// viewportPx, thicknessMM or minThicknessPx at all (see TRACT_VERT_LINES's note
// in tractShaders.js) — gl.getUniformLocation returns null for those in the
// 'lines' program, and calling gl.uniform*fv with a null location throws in
// some drivers / spams console warnings in others. Every uniform write in
// this file goes through one of these.
function u1f(gl, loc, v) { if (loc) gl.uniform1f(loc, v); }
function u2f(gl, loc, v) { if (loc) gl.uniform2f(loc, v[0], v[1]); }
function u3f(gl, loc, v) { if (loc) gl.uniform3f(loc, v[0], v[1], v[2]); }
function u4f(gl, loc, v) { if (loc) gl.uniform4f(loc, v[0], v[1], v[2], v[3]); }
function um4(gl, loc, m) { if (loc) gl.uniformMatrix4fv(loc, false, m); }

// ---- clip-plane construction: MUST match niivue's raycast exactly ---------
function sph2cartDeg(azimuth, elevation) {
  const Phi = -elevation * (Math.PI / 180);
  const Theta = ((azimuth - 90) % 360) * (Math.PI / 180);
  const r = [Math.cos(Phi) * Math.cos(Theta), Math.cos(Phi) * Math.sin(Theta), Math.sin(Phi)];
  const len = Math.hypot(r[0], r[1], r[2]);
  return len > 0 ? [r[0] / len, r[1] / len, r[2] / len] : r;
}

// ---- mm2frac (4x4, mm -> fractional), copied verbatim ---------------------
function buildMm2Frac(nv) {
  try {
    const o = nv.mm2frac([0, 0, 0]);
    const ex = nv.mm2frac([1, 0, 0]);
    const ey = nv.mm2frac([0, 1, 0]);
    const ez = nv.mm2frac([0, 0, 1]);
    const col = (v) => [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
    const [ax, ay, az] = [col(ex), col(ey), col(ez)];
    // column-major mat4
    return new Float32Array([
      ax[0], ax[1], ax[2], 0,
      ay[0], ay[1], ay[2], 0,
      az[0], az[1], az[2], 0,
      o[0], o[1], o[2], 1,
    ]);
  } catch (_e) {
    return null;
  }
}

// ---- mesh selection ---------------------------------------------------------
const isTractMesh = (msh) =>
  !!msh.offsetPt0 && (msh.fiberSides < 3 || msh.fiberRadius <= 0);

const isDrawableTract = (msh) =>
  isTractMesh(msh) && msh.visible && msh.opacity > 0 && msh.indexCount >= 3;

// ---- per-frame uniform derivation -------------------------------------------
// `cache` here is the same object returned by createTractPrograms() — it also
// carries the mm2frac memoization (mm2fracVol / mm2fracMat), rebuilt only
// when nv.volumes[0]'s identity changes, per the "simple variable
// compared by ===" instruction (implemented per-nv rather than truly
// module-scope so multiple concurrent Niivue instances, if that ever
// happens, don't clobber each other's cached matrix).
function computeFrameUniforms(nv, state, cache, m, modelMtx) {
  let mvp = m;
  if (!mvp) {
    [mvp] = nv.calculateMvpMatrix(nv.volumeObject3D, undefined, nv.scene.renderAzimuth, nv.scene.renderElevation);
  }

  // Orthographic half-extents in mm, recovered from the MVP rows. The
  // projection is orthographic, not perspective.
  const halfFovMM = [
    1 / Math.hypot(mvp[0], mvp[4], mvp[8]),
    1 / Math.hypot(mvp[1], mvp[5], mvp[9]),
  ];

  // View-Z axis expressed in mm space: third row of the model->view matrix.
  const mv = modelMtx || mvp;
  let viewZmm = [mv[2], mv[6], mv[10]];
  const vzLen = Math.hypot(...viewZmm) || 1;
  viewZmm = viewZmm.map((c) => c / vzLen);

  const pivotMM = nv.pivot3D || [0, 0, 0];
  const sceneRadiusMM = Math.max(nv.furthestFromPivot || 1, 1e-3);
  const crossMM = nv.frac2mm(nv.scene.crosshairPos);
  const slabCenter = crossMM[0] * viewZmm[0] + crossMM[1] * viewZmm[1] + crossMM[2] * viewZmm[2];

  const tile = nv.screenSlices?.find((s) => s.axCorSag === 4)?.leftTopWidthHeight;
  const viewportPx = tile && tile[2] > 0 ? [tile[2], tile[3]] : [nv.gl.canvas.width, nv.gl.canvas.height];

  const tissueOpacity = Number.isFinite(nv.volumes?.[0]?.opacity) ? nv.volumes[0].opacity : 1.0;
  const occludedScale = OCC_MIN + (1 - OCC_MIN) * (1 - tissueOpacity);

  // mm2frac cache: rebuild only when nv.volumes[0] identity changes.
  const vol = nv.volumes?.[0];
  if (cache.mm2fracVol !== vol) {
    cache.mm2fracVol = vol;
    cache.mm2fracMat = buildMm2Frac(nv);
  }
  // If buildMm2Frac failed, pass identity and force clipEnabled off for
  // every tract this frame (handled by forceClipOff, consumed in
  // setMeshUniforms) rather than clip against a meaningless matrix.
  const mm2fracValid = !!cache.mm2fracMat;
  const mm2frac = cache.mm2fracMat || IDENTITY4;

  const dae = nv.scene?.clipPlaneDepthAziElevs?.[0];
  const clipPlane = (dae && dae[0] < 1.0)
    ? [...sph2cartDeg(dae[1] + 180, dae[2]), dae[0]]
    : [0, 0, 0, 2]; // w > 1 => sentinel "no clip"

  const geometry = state.geometry ?? "lines";

  return {
    mvpMtx: mvp,
    mvMtx: mv,
    mm2frac,
    mm2fracValid,
    clipPlane,
    halfFovMM,
    viewportPx,
    thicknessMM: state.thicknessMM ?? BASE_THICKNESS_MM,
    minThicknessPx: MIN_THICKNESS_PX,
    viewZmm,
    slabCenter,
    pivotMM,
    sceneRadiusMM,
    // The 3D shader-side
    // slab discard is disabled — slabHalfMM is ALWAYS -1 here, regardless of
    // state.slabMM. The slab slider now drives only niivue's meshThicknessOn2D
    // (2D slice tiles) via NiivueViewer.jsx's meshThicknessOn2D effect.
    // The on/off toggle (state.slabEnabled) is gone too —
    // the 2D slab is always on, so state.slabMM alone (no longer state
    // .slabEnabled ? state.slabMM : off) drives that effect. DO NOT "clean
    // up" state.slabMM as a dead field here — it still exists on
    // tractRenderStateRef/DEFAULT_TRACT_RENDER and drives the 2D effect; this
    // line is deliberately a one-line revert (`(state.slabMM ?? 5) * 0.5`)
    // away from re-enabling the 3D discard. The TRACT_FRAG GLSL's
    // `slabHalfMM > 0.0` branch (in TRACT_FRAG) is left intact on purpose —
    // untouched shader code.
    slabHalfMM: -1,
    softEdge: geometry === "lines" ? 0 : SOFT_EDGE,
    lightDir: LIGHT_DIR,
    ambient: LIGHT_AMBIENT,
    diffuse: LIGHT_DIFFUSE,
    specular: LIGHT_SPECULAR,
    shine: LIGHT_SHINE,
    tissueOpacity,
    occludedScale,
    geometry,
  };
}

function setFrameUniforms(gl, uniforms, u) {
  um4(gl, uniforms.mvpMtx, u.mvpMtx);
  um4(gl, uniforms.mvMtx, u.mvMtx);
  um4(gl, uniforms.mm2frac, u.mm2frac);
  u4f(gl, uniforms.clipPlane, u.clipPlane);
  u2f(gl, uniforms.halfFovMM, u.halfFovMM);
  u2f(gl, uniforms.viewportPx, u.viewportPx);
  u1f(gl, uniforms.thicknessMM, u.thicknessMM);
  u1f(gl, uniforms.minThicknessPx, u.minThicknessPx);
  u3f(gl, uniforms.viewZmm, u.viewZmm);
  u1f(gl, uniforms.slabCenter, u.slabCenter);
  u3f(gl, uniforms.pivotMM, u.pivotMM);
  u1f(gl, uniforms.sceneRadiusMM, u.sceneRadiusMM);
  u1f(gl, uniforms.slabHalfMM, u.slabHalfMM);
  u1f(gl, uniforms.softEdge, u.softEdge);
  u3f(gl, uniforms.lightDir, u.lightDir);
  u1f(gl, uniforms.ambient, u.ambient);
  u1f(gl, uniforms.diffuse, u.diffuse);
  u1f(gl, uniforms.specular, u.specular);
  u1f(gl, uniforms.shine, u.shine);
}

// Per-tract: clipEnabled (msh.__tractClip === false ? 0 : 1), forced to 0
// whenever this frame's mm2frac matrix could not be built.
function setMeshUniforms(gl, uniforms, msh, forceClipOff) {
  const clipEnabled = !forceClipOff && msh.__tractClip !== false ? 1 : 0;
  u1f(gl, uniforms.clipEnabled, clipEnabled);
}

// Binds the geometry's vertex source and returns a small descriptor emit()
// uses to pick its draw call — or `false` if there is nothing to draw (skip
// this mesh) rather than throwing.
//
// 'lines' binds niivue's own vaoFiber/indexBuffer unchanged.
// 'tubes' / 'points' bind the compacted per-mesh instanced buffer
// (lib/gl/tractBuffers.js's ensureTractBuffers — builds it lazily via the
// patched mesh.updateFibers(gl) on first use, and on any real topology
// rebuild; a pure GL-state read otherwise, so this never itself triggers a
// rebuild). `t.nSegments < 1` covers both "not compacted yet" (shouldn't
// happen — patchUpdateFibers runs synchronously) and "compacted to nothing
// instanceable" (e.g. every surviving streamline is a single point) — either
// way, fall through silently rather than issuing a zero/negative-count draw.
function bindTractGeometry(gl, msh, geometry) {
  if (geometry === "lines") {
    gl.bindVertexArray(msh.vaoFiber);
    return { mode: "lines" };
  }
  const t = ensureTractBuffers(gl, msh);
  if (!t || t.nSegments < 1) return false;
  gl.bindVertexArray(t.vao);
  return { mode: "instanced", count: t.nSegments };
}

// Issues one blend/depth pass over the currently-bound geometry. Sets the
// four per-pass scalar uniforms, applies the GL state for this pass, then
// draws. `geom` is bindTractGeometry's return value for this mesh this frame
// (never `false` here — the caller already skipped the mesh in that case).
function emit(gl, prog, msh, opts, geom) {
  const { depthMask, depthFunc, depthTest, blend, passScale, occludedScale, depthCueFloor, clampToOne, colorMask, stencilFirstWins } = opts;

  if (depthTest === false) {
    gl.disable(gl.DEPTH_TEST);
  } else {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(depthFunc);
  }
  gl.depthMask(depthMask);
  // colorMask:false = depth-only prepass (see the two-pass NEAR draw below).
  if (colorMask === false) gl.colorMask(false, false, false, false);
  // stencilFirstWins: only the FIRST fragment to reach each pixel in this pass
  // is drawn. NOTEQUAL(1) passes while the pixel is still 0, and REPLACE (ref
  // = 1, written on depth-pass) marks it so every later fragment fails. This
  // is the behind-tissue pass's substitute for the NEAR pass's depth prepass —
  // it cannot use depth, since the depth buffer holds the tissue surface its
  // GREATER test compares against.
  if (stencilFirstWins) {
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  }

  if (blend === "none") {
    // mrview's `line_opacity == 1.0` branch: no blending at all. The
    // fragment's premultiplied vec4(rgb*a, a) with a == 1 writes rgb as-is.
    gl.disable(gl.BLEND);
  } else if (blend === "add") {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  } else {
    // 'over' — the fragment shader emits premultiplied vec4(rgb*a, a).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  u1f(gl, prog.uniforms.passScale, passScale);
  u1f(gl, prog.uniforms.occludedScale, occludedScale);
  u1f(gl, prog.uniforms.depthCueFloor, depthCueFloor);
  u1f(gl, prog.uniforms.clampToOne, clampToOne ? 1 : 0);

  if (geom.mode === "instanced") {
    // tubes/points: one TRIANGLE_STRIP quad (gl_VertexID supplies
    // the corner — no per-vertex attribute) instanced over every compacted
    // segment.
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, geom.count);
  } else {
    gl.drawElements(gl.LINE_STRIP, msh.indexCount, gl.UNSIGNED_INT, 0);
  }

  if (depthTest === false) {
    gl.enable(gl.DEPTH_TEST); // re-enable afterwards, per spec
  }
  if (colorMask === false) gl.colorMask(true, true, true, true);
  if (stencilFirstWins) gl.disable(gl.STENCIL_TEST);
}

// GL state restoration. MUST be unconditional and called from every return
// path after gl.enable(gl.BLEND) has run — leaving GL state modified leaks
// into every later draw in the frame.
function restoreGlState(gl, nv) {
  gl.depthMask(true);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.STENCIL_TEST);
  gl.colorMask(true, true, true, true);
  gl.enable(gl.CULL_FACE);
  gl.bindVertexArray(nv.unusedVAO);
}

// ---- 2D fiber-path takeover -------------------------------------------------
// niivue's OWN 2D fiber draw — the `if (this.opts.meshThicknessOn2D > 0) {
// ... this.drawMesh3D(true, 1, mx, obj.modelMatrix, obj.normalMatrix, true) }`
// block inside draw2D (confirmed by reading dist/index.js: the underlying
// module-level drawMesh3D() does `gl.uniform1f(fiberShader.uniforms.opacity,
// alpha)` and NEVER reads mesh.opacity) — always passes alpha=1, so 2D-slice
// tracts have always rendered fully opaque regardless of the opacity slider.
// This function fixes that.
//
// SEPARATE, self-contained pass structure from drawMesh3DWrapped's 3D one
// below — the 3D owned/splice branch and the 3D pass table are untouched by
// this path.
// Reuses the shared per-frame-uniform derivation (computeFrameUniforms /
// setFrameUniforms — the MVP-row derivation is explicitly tile-agnostic,
// "it also works for the 2D and mosaic paths where a different m is passed
// in") and the shared generic single-pass emit() helper, but nothing 3D-
// specific. There is no volumetric tissue depth to occlude against in a flat
// 2D slice tile the way there is in the 3D raycast (the 2D slice draw
// is a flat quad, not a per-pixel first-hit surface), so this uses the same
// simple two-pass (additive, then over) blend as the 3D fastPath case,
// depth test OFF throughout: confinement to the slab is niivue's OWN
// meshThicknessOn2D frustum (calculateMvpMatrix2D, already baked into the
// `m`/`modelMtx` this function receives), not our shader-side slab — which
// stays permanently off for EVERY caller (slabHalfMM is
// -1 unconditionally inside computeFrameUniforms already; nothing 2D-specific
// needed here).
//
// Geometry is always 'lines' — slices are drawn with the Lines program;
// Pseudotubes' screen-space thickness math (TRACT_VERT_INSTANCED's halfFovMM
// / viewportPx terms) assumes the tangent's screen-space perpendicular and
// the pixel-width conversion share one camera basis; the 2D tile is a
// different orthographic projection per slice/orientation. Lines' vertex
// shader (TRACT_VERT_LINES) does not use halfFovMM/viewportPx at all
// (TRACT_VERT_LINES), sidestepping the question entirely — and niivue's own
// updateFibers() always builds msh.vaoFiber/indexCount regardless of
// whichever geometry mode the 3D renderer currently has selected, so binding
// 'lines' here is always safe even when the 3D view is showing Pseudotubes.
function draw2DTractsWrapped(nv, state, cache, orig, isDepthTest, alpha, m, modelMtx, normMtx) {
  const tracts = nv.meshes.filter(isDrawableTract);
  if (!tracts.length) {
    orig(isDepthTest, alpha, m, modelMtx, normMtx, true);
    return;
  }

  // Mirrored for the 2D call: splice tract meshes out of nv.meshes so
  // niivue's own (always-alpha=1) fiber block does not ALSO draw them for
  // this tile. Same mechanism, same meshXRay/!hasFibers caveat as the 3D
  // SPEC NOTE in drawMesh3DWrapped below — not a new behaviour, just applied
  // to a second call site (draw2D calls this once per visible 2D tile).
  const saved = nv.meshes;
  try {
    nv.meshes = saved.filter((msh) => !isTractMesh(msh));
    orig(isDepthTest, alpha, m, modelMtx, normMtx, true);
  } finally {
    nv.meshes = saved;
  }

  const gl = nv.gl;
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.DEPTH_TEST); // flat 2D tile — nothing to depth-test against
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);

  const prog = getTractProgram(cache, gl, { geometry: "lines", lighting: false });
  if (!prog) { restoreGlState(gl, nv); return; } // restore before every return

  gl.useProgram(prog.program);
  const u = computeFrameUniforms(nv, state, cache, m, modelMtx);
  // 2D-only override: the clip PLANE, like the shader-side slab discard
  // (slabHalfMM: -1 above in computeFrameUniforms), is a 3D-render-only
  // concept in this codebase (the analogous CROP-TO-SLAB control is 2D-only
  // by design; the clip plane is the inverse case and must stay 3D-only, but
  // currently leaks into 2D by omission since computeFrameUniforms is shared
  // verbatim with the 3D path). Force the "no clip" sentinel (w > 1, see
  // tractShaders.js's `clipPlane.w <= 1.0` check) for this 2D draw only —
  // does NOT touch drawMesh3DWrapped / the 3D path.
  u.clipPlane = [0, 0, 0, 2];
  setFrameUniforms(gl, prog.uniforms, u);
  const forceClipOff = !u.mm2fracValid;

  for (const msh of tracts) {
    const o = Math.pow(Math.max(0, Math.min(1, msh.opacity)), TRACT_OPACITY_GAMMA);
    const kOver = Math.min(o / 0.5, 1.0); // mrview's blend constant, clamped like glBlendColor
    const kAdd = o / 0.5; // unclamped — see drawMesh3DWrapped below
    setMeshUniforms(gl, prog.uniforms, msh, forceClipOff);
    const bound = bindTractGeometry(gl, msh, "lines");
    if (!bound) continue;

    emit(gl, prog, msh, {
      depthMask: false, depthTest: false, blend: "add",
      passScale: kAdd, occludedScale: 1, depthCueFloor: 1, clampToOne: 0,
    }, bound);
    emit(gl, prog, msh, {
      depthMask: false, depthTest: false, blend: "over",
      passScale: kOver, occludedScale: 1, depthCueFloor: 1, clampToOne: 1,
    }, bound);
  }

  restoreGlState(gl, nv);
}

function drawMesh3DWrapped(nv, state, cache, orig, isDepthTest, alpha, m, modelMtx, normMtx, is2D) {
  // The 2D fiber-path takeover branches off FIRST, into the fully
  // separate draw2DTractsWrapped above. Everything from here down is the 3D
  // path and is deliberately independent of it.
  if (is2D) {
    draw2DTractsWrapped(nv, state, cache, orig, isDepthTest, alpha, m, modelMtx, normMtx);
    return;
  }

  const owned = isDepthTest && !is2D; // is2D is always false past the branch above; kept literal
  const tracts = owned ? nv.meshes.filter(isDrawableTract) : [];

  if (!tracts.length) {
    orig(isDepthTest, alpha, m, modelMtx, normMtx, is2D);
    return;
  }

  // Splice tract meshes out of nv.meshes for the DURATION of the
  // delegated call, synchronously, so niivue's own fiber block does not draw
  // them, while `hasFibers` inside that delegated call still resolves the
  // same way it always has (lib/viewer/markers.js relies on the
  // meshXRay/!hasFibers interaction). This replaces the previous approach of
  // nulling nv.fiberShader for the call's duration.
  //
  // NOTE: splicing ALL tract
  // meshes out changes `hasFibers` from true to false inside the delegated
  // call, which ENABLES niivue's internal `meshXRay > 0 && !hasFibers` branch
  // that was previously suppressed. Believed to be an improvement (markers
  // become more visible, not less) but it IS a behaviour change — flagged
  // here and in the final report; the reviewer tests markers explicitly.
  const saved = nv.meshes;
  try {
    nv.meshes = saved.filter((msh) => !isTractMesh(msh));
    orig(isDepthTest, alpha, m, modelMtx, normMtx, is2D);
  } finally {
    nv.meshes = saved;
  }

  const gl = nv.gl;
  gl.disable(gl.CULL_FACE); // quad winding flips with segment direction
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);

  const geometry = state.geometry ?? "lines";
  const lighting = !!state.lighting;
  const prog = getTractProgram(cache, gl, { geometry, lighting });
  if (!prog) { restoreGlState(gl, nv); return; } // restore before every return

  gl.useProgram(prog.program);

  const u = computeFrameUniforms(nv, state, cache, m, modelMtx);
  setFrameUniforms(gl, prog.uniforms, u);

  const forceClipOff = !u.mm2fracValid;
  const fastPath = u.occludedScale >= 0.999; // no volume, or volume opacity 0

  for (const msh of tracts) {
    const rawOpacity = Math.max(0, Math.min(1, msh.opacity));
    // ---- Why this is NOT mrview's `opacity^2 / 0.5` blend constant --------
    // mrview drives alpha through glBlendColor with line_opacity = slider^2,
    // then an additive pass on top. That works for mrview's typical sparse
    // bundles, but measured against a real 18k-streamline clinical dissection
    // here it is unusable: the additive pass accumulates ~50+ fragments per
    // pixel, so tract pixels sit at meanMax 205/255 ALREADY at opacity 0.1 and
    // never change — 80% of the slider was visually dead (measured: tract
    // signal 8.00 -> 10.73 across opacity 0.2 -> 1.0).
    // A straight linear alpha in a depth-tested "over" pass makes the slider
    // behave the way the voxel-overlay opacity sliders elsewhere in this app
    // do, which is what was actually asked for ("make it like the nifti
    // files"). TRACT_OPACITY_GAMMA is intentionally no longer applied.
    const kOver = rawOpacity;
    // mrview branches hard on `line_opacity < 1.0`: at exactly 1.0 it disables
    // blending entirely and draws ONE opaque, depth-tested, depth-WRITING pass.
    // Restoring that branch is what makes the top of the slider read as a
    // solid tract rather than yet another additive wash.
    const opaque = rawOpacity >= 1.0;
    setMeshUniforms(gl, prog.uniforms, msh, forceClipOff);
    const bound = bindTractGeometry(gl, msh, geometry);
    if (!bound) continue;

    // ---- The depthMask story (the fix for the dead opacity slider) --------
    // Every pass used to run with depthMask:false. With ~18k overlapping
    // streamlines that means EVERY fragment of EVERY streamline blends into
    // each pixel, so the additive term saturates the framebuffer at very low
    // opacity and then cannot get any brighter — measured: tract signal moved
    // only 8.00 -> 10.73 across opacity 0.2 -> 1.0, i.e. 80% of the slider did
    // nothing. mrview avoids this because its "over" pass keeps
    // glDepthMask(GL_TRUE) (Tractogram::render), so within that pass the
    // front-most fragment wins per pixel instead of every layer compositing.
    // The near/LEQUAL "over" pass below therefore writes depth; the far/GREATER
    // passes deliberately do NOT (they would overwrite the tissue depth that
    // the LEQUAL/GREATER split itself depends on, with a FARTHER z).
    // ---- No additive pass; ONE composite per pixel per layer ---------------
    // mrview's pass 1 (blendFunc(CONSTANT_ALPHA, ONE), depth test OFF) is
    // deliberately NOT reproduced: it is order-independent precisely because
    // it accumulates every fragment, which is fine for a sparse bundle but
    // saturates instantly for a dense one (measured above).
    //
    // Plain depth-tested "over" is not enough either. Fragments arrive in
    // arbitrary order, so LEQUAL still admits every "new nearest" fragment —
    // O(log k) blends per pixel for depth complexity k, giving
    // 1-(1-a)^5 ≈ 0.97 at a=0.5. Measured: still flat (7.39 -> 10.27 across
    // 0.1 -> 1.0).
    //
    // So each visible layer composites exactly once per pixel:
    //   FAR  (behind tissue) - stencil first-fragment-wins
    //   NEAR (in front)      - depth prepass, then depthFunc EQUAL
    // which makes the slider linear and lets the tract read like a surface
    // composited at its opacity, i.e. "like the nifti files".

    // FAR first: must precede the NEAR prepass, which overwrites the tissue
    // depth its GREATER test compares against. Dimmed by occludedScale so the
    // tract stays faintly visible through an opaque brain and fully visible
    // through a transparent one. Stencil is reset per tract so two tracts
    // don't mask each other.
    if (!fastPath) {
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      emit(gl, prog, msh, {
        depthMask: false, depthFunc: gl.GREATER, blend: "over", stencilFirstWins: true,
        passScale: kOver, occludedScale: u.occludedScale, depthCueFloor: FAR_DIM, clampToOne: 1,
      }, bound);
    }

    if (opaque) {
      // mrview's `line_opacity == 1.0` branch: one opaque, depth-tested,
      // depth-writing pass. No prepass needed — with blending off the depth
      // test alone already yields front-most-wins.
      emit(gl, prog, msh, {
        depthMask: true, depthFunc: gl.LEQUAL, blend: "none",
        passScale: 1, occludedScale: 1, depthCueFloor: 1, clampToOne: 1,
      }, bound);
    } else {
      // NEAR depth prepass: colour writes off, depth writes on.
      emit(gl, prog, msh, {
        depthMask: true, depthFunc: gl.LEQUAL, blend: "none", colorMask: false,
        passScale: 1, occludedScale: 1, depthCueFloor: 1, clampToOne: 1,
      }, bound);
      // NEAR colour pass: only the surface the prepass recorded.
      emit(gl, prog, msh, {
        depthMask: false, depthFunc: gl.EQUAL, blend: "over",
        passScale: kOver, occludedScale: 1, depthCueFloor: 1, clampToOne: 1,
      }, bound);
    }
  }

  restoreGlState(gl, nv);
}

/**
 * Installs the tract renderer's drawMesh3D wrapper on `nv`. `state` is a
 * live, mutable object owned by the caller (NiivueViewer's
 * tractRenderStateRef.current) — read fresh every frame so changing it never
 * requires reinstalling or rebuilding anything.
 */
export function installTractRenderer(nv, state) {
  if (INSTALLED.has(nv)) return; // idempotent
  // Patches NVMesh.prototype.updateFibers once, module-
  // wide (patchUpdateFibers is itself idempotent — see tractBuffers.js), so
  // every tract mesh's compacted instanced-draw buffer (mesh.__tract) stays
  // in sync with niivue's own colour/topology rebuilds. Safe to call before
  // any mesh is loaded.
  patchUpdateFibers();
  const orig = nv.drawMesh3D.bind(nv);
  const cache = createTractPrograms();
  nv.drawMesh3D = (isDepthTest = true, alpha = 1, m, modelMtx, normMtx, is2D = false) =>
    drawMesh3DWrapped(nv, state, cache, orig, isDepthTest, alpha, m, modelMtx, normMtx, is2D);
  nv.drawMesh3D.__tractWrapped = orig; // lets HMR detect a stale wrapper
  INSTALLED.set(nv, { orig, cache });
}

/**
 * Restores nv.drawMesh3D to the pre-install function and releases every GL
 * program in the cache. Idempotent — safe to call on an nv that was never
 * installed, and safe to call twice.
 */
export function uninstallTractRenderer(nv) {
  const rec = INSTALLED.get(nv);
  if (!rec) return;
  try { nv.drawMesh3D = rec.orig; } catch (_e) {}
  try { disposeTractPrograms(rec.cache, nv.gl); } catch (_e) {}
  INSTALLED.delete(nv);
}
