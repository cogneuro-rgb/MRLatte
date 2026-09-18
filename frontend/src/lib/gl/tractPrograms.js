import { TRACT_VERT_LINES, TRACT_VERT_INSTANCED, TRACT_FRAG } from "@/lib/gl/tractShaders";

// ===== Program cache for the mrview-parity tractography renderer =====
// One compiled program per (geometry, lighting) permutation, keyed so that
// tubes, points and lighting can add permutations without touching the lines
// path. The deleted depth-ghost occlusion module compiled a single fixed
// program at first use; this cache instead compiles lazily per key.

/**
 * Plain cache bag. No GL work at construction — the GL context may not exist
 * yet when this is called (see installTractRenderer's timing).
 */
export function createTractPrograms() {
  return { programs: new Map() };
}

function injectDefines(src, defines) {
  if (!defines.length) return src;
  // Defines must be injected on the line AFTER `#version 300 es`, not before
  // it — GLSL ES requires #version to be the first line of the shader source.
  const nl = src.indexOf("\n");
  const head = src.slice(0, nl + 1);
  const tail = src.slice(nl + 1);
  const defineBlock = defines.map((d) => `#define ${d}`).join("\n") + "\n";
  return head + defineBlock + tail;
}

function withLineNumbers(src) {
  return src
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}

// Exported for reuse by volumeRenderShader.js — the volume-render-shader
// installer compiles its own (vendored, not tract) GLSL and wants the exact
// same compile-and-log-errors behavior rather than a second copy of it.
export function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    console.error(
      `[tractPrograms] shader compile error:\n${info}\n--- source ---\n${withLineNumbers(src)}`
    );
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// The full uniform list. Every one is resolved (possibly to
// null, for uniforms a given permutation's shader doesn't declare — e.g.
// halfFovMM/viewportPx/thicknessMM/minThicknessPx in the Lines vertex shader)
// and cached once at link time.
const UNIFORM_NAMES = [
  "mvpMtx", "mvMtx", "mm2frac",
  "clipPlane", "clipEnabled",
  "halfFovMM", "viewportPx",
  "thicknessMM", "minThicknessPx",
  "viewZmm", "slabCenter", "pivotMM", "sceneRadiusMM",
  "slabHalfMM", "softEdge",
  "passScale", "occludedScale", "depthCueFloor", "clampToOne",
  "lightDir", "ambient", "diffuse", "specular", "shine",
];

/**
 * getTractProgram(cache, gl, { geometry, lighting }) -> { program, uniforms } | null
 *
 * geometry === 'lines'  -> TRACT_VERT_LINES, LIGHTING never defined (no usable normal).
 * geometry === 'tubes'  -> TRACT_VERT_INSTANCED + #define TUBE.
 * geometry === 'points' -> TRACT_VERT_INSTANCED + #define POINTS_MODE.
 * lighting === true (tubes/points only) additionally adds #define LIGHTING.
 */
export function getTractProgram(cache, gl, { geometry, lighting }) {
  const key = `${geometry}|${lighting ? 1 : 0}`;
  const cached = cache.programs.get(key);
  if (cached !== undefined) return cached;

  let vertSrc;
  const fragDefines = [];
  if (geometry === "lines") {
    vertSrc = TRACT_VERT_LINES;
    // LIGHTING is intentionally never defined for lines — no usable normal.
  } else if (geometry === "tubes") {
    vertSrc = injectDefines(TRACT_VERT_INSTANCED, ["TUBE"]);
    fragDefines.push("TUBE");
    if (lighting) fragDefines.push("LIGHTING");
  } else if (geometry === "points") {
    vertSrc = injectDefines(TRACT_VERT_INSTANCED, ["POINTS_MODE"]);
    fragDefines.push("POINTS_MODE");
    if (lighting) fragDefines.push("LIGHTING");
  } else {
    console.error(`[tractPrograms] unknown geometry "${geometry}"`);
    cache.programs.set(key, null);
    return null;
  }

  const fragSrc = injectDefines(TRACT_FRAG, fragDefines);

  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    cache.programs.set(key, null);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(
      `[tractPrograms] program link error (${key}):\n${gl.getProgramInfoLog(program)}`
    );
    gl.deleteProgram(program);
    cache.programs.set(key, null);
    return null;
  }

  const uniforms = {};
  for (const name of UNIFORM_NAMES) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  // Log every distinct (geometry, lighting) permutation the first time it
  // compiles, so it is visible which of the four functionally-meaningful
  // cache keys (tubes|0, tubes|1, points|0, points|1) actually got exercised
  // during a manual pass, without instrumenting a debugger. Fires once per key
  // (cache.programs.set below short-circuits every later call at the top of
  // this function). NOTE: `lighting` is read from state independently of
  // `geometry` in tractRenderer.js — if the user enables lighting on
  // tubes/points and then switches to Lines without turning it back off, a
  // "lines|1" key CAN be requested too. It is not a distinct program in any
  // way that matters: the geometry==='lines' branch above never pushes
  // LIGHTING into fragDefines regardless of the `lighting` argument, so
  // "lines|1"'s compiled source is byte-for-byte identical to "lines|0"'s —
  // just cached under, and compiled for, a separate key. Harmless (self-check
  // 3 only requires that no LIGHTING define reaches the lines shader, which
  // still holds), just not literally "four" keys in every session.
  console.log(`[tractPrograms] compiled program for key "${key}"`);

  const entry = { program, uniforms };
  cache.programs.set(key, entry);
  return entry;
}

/**
 * Deletes every compiled program and clears the cache. Safe to call with a
 * null/undefined gl (e.g. context already lost) — becomes a no-op besides
 * clearing the Map.
 */
export function disposeTractPrograms(cache, gl) {
  if (gl) {
    for (const entry of cache.programs.values()) {
      if (entry && entry.program) {
        try { gl.deleteProgram(entry.program); } catch (_e) {}
      }
    }
  }
  cache.programs.clear();
}
