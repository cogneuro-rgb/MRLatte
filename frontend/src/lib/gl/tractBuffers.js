import { NVMesh } from "@niivue/niivue";

// ===== Pseudotubes: the compacted instanced-draw buffer =====
// WHY THIS EXISTS: niivue's own NVMesh.updateFibers() uploads every
// vertex in the mesh to `this.vertexBuffer` (fiberDecimationStride only
// filters the INDEX array, not the vertex buffer), so instancing directly
// over `mesh.vertexBuffer` would issue npt-3 instances regardless of the
// display fraction. This module instead intercepts updateFibers' own
// gl.bufferData calls to capture its FINAL, already-decimated, already-
// coloured (Local/Global/Fixed/dpv<n> — colour logic is niivue's, never
// re-derived here) vertex + index payload, then repacks just the SURVIVING
// vertices into a second, purpose-built buffer laid out for
// gl.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, nSegments) with
// gl_VertexID supplying the quad corner (TRACT_VERT_INSTANCED).
//
// MEMORY EXPECTATION (not enforced here): 500k
// streamlines / ~50M points at the 4M-point budget (stride ~= 12) costs
// 16B x (visiblePts + 2*visibleStreamlines) for the VBO plus 1B x the same
// count for segValid ~= +68MB, ~8% on top of what the app already allocates.
// At 100% display it would be ~850MB — the point budget (POINT_BUDGET_TUBES/
// POINT_BUDGET_LINES in tractShaders.js) is not optional.

const RESTART = 0xffffffff; // niivue's primitive-restart sentinel, 2**32 - 1

let patched = false;

/**
 * Deletes this mesh's compacted-buffer GL objects (if any) and clears
 * mesh.__tract. Idempotent and null-safe: safe to call on a mesh that was
 * never compacted, and safe to call twice in a row.
 */
export function disposeTractBuffers(gl, mesh) {
  const t = mesh && mesh.__tract;
  if (!t) return;
  if (gl) {
    try { if (t.vbo) gl.deleteBuffer(t.vbo); } catch (_e) {}
    try { if (t.segBuf) gl.deleteBuffer(t.segBuf); } catch (_e) {}
    try { if (t.vao) gl.deleteVertexArray(t.vao); } catch (_e) {}
  }
  mesh.__tract = null;
}

/**
 * Marks an existing compacted buffer stale without touching GL. The next
 * ensureTractBuffers() call rebuilds it (via mesh.updateFibers(gl), the
 * patched version). This exists for the display-fraction slider (a real
 * topology change: a new fiberDecimationStride means different surviving
 * vertices).
 */
export function invalidateTractTopology(mesh) {
  if (mesh.__tract) mesh.__tract.dirty = true;
}

/**
 * Returns mesh.__tract, rebuilding it first if missing or flagged dirty.
 * Rebuilding means calling the PATCHED mesh.updateFibers(gl) — i.e. this can
 * only ever be triggered by a real topology change (nothing in this codebase
 * calls invalidateTractTopology() outside the stride slider, and
 * mesh.__tract is only ever missing before the mesh's first updateFibers()
 * call, which niivue itself issues once at load). Opacity, thickness,
 * lighting, slab and clip changes never touch dirty and never reach this
 * branch — they are pure per-frame uniforms in tractRenderer.js.
 */
export function ensureTractBuffers(gl, mesh) {
  if (!mesh) return null;
  if (!mesh.__tract || mesh.__tract.dirty) {
    try {
      mesh.updateFibers(gl); // the patched version — rebuilds __tract as a side effect
    } catch (e) {
      console.error("[tractBuffers] ensureTractBuffers: rebuild failed", e);
      mesh.__tract = null;
    }
  }
  return mesh.__tract || null;
}

