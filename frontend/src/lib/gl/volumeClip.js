import { OVERLAY_OCCLUSION } from "@/lib/gl/volumeShaders"

/**
 * Per-layer clip-plane opt-out for volume overlays (lesion masks, activation
 * maps, atlases — anything loaded as an NVImage overlay, as opposed to the
 * mesh/tract clip in tractShaders.js which is a completely different
 * pipeline and is NOT touched here).
 *
 * === Why this needs a texture, not just a uniform ===
 *
 * Niivue composites ALL loaded overlay volumes into a SINGLE merged 3D
 * texture (`nv.overlayTexture`), built by `refreshLayers()` inside
 * `nv.updateGLVolume()` — see
 * node_modules/@niivue/niivue/src/niivue/index.ts. There is no per-overlay
 * draw call to hang a per-overlay clip uniform off (unlike tracts, which get
 * one GL draw call per mesh — see tractShaders.js / tractRenderer.js), so
 * "does this overlay clip?" has to be encoded spatially, per voxel.
 *
 * === The fix: one extra colour texture, read by our own shader ===
 *
 * frontend/src/lib/gl/volumeRenderShader.js installs a render shader
 * (frontend/src/lib/gl/volumeShaders.js) with one extra sampler,
 * `overlayClipExempt`. This file maintains the texture bound to it: a merge of
 * ONLY the overlays that HAVE opted out of clipping (`__optOutClip === true` —
 * e.g. a lesion mask with clip off). In the clip cut-away the shader's overlay
 * ray-march samples THIS texture instead of the full union `overlay`, so the
 * exempt overlays survive the cut while the clip-abiding ones vanish. It used
 * to hold the clip-ABIDING group and be read only as a boolean "skip this
 * sample" mask — but that discarded an exempt overlay wherever it shared a
 * voxel with a clipped one (the union blends both), which was the item-3 bug.
 * Rendering the exempt group's own colour there fixes it in the same single
 * pass. That per-sample test replaces
 * what used to require three separate `drawScene()` passes over different
 * merged overlay textures (clipped-only / unclipped-only / full-union), one
 * of which had to repaint the whole scene a second time with `draw3D`
 * no-op'd — see git history (this file was ~410 lines) for that approach and
 * why it was replaced: it broke multiplanar 3D rendering under clip (the
 * no-op'd repaint pass cleared the canvas and never repainted the 3D tile),
 * and still couldn't occlude overlays behind tissue in the same pass as
 * letting them survive the clip cut, because both directions used the SAME
 * `backgroundMasksOverlays` global toggle. Both problems are gone: this
 * shader also gates overlay visibility on `backNearest`/`fColor.a`
 * (`overlayOcclusion`, set below) so overlays behind the head fade instead
 * of shining through, entirely inside niivue's own single ray-march pass.
 *
 * `backgroundMasksOverlays` is now always forced to 0 — the old
 * "start the overlay ray at the background's own clipped firstHit" trick is
 * gone, replaced by the per-sample overlayClipExempt test, which is the only
 * way to give clipped and unclipped overlays different behaviour in one
 * pass (backgroundMasksOverlays is a single global toggle; it cannot
 * discriminate between overlay groups).
 *
 * The clip-mask texture is only rebuilt when the clipped/unclipped grouping
 * could have actually changed (any call to the real `nv.updateGLVolume()` —
 * opacity/colormap/threshold changes, add/remove overlay, or the clip
 * opt-out toggle itself all already call it, see volumeApi.js) AND the clip
 * plane is actually engaged — clip-off-by-default (this app's default) means
 * the common case never pays for a rebuild at all.
 */

function isClipEngaged(nv) {
  const dae = nv.scene?.clipPlaneDepthAziElevs?.[0]
  // Sentinel for "no clip" is depth >= ~2 (see shader-srcs.ts comment
  // "clipplane.a == 2.0 means no clipping" and tractRenderer.js's identical
  // `dae[0] < 1.0` engaged check, reused here for consistency).
  return !!dae && dae[0] < 1.0
}

function createEmptyOverlayTexture(gl) {
  // A fully-transparent 2x2x2 3D texture, used whenever the clip-exempt
  // group is empty (or the clip plane isn't engaged at all) so
  // `texture(overlayClipExempt, ...)` always reads a well-formed, all-zero-
  // alpha texture rather than sampling `null`/undefined-state GL.
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, 2, 2, 2)
  gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, 2, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(2 * 2 * 2 * 4))
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  return tex
}

function groupKey(overlays) {
  return overlays.map((v) => `${v.id}:${v.__optOutClip === true ? 1 : 0}`).join('|')
}