// Pick the smallest fiberDecimationStride whose DISPLAYED
// point count fits `budget` (POINT_BUDGET_TUBES / POINT_BUDGET_LINES from
// tractShaders.js). Applied at load, in meshApi.js's add path.
//
// FORMULA (pure, no GL — niivue's own point count, unaffected by any prior
// decimation: fiberDecimationStride only filters the INDEX array, never
// mesh.pts):
//   nPoints = mesh.pts.length / 3
//   nPoints <= budget  =>  stride = 1                      (never decimate a
//                                                            tract that
//                                                            already fits)
//   otherwise          =>  stride = ceil(nPoints / budget)
//
// Why ceil(nPoints/budget) is the right closed form and not a per-streamline
// search: niivue decimates by STREAMLINE INDEX (`if (stride %
// this.fiberDecimationStride !== 0) continue`, i.e. streamline i survives
// iff i % fiberDecimationStride === 0), a uniform subsample of the
// streamline population with no systematic bias toward longer/shorter
// streamlines. The surviving point count therefore scales ~linearly with
// 1/stride regardless of per-streamline length variance, so nPoints/stride
// is already a good estimate of the displayed count at stride `stride`;
// ceil() rounds UP (a larger stride, fewer points) so the estimate never
// overshoots the budget from below.
export function autoStrideFor(mesh, budget) {
  if (!mesh || !mesh.pts || !(budget > 0)) return 1;
  const nPoints = mesh.pts.length / 3;
  if (nPoints <= budget) return 1;
  return Math.max(1, Math.ceil(nPoints / budget));
}

/**
 * Monkey-patches NVMesh.prototype.updateFibers exactly once (module-level,
 * shared across every mesh/Niivue instance — NOT undone by
 * uninstallTractRenderer, which only concerns the per-nv drawMesh3D wrapper;
 * unpatching a shared class prototype while other meshes/instances may still
 * be relying on it would be actively dangerous). Call from
 * installTractRenderer.
 *
 * The patched function:
 *   1. Intercepts gl.bufferData for the SYNCHRONOUS duration of the original
 *      updateFibers call to capture niivue's final coloured vertex payload
 *      and index array — captured, not re-derived, so every colour
 *      mode keeps working with zero duplicated logic.
 *   2. Restores the real gl.bufferData in a `finally`. Non-negotiable:
 *      a leak here corrupts every later GL upload in the app.
 *   3. Repacks the captured payload into mesh.__tract, a second, compacted,
 *      instance-ready buffer (compactInto, nested below so it can close over
 *      THIS call's `gl` — NVMesh instances keep no gl reference of their
 *      own, and this closure is the only place one is available at the
 *      moment the compacted data is ready).
 */