export function installVolumeClipPass(nv) {
  if (nv.__volumeClipInstalled) return

  const originalDrawScene = nv.drawScene.bind(nv)
  const originalUpdateGLVolume = nv.updateGLVolume.bind(nv)

  // Any call to the REAL updateGLVolume — from anywhere in the app (opacity,
  // colormap, threshold, add/remove overlay all already call it, see
  // volumeApi.js) — invalidates the cached clip-mask texture so the next
  // drawScene() rebuilds it with fresh data.
  nv.updateGLVolume = function () {
    originalUpdateGLVolume()
    nv.__volumeClipCacheDirty = true
  }

  // Rebuilds the merged overlay texture for exactly `overlaySubset` (a
  // subset of nv.volumes.slice(1)) by temporarily filtering nv.volumes and
  // invoking the REAL updateGLVolume — the only way to reuse niivue's own
  // layer-merge logic (VolumeLayerRenderer) without reimplementing it.
  // `nv.drawScene` is swapped to a no-op for the duration since
  // updateGLVolume() ends by calling `this.drawScene()` itself, which would
  // otherwise recurse into our wrapped version mid-build.
  function rebuildGroupTexture(overlaySubset) {
    const gl = nv.gl
    if (overlaySubset.length === 0) {
      return createEmptyOverlayTexture(gl)
    }
    const savedDrawScene = nv.drawScene
    const savedVolumes = nv.volumes
    nv.drawScene = function () {}
    nv.volumes = [savedVolumes[0], ...overlaySubset]
    try {
      originalUpdateGLVolume()
    } finally {
      nv.volumes = savedVolumes
      nv.drawScene = savedDrawScene
    }
    return nv.overlayTexture
  }

  function rebuildCache(overlays) {
    const gl = nv.gl
    // The clip-EXEMPT group: overlays that opted OUT of the clip plane
    // (__optOutClip === true — a lesion mask with clip off). In the cut-away
    // the shader renders ONLY these, so a clipped overlay overlapping an exempt
    // one no longer takes the exempt overlay down with it (item 3).
    const exempt = overlays.filter((v) => v.__optOutClip === true)

    // niivue allocates a brand-new WebGLTexture every time it merges layer 1
    // (`allocateVolumeTextures` calls `rgbaTex(null, ...)`, never reusing/
    // freeing the previous handle) — so without deleting our own previously
    // cached texture here, every rebuild leaks one 3D texture.
    if (nv.__clipExemptOverlayTex) gl.deleteTexture(nv.__clipExemptOverlayTex)

    // rebuildGroupTexture's temporary nv.volumes swap runs niivue's own
    // updateGLVolume(), which (as a side effect) overwrites nv.overlayTexture
    // with a texture merged from ONLY `exempt`. Save/restore the TRUE
    // full-union texture around that call — our shader's primary `overlay`
    // sampler (and the stock 2D slice shader, unpatched) must keep seeing
    // every overlay's color data, not just the clip-exempt subset.
    const savedOverlayTexture = nv.overlayTexture
    nv.__clipExemptOverlayTex = rebuildGroupTexture(exempt)
    nv.overlayTexture = savedOverlayTexture

    nv.__volumeClipCacheDirty = false
    nv.__volumeClipGroupKey = groupKey(overlays)
  }

  nv.drawScene = function () {
    const gl = this.gl
    const shader = this.renderShader
    if (gl && shader) {
      const overlays = this.volumes.slice(1)
      const clipEngaged = isClipEngaged(this)

      gl.activeTexture(gl.TEXTURE9)
      if (overlays.length > 0 && clipEngaged) {
        const key = groupKey(overlays)
        if (this.__volumeClipCacheDirty || this.__volumeClipGroupKey !== key) {
          rebuildCache(overlays)
        }
        gl.bindTexture(gl.TEXTURE_3D, this.__clipExemptOverlayTex)
      } else {
        // Clip off, or nothing loaded: skip the rebuild entirely (this is
        // the default state) and bind an empty mask — skipSample() itself
        // already always returns false with no clip plane engaged, so this
        // texture's content is moot either way, but a valid binding avoids
        // sampling an unbound unit.
        if (!this.__emptyOverlayTex) this.__emptyOverlayTex = createEmptyOverlayTexture(gl)
        gl.bindTexture(gl.TEXTURE_3D, this.__emptyOverlayTex)
      }

      shader.use(gl)
      gl.uniform1f(shader.uniforms.overlayOcclusion, OVERLAY_OCCLUSION)
      // Our shader now owns clipping (per-sample, via overlayClipExempt) and
      // occlusion (per-sample, via overlayOcclusion) explicitly — the old
      // "start the overlay march at the background's clipped firstHit" trick
      // is redundant and, worse, would clip EVERY overlay including ones
      // that opted out.
      this.backgroundMasksOverlays = 0
    }
    originalDrawScene()
  }

  nv.__volumeClipInstalled = true
  nv.__originalDrawScene = originalDrawScene
  nv.__originalUpdateGLVolume = originalUpdateGLVolume
}

export function uninstallVolumeClipPass(nv) {
  if (nv.__volumeClipInstalled) {
    const gl = nv.gl
    nv.drawScene = nv.__originalDrawScene
    nv.updateGLVolume = nv.__originalUpdateGLVolume
    if (gl) {
      if (nv.__clipExemptOverlayTex) gl.deleteTexture(nv.__clipExemptOverlayTex)
      if (nv.__emptyOverlayTex) gl.deleteTexture(nv.__emptyOverlayTex)
    }
    delete nv.__volumeClipInstalled
    delete nv.__originalDrawScene
    delete nv.__originalUpdateGLVolume
    delete nv.__clipExemptOverlayTex
    delete nv.__emptyOverlayTex
    delete nv.__volumeClipCacheDirty
    delete nv.__volumeClipGroupKey
  }
}