export function patchUpdateFibers() {
  if (patched) return;
  patched = true;
  const orig = NVMesh.prototype.updateFibers;

  NVMesh.prototype.updateFibers = function (gl) {
    // Guard: fiberSides > 2 && fiberRadius > 0 means niivue's own
    // updateFibers takes the linesToCylinders() path instead of building the
    // packed (xyz f32 + rgba u32) vertex buffer this module depends on — its
    // ARRAY_BUFFER upload is a Float32Array with 5 floats/vertex, not our
    // Uint32Array-viewed 4-words/vertex layout, so the interception below
    // would naturally fail to capture it anyway; bail out explicitly so that
    // isn't left implicit. The renderer falls back to Lines geometry when
    // mesh.__tract is null (bindTractGeometry / ensureTractBuffers).
    const cylinderPath = this.fiberSides > 2 && this.fiberRadius > 0;
    if (cylinderPath) this.__tract = null;

    const realBufferData = gl.bufferData;
    let posClrU32 = null;
    let indices = null;
    gl.bufferData = function (target, data, usage) {
      if (target === gl.ARRAY_BUFFER && data instanceof Uint32Array) posClrU32 = data;
      else if (target === gl.ELEMENT_ARRAY_BUFFER && data instanceof Uint32Array) indices = data;
      return realBufferData.call(this, target, data, usage);
    };

    // Nested so it closes over THIS invocation's `gl` (see the export-level
    // doc comment above) and the captured posClrU32/indices without needing
    // them threaded through extra parameters.
    function compactInto(mesh, posClrU32Src, indicesSrc) {
      // Word layout: 16 bytes/vertex = [x,y,z] float32 + [rgba] uint32,
      // i.e. word offset 4*vertexIndex into posClrU32Src. Reinterpret the
      // SAME underlying bytes as float32 to read x/y/z; rgba is read
      // straight off the uint32 view already in hand.
      const posF32 = new Float32Array(posClrU32Src.buffer, posClrU32Src.byteOffset, posClrU32Src.length);

      // ---- pass 1: size the compacted buffers ----
      // indices is a run-length list of vertex indices separated by RESTART.
      // Each surviving run of n real vertices becomes n+2 compact vertices
      // (endpoint duplication — see the pass-2 loop below), so
      // nCompact = totalReal + 2*streamlineCount.
      let totalReal = 0;
      let streamlineCount = 0;
      let runLen = 0;
      for (let i = 0; i < indicesSrc.length; i++) {
        if (indicesSrc[i] === RESTART) {
          if (runLen > 0) { totalReal += runLen; streamlineCount++; }
          runLen = 0;
        } else {
          runLen++;
        }
      }
      // Defensive only: niivue always pushes RESTART after every surviving
      // streamline (see dist/index.js's updateFibers), so indices never
      // actually ends mid-run — but don't silently drop a trailing run if
      // that ever changes.
      if (runLen > 0) { totalReal += runLen; streamlineCount++; }

      const nCompact = totalReal + 2 * streamlineCount;
      const nSegments = Math.max(nCompact - 3, 0);

      // Release any buffers from a PREVIOUS compaction of this mesh before
      // allocating new ones — this runs on every real rebuild (colour-mode
      // change, or a future Stage-5 stride change), not just the first load.
      disposeTractBuffers(gl, mesh);

      if (nCompact < 4) {
        // Nothing instanceable (e.g. every surviving streamline decimated to
        // a single point, or zero streamlines survived). Leave __tract null
        // so the renderer falls back to Lines (bindTractGeometry / emit
        // already treat a missing __tract / nSegments < 1 as "skip this
        // mesh" rather than throwing).
        mesh.__tract = null;
        return;
      }

      // ---- pass 2: fill the compacted vertex + segValid buffers ----
      // compactF32/compactU32 are two typed-array VIEWS over the SAME
      // ArrayBuffer (mirrors niivue's own posClrF32/posClrU32 pairing)
      // so xyz can be written as floats and rgba as a raw uint32 into
      // the same 16-byte-per-vertex slot.
      const compactF32 = new Float32Array(nCompact * 4);
      const compactU32 = new Uint32Array(compactF32.buffer);
      const segValid = new Uint8Array(nCompact);

      const writeVertex = (destIdx, srcVtx) => {
        const s = srcVtx * 4;
        const d = destIdx * 4;
        compactF32[d + 0] = posF32[s + 0];
        compactF32[d + 1] = posF32[s + 1];
        compactF32[d + 2] = posF32[s + 2];
        compactU32[d + 3] = posClrU32Src[s + 3];
      };

      let destCursor = 0;
      let runStartCursor = 0;
      let lastSrc = -1;
      runLen = 0;
      // One extra virtual iteration (i === indicesSrc.length) closes out a
      // final run with no trailing sentinel — see the defensive pass-1 note.
      for (let i = 0; i <= indicesSrc.length; i++) {
        const v = i < indicesSrc.length ? indicesSrc[i] : RESTART;
        if (v === RESTART) {
          if (runLen > 0) {
            // Endpoint duplication: v0, v0, v1, ..., v(n-1), v(n-1) — the
            // first duplicate was already written below when this run
            // started; write the LAST duplicate now that we know which
            // vertex was last.
            writeVertex(destCursor, lastSrc);
            destCursor++;
            // Instance j reads compact vertices j, j+1, j+2, j+3 as
            // (prev, a, b, next) — see the VAO layout below. For a run of n
            // real vertices occupying compact indices
            // runStartCursor .. runStartCursor+n+1, the valid instances are
            // j in [runStartCursor, runStartCursor+n-2] (n-1 segments); the
            // run's final three compact vertices stay segValid=0 (their
            // default Uint8Array value) — those would-be instances read
            // across into the NEXT run's vertices, and the vertex shader
            // kills them (TRACT_VERT_INSTANCED: `if (segValid < 0.5)
            // gl_Position = vec4(2,2,2,1)`).
            const validEnd = runStartCursor + runLen - 2; // < runStartCursor when runLen===1 (0 segments)
            for (let g = runStartCursor; g <= validEnd; g++) segValid[g] = 1;
            runLen = 0;
          }
          runStartCursor = destCursor;
        } else {
          if (runLen === 0) {
            // First real vertex of a new run: duplicate immediately.
            writeVertex(destCursor, v); destCursor++;
            writeVertex(destCursor, v); destCursor++;
          } else {
            writeVertex(destCursor, v); destCursor++;
          }
          lastSrc = v;
          runLen++;
        }
      }

      // Self-check: for a run
      // of n original vertices we emit n+2 compact vertices and n-1 valid
      // instances, so summed over every surviving run, sum(n_i - 1) ==
      // totalReal - streamlineCount. Verify that equals the actual count of
      // segValid[j] === 1, and that nSegments === nCompact - 3 (both were
      // derived from the same totalReal/streamlineCount above, so this also
      // catches an arithmetic drift between the sizing pass and the fill
      // pass). console.warn only, never throw — a mismatch is a compaction
      // bug to investigate, not something that should crash rendering.
      let validCount = 0;
      for (let g = 0; g < segValid.length; g++) if (segValid[g] === 1) validCount++;
      const expectedValid = totalReal - streamlineCount;
      if (validCount !== expectedValid || nSegments !== nCompact - 3) {
        console.warn(
          `[tractBuffers] compaction self-check failed: validCount=${validCount} ` +
          `expected=${expectedValid}, nSegments=${nSegments} expected=${nCompact - 3}`
        );
      }

      // ---- GL upload ----
      // NOT going through the intercepted gl.bufferData: that interception
      // was already torn down in the `finally` around orig.call(gl) before
      // compactInto ever runs, so these are ordinary, unintercepted
      // uploads on this mesh's own buffers.
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, compactF32, gl.STATIC_DRAW);

      const segBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
      gl.bufferData(gl.ARRAY_BUFFER, segValid, gl.STATIC_DRAW);

      // VAO layout (exact): one VBO bound four times at byte
      // offsets 0/16/32/48 (prevPos/aPos/bPos/nextPos), plus the two colour
      // attributes reading the rgba word trailing aPos/bPos's position
      // floats within that same 16-byte vertex slot, plus segValid from the
      // separate 1-byte-per-vertex segBuf. All seven get
      // vertexAttribDivisor(loc, 1) — gl_VertexID (0..3) supplies the quad
      // corner in the shader; there is no per-vertex attribute for it.
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      const STRIDE = 16;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);   // prevPos
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 16);  // aPos
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 32);  // bPos
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, STRIDE, 48);  // nextPos
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, STRIDE, 28); // aClr
      gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, STRIDE, 44); // bClr
      gl.vertexAttribDivisor(0, 1);
      gl.vertexAttribDivisor(1, 1);
      gl.vertexAttribDivisor(2, 1);
      gl.vertexAttribDivisor(3, 1);
      gl.vertexAttribDivisor(4, 1);
      gl.vertexAttribDivisor(5, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 1, gl.UNSIGNED_BYTE, false, 1, 0); // segValid
      gl.vertexAttribDivisor(6, 1);

      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      mesh.__tract = { vbo, segBuf, vao, nCompact, nSegments, dirty: false };
    }

    try {
      orig.call(this, gl);
    } finally {
      gl.bufferData = realBufferData; // non-negotiable — see patchUpdateFibers doc
    }

    if (cylinderPath) {
      posClrU32 = null;
      indices = null;
      return;
    }
    try {
      if (posClrU32 && indices) compactInto(this, posClrU32, indices);
      else this.__tract = null; // orig didn't take the branch we intercept (shouldn't happen outside cylinderPath, but don't assume)
    } catch (e) {
      console.error("tract compaction failed", e);
      this.__tract = null; // renderer falls back to lines
    }
    posClrU32 = null;
    indices = null; // drop immediately
  };
}
