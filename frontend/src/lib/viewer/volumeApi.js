import { toast } from "sonner";
import { histogram as computeHistogram, regionCentroidMM } from "@/lib/volumeAnalysis";
import { thresholdedVolume } from "@/lib/measure";
import {
  applyThresholdColormap,
  isContinuousOverlay,
  isLabelIntentOverlay,
  applyLabelOverlayColor,
  computeHasZeroVoxels,
  fixGlobalMinMax,
  applyAtlasLabelLut,
} from "@/lib/viewer/colormapUtils";

/**
 * Base-volume load/replace/reset and overlay load/threshold/colormap methods.
 *
 * Backs the replaceBaseVolume / addOverlayFromUrl / addHiddenLabelLayer /
 * removeHiddenLabelLayer / addOverlayFromFile / removeOverlayByName /
 * clearAllOverlays / setOverlay* / getOverlay* / setIgnoreZeroVoxels /
 * getVolume / setBase* / getBase* / resetToBase / removeVolume entries of
 * NiivueViewer's imperative handle. Method names, signatures and behaviour
 * are unchanged — this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, volumeMap, hiddenLabelLayers, baseFileRef,
 *                       measurementMeshRef, measurementPointsRef, lastDraws,
 *                       drawHistory.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {(vol: any, targetVol?: any) => boolean} deps.correctDegenerateAffineIfNeeded
 * @param {() => void} deps.resetOverlayTexture
 * @param {(id: string) => { idx: number, vol: any }} deps.findVolume
 * @param {() => void} deps.emitHistory
 * @param {(v: any[]) => void} deps.setMeasure2D
 * @param {(v: any) => void} deps.setMeasureHover
 */
export function createVolumeApi(ctx, {
  correctDegenerateAffineIfNeeded,
  resetOverlayTexture,
  findVolume,
  emitHistory,
  setMeasure2D,
  setMeasureHover,
}) {
  const {
    nvRef, volumeMap, meshMap, hiddenLabelLayers, baseFileRef,
    measurementMeshRef, measurementPointsRef, lastDraws, drawHistory,
  } = ctx;

  return {
    replaceBaseVolume: async (file) => {
      const nv = nvRef.current;
      if (!nv) return false;
      try {
        // Remove all current volumes (and re-add overlays after)
        const overlays = nv.volumes.slice(1).map((v) => v);
        for (const v of [...nv.volumes]) nv.removeVolume(v);
        volumeMap.current.clear();

        // Item 101: capture the drawing bitmap's current size (voxel count)
        // before the swap, so we can tell afterward whether the new base's
        // grid actually differs — see the dims-mismatch handling below.
        const prevDrawLen = nv.drawBitmap ? nv.drawBitmap.length : null;
        const hadNonEmptyDrawing = !!(nv.drawBitmap && nv.drawBitmap.some((v) => v !== 0));

        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob);
        let vol;
        try {
          vol = await nv.addVolumeFromUrl({
            url: blobUrl,
            name: "base_custom",
            colormap: "gray",
            opacity: 1,
          });
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (vol) {
          try { vol.name = "base_custom"; } catch (_e) {}
          // niivue defaults colorbarVisible=true on every volume — leaving the
          // base on causes toggles to misbehave because the global isColorbar
          // is derived from .some(colorbarVisible) (see MNI152 load above).
          try { vol.colorbarVisible = false; } catch (_e) {}
          volumeMap.current.set("base_custom", vol);
          // Degenerate-affine files (no sform, no qform) load with their
          // corner, not their center, at world origin — re-center on [0,0,0].
          if (correctDegenerateAffineIfNeeded(vol)) {
            nv.updateGLVolume();
            toast.info("Centered automatically", {
              description: "This file had no spatial position info in its header.",
            });
          }
        }
        // Re-add previous overlays
        for (const ov of overlays) nv.addVolume(ov);

        // Item 101: nv.back now points at the NEW base volume (niivue's own
        // addVolume/setVolume keeps it in sync), but nv.drawBitmap/drawTexture
        // are only (re)allocated by createEmptyDrawing() — which this path
        // never called — so they stay sized for whatever grid was active
        // when drawing was last enabled. Left stale after a grid change this
        // causes: painted strokes landing outside the old bitmap's length
        // (JS typed-array writes past the end are silently dropped — "the
        // drawing overlay doesn't show up"), drawingApi.js's own dims-
        // mismatch guards refusing interpolation ("Drawing grid
        // unavailable"), and getDrawingBytes() building a NIfTI header from
        // the NEW dims around data that was actually written using the OLD
        // dims' flat-index math. Force a fresh allocation whenever the grid
        // actually changed size.
        const newDims = nv.back?.dims;
        const newVoxCount = newDims ? newDims[1] * newDims[2] * newDims[3] : null;
        const dimsChanged = prevDrawLen != null && newVoxCount != null && prevDrawLen !== newVoxCount;
        if (dimsChanged) {
          if (hadNonEmptyDrawing) {
            toast.warning("Drawing cleared", {
              description: "The new base image has a different voxel grid — the current drawing can't carry over.",
            });
          }
          try { nv.createEmptyDrawing(); } catch (_e) {}
          // The old drawing's undo history describes a grid that no longer
          // exists — drop it so Undo/Redo don't try to restore incompatible
          // snapshots against the freshly (re)allocated bitmap.
          drawHistory.current = [];
          lastDraws.current = [];
          try { emitHistory(); } catch (_e) {}
        } else if (nv.opts?.drawingEnabled && !nv.drawBitmap) {
          // No prior drawing existed yet but drawing IS enabled — make sure
          // the bitmap/texture exist for the (possibly first-ever) base grid.
          try { nv.createEmptyDrawing(); } catch (_e) {}
        }

        baseFileRef.current = file;
        toast.success("Base volume replaced", { description: file.name });
        return true;
      } catch (err) {
        toast.error("Failed to replace base volume", { description: err?.message });
        return false;
      }
    },

    // `layerCfg.quiet` marks a BEST-EFFORT load the user never asked for (the
    // retinotopy legend preloads four atlases the moment a lesion exists, two
    // of which ship only with an optional module). Those 404 on a core install,
    // and niivue throws "Cannot set properties of undefined (setting 'url')"
    // from inside addVolumeFromUrl — which surfaced as a burst of "Failed to
    // load Eccentricity" toasts for something nobody requested. A quiet load
    // reports to the console instead; callers that the user DID initiate leave
    // the flag off and still get a toast.
    addOverlayFromUrl: async (layerCfg) => {
      const nv = nvRef.current;
      if (!nv) return null;
      try {
        const opts = {
          url: layerCfg.url,
          colormap: layerCfg.colormap,
          opacity: layerCfg.opacity,
          name: layerCfg.id,
        };
        if (typeof layerCfg.cal_min === "number") opts.cal_min = layerCfg.cal_min;
        if (typeof layerCfg.cal_max === "number") opts.cal_max = layerCfg.cal_max;
        if (layerCfg.ignoreZeroVoxels) opts.ignoreZeroVoxels = true;
        // Signed-data split (e.g. polar angle, t-maps): a positive cmap covers
        // [cal_min, cal_max] and `colormapNegative` covers the NEGATIVE value
        // range [cal_minNeg, cal_maxNeg] given as SIGNED-NEGATIVE bounds
        // (NiiVue negates them internally: mn=-cal_minNeg, mx=-cal_maxNeg — see
        // dist/index.js). So for a symmetric map pass cal_minNeg=-cal_max,
        // cal_maxNeg=-cal_min. Values inside (-cal_min, +cal_min) render
        // transparent, hiding background voxels.
        if (layerCfg.colormapNegative) opts.colormapNegative = layerCfg.colormapNegative;
        if (typeof layerCfg.cal_minNeg === "number") opts.cal_minNeg = layerCfg.cal_minNeg;
        if (typeof layerCfg.cal_maxNeg === "number") opts.cal_maxNeg = layerCfg.cal_maxNeg;
        const vol = await nv.addVolumeFromUrl(opts);
        if (vol) {
          // Force the niivue volume name to match our id (niivue may set it from URL basename)
          try { vol.name = layerCfg.id; } catch (_e) {}
          try { vol.colorbarVisible = false; } catch (_e) {}
          // Degenerate-affine overlays (no sform, no qform) load with their
          // corner at world origin — re-center on the CURRENT base volume's
          // world center instead of blindly on [0,0,0], so overlays still
          // line up even when the base isn't MNI152-centered.
          if (correctDegenerateAffineIfNeeded(vol, nv.volumes[0])) {
            nv.updateGLVolume();
            toast.info("Centered automatically", {
              description: "This file had no spatial position info in its header.",
            });
          }
          // NiiVue internally uses a falsy check for the opacity URL option, so
          // opacity:0 is silently skipped (0 is falsy) and the volume loads at its
          // default opacity instead of invisible. Explicitly enforce the requested
          // opacity here — mirrors the setOverlayOpacity pattern — so that
          // silently-loaded atlases (e.g. an atlas loaded only for label lookup)
          // truly have no visual impact on the canvas.
          if (typeof opts.opacity === "number") {
            try {
              const idx = nv.volumes.indexOf(vol);
              if (idx >= 0) {
                nv.setOpacity(idx, opts.opacity);
                vol.opacity = opts.opacity;
                nv.updateGLVolume();
              }
            } catch (_e) {}
          }
          // Optional per-layer flag: hide voxels at value 0. Niivue only
          // honours this when set DIRECTLY on the volume + GL rebuild,
          // not via the URL options dict. Essential for signed maps where
          // 0 is BACKGROUND, not a real meaningful value.
          if (layerCfg.ignoreZeroVoxels) {
            try {
              vol.ignoreZeroVoxels = true;
              nv.updateGLVolume();
            } catch (_e) {}
          }
          if (layerCfg.colormapNegative) {
            try {
              vol.colormapNegative = layerCfg.colormapNegative;
              if (typeof layerCfg.cal_minNeg === "number") vol.cal_minNeg = layerCfg.cal_minNeg;
              if (typeof layerCfg.cal_maxNeg === "number") vol.cal_maxNeg = layerCfg.cal_maxNeg;
              nv.updateGLVolume();
            } catch (_e) {}
          }
          // Discrete-label atlases (visfAtlas, AAL, …) must use nearest-
          // neighbour texture sampling — otherwise WebGL's trilinear sampling
          // smears integer labels into fractional values that index into the
          // LUT centre (often a strong colour) for the entire volume, producing
          // the well-known "red flood" bleed across the brain background.
          //
          // Niivue only exposes a GLOBAL flag (no per-volume option) so we
          // flip it for the whole scene when ANY label atlas is loaded.
          // setInterpolation(true) walks all existing volume textures and
          // re-uploads them with NEAREST sampler — required because the
          // visfAtlas texture has already been uploaded by addVolumeFromUrl
          // above with the previous (linear) sampler.
          if (layerCfg.nearestInterpolation) {
            try { nv.setInterpolation(true); } catch (_e) {}
          }
          // For discrete-label atlases, niivue requires the dedicated
          // colormapLabel pathway — addColormap interpolates continuously
          // which would smear the 33 visfAtlas ROIs into a single hue.
          if (layerCfg.colormapLabel) {
            try {
              vol.setColormapLabel(layerCfg.colormapLabel);
              nv.updateGLVolume();
            } catch (e) {
              console.warn("setColormapLabel failed for", layerCfg.id, e);
            }
          }
          // Initialise stable-color thresholding for continuous overlays.
          // Captures the user's chosen colormap and the load-time threshold,
          // then registers an alpha-masked derived LUT.
          if (isContinuousOverlay(nv, vol)) {
            fixGlobalMinMax(vol);
            vol.__origColormap = layerCfg.colormap || vol.colormap || "warm";
            vol.__naturalCalMin = vol.cal_min;
            vol.__naturalCalMax = vol.cal_max;
            // "Mask zero voxels" toggle default. layerCfg.ignoreZeroVoxels marks the
            // configs whose 0 is background (e.g. the polar/eccen retinotopy maps).
            vol.__maskZero = !!layerCfg.ignoreZeroVoxels;
            vol.__userThreshold = { lo: vol.cal_min, hi: vol.cal_max };
            // Colour-scaling range defaults to the full data range — matches
            // the pre-dual-threshold look until the user narrows it.
            vol.__colorRange = { min: vol.global_min ?? vol.cal_min, max: vol.global_max ?? vol.cal_max };
            applyThresholdColormap(nv, vol, vol.cal_min, vol.cal_max, false, vol.__colorRange.min, vol.__colorRange.max);
            nv.updateGLVolume();
          }
          volumeMap.current.set(layerCfg.id, vol);
        }
        return vol;
      } catch (err) {
        if (layerCfg.quiet) console.warn(`[overlay] optional layer ${layerCfg.id} unavailable:`, err?.message);
        else toast.error(`Failed to load ${layerCfg.name}`, { description: err?.message });
        return null;
      }
    },

    addHiddenLabelLayer: async (id, url) => {
      const nv = nvRef.current;
      if (!nv) return null;
      if (hiddenLabelLayers.current[id]) return hiddenLabelLayers.current[id];
      try {
        const vol = await nv.addVolumeFromUrl({ url, name: id, colormap: "gray", opacity: 0 });
        if (vol) {
          try { vol.name = id; } catch (_e) {}
          hiddenLabelLayers.current[id] = vol;
          volumeMap.current.set(id, vol);
        }
        return vol;
      } catch (err) {
        return null;
      }
    },

    removeHiddenLabelLayer: (id) => {
      const nv = nvRef.current;
      const vol = hiddenLabelLayers.current[id];
      if (nv && vol) {
        try { nv.removeVolume(vol); } catch (_e) {}
      }
      delete hiddenLabelLayers.current[id];
      volumeMap.current.delete(id);
    },

    addOverlayFromFile: async (file, opts = {}) => {
      const nv = nvRef.current;
      if (!nv) return null;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob);
        const id = opts.name || file.name;
        let vol;
        try {
          vol = await nv.addVolumeFromUrl({
            url: blobUrl,
            name: id,
            colormap: opts.colormap || "red",
            opacity: opts.opacity ?? 0.9,
          });
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        if (vol) {
          try { vol.name = id; } catch (_e) {}
          try { vol.colorbarVisible = false; } catch (_e) {}
          // Degenerate-affine overlays (no sform, no qform) load with their
          // corner at world origin — re-center on the CURRENT base volume's
          // world center instead of blindly on [0,0,0], so overlays still
          // line up even when the base isn't MNI152-centered.
          if (correctDegenerateAffineIfNeeded(vol, nv.volumes[0])) {
            nv.updateGLVolume();
            toast.info("Centered automatically", {
              description: "This file had no spatial position info in its header.",
            });
          }
          // Label-intent overlays (hdr.intent_code === NIFTI_INTENT_LABEL) get
          // forced through niivue's own atlas shader regardless of what colormap
          // was requested (see isLabelIntentOverlay) — give them a solid-color
          // discrete LUT via colormapLabel BEFORE the continuous check below, so
          // isContinuousOverlay's existing `vol.colormapLabel` gate correctly
          // routes them around applyThresholdColormap instead of building a LUT
          // that renders invisible on this class of file.
          if (isLabelIntentOverlay(vol) && !vol.colormapLabel) {
            applyLabelOverlayColor(vol, opts.colormap || vol.colormap || "red");
            nv.updateGLVolume();
            nv.drawScene();
          }
          // Initialise stable-color thresholding for continuous overlays.
          if (isContinuousOverlay(nv, vol)) {
            fixGlobalMinMax(vol);
            vol.__origColormap = opts.colormap || vol.colormap || "warm";
            vol.__naturalCalMin = vol.cal_min;
            vol.__naturalCalMax = vol.cal_max;
            // Default state of the "mask zero voxels" TOGGLE. For masks (lesion/ROI)
            // 0 is background by definition, so start masked — otherwise the mask's
            // zero background blends over the whole base volume and visibly darkens
            // the scan, with lesion opacity acting as a veil control (SMALL-FIXES 45).
            // Activation maps start UNmasked: their default view (show-outside over
            // −1..1) already hides zeros via the threshold, and leaving the toggle off
            // means switching to show-inside correctly reveals them (SMALL-FIXES 48).
            vol.__maskZero = opts.overlayKind === "lesion" || opts.overlayKind === "roi";
            // Default state of the "clip" opt-out: lesion masks and activation
            // maps start opted OUT of the 3D clip-plane grouping with the base
            // volume (see Dashboard.jsx's addUserFile, which mirrors this same
            // set of overlayKind strings for the React layer-list `clip` field
            // so the UI toggle and this GL-side default never disagree).
            vol.__optOutClip = opts.overlayKind === "lesion" || opts.overlayKind === "roi" || opts.overlayKind === "activation";
            // Activation maps default to mrview-style "show OUTSIDE thresholds"
            // over a −1..1 window with the colour range left at the full data
            // range (SMALL-FIXES 49) — i.e. hide the noise floor around zero and
            // show both tails, with zero itself hard-masked (48).
            const isActivation = opts.overlayKind === "activation";
            vol.__invertThreshold = isActivation ? true : false;
            vol.__userThreshold = isActivation
              ? { lo: -1, hi: 1 }
              : { lo: vol.cal_min, hi: vol.cal_max };
            vol.__colorRange = { min: vol.global_min ?? vol.cal_min, max: vol.global_max ?? vol.cal_max };
            const ut = vol.__userThreshold;
            applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold, vol.__colorRange.min, vol.__colorRange.max);
            nv.updateGLVolume();
          }
          volumeMap.current.set(id, vol);
        }
        return vol;
      } catch (err) {
        toast.error(`Failed to load ${file.name}`, { description: err?.message });
        return null;
      }
    },

    removeOverlayByName: (id) => {
      const nv = nvRef.current;
      if (!nv) return;
      const vol = volumeMap.current.get(id) || nv.volumes.find((v) => v?.name === id);
      if (vol) {
        try { nv.removeVolume(vol); } catch (_e) {}
      }
      volumeMap.current.delete(id);
    },

    clearAllOverlays: async () => {
      const nv = nvRef.current;
      if (!nv) return;
      const baseVol = nv.volumes[0]; // base is always loaded first / index 0
      // 1. Remove ALL meshes (incl. tracts and inflated brain)
      for (const mesh of [...nv.meshes]) {
        try { nv.removeMesh(mesh); } catch (_e) {}
      }
      meshMap.current.clear();
      // clearAllOverlays' mesh loop above already removed the measurement-
      // points connectome mesh (if any) — just reset our tracking state.
      measurementMeshRef.current = null;
      measurementPointsRef.current = [];
      setMeasure2D([]);
      setMeasureHover(null);
      // 2. Remove every non-base volume by reference (synchronous — avoids the
      // async loadVolumes-reload race that could leave a ghost of the last
      // overlay in the 3D render texture).
      for (const v of nv.volumes.slice(1)) {
        try { nv.removeVolume(v); } catch (_e) {}
      }
      lastDraws.current = [];
      drawHistory.current.reset();
      emitHistory();
      volumeMap.current.clear();
      hiddenLabelLayers.current = {};
      if (baseVol) volumeMap.current.set(baseVol.name, baseVol);
      // 3. Clear drawing
      try {
        nv.drawClearAllUndoBitmaps();
        if (nv.drawBitmap) nv.drawBitmap.fill(0);
        nv.refreshDrawing(true);
      } catch (_e) {}
      // 4. Rebuild the composited GL/3D-render textures from the base-only stack.
      // Blank the overlay 3D texture first — without this the 3D render keeps a
      // ghost of the last-removed overlay (see resetOverlayTexture).
      try {
        resetOverlayTexture();
        nv.updateGLVolume();
        nv.drawScene();
      } catch (_e) {}
    },

    setOverlayOpacity: (id, opacity) => {
      const nv = nvRef.current;
      const { idx, vol } = findVolume(id);
      if (!nv || idx < 0 || !vol) return;
      // nv.setOpacity() forces a synchronous updateGLVolume() (full GL texture
      // rebuild) on every call, which is far too slow for continuous slider
      // drags. Its only real effect is the property assignment below (see
      // VolumeManager.setOpacity) — do that directly and redraw ourselves.
      vol.opacity = opacity;
      nv.updateGLVolume();
      nv.drawScene();
    },

    setOverlayClip: (id, clipOn) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      // vol.__optOutClip starts as `undefined` (never `false`) for every
      // freshly-loaded overlay, so comparing it directly against the
      // incoming boolean `clipOn` (as this used to do) fails on the very
      // first toggle: undefined === false is false, so the assignment was
      // skipped and the button did nothing the first time it was clicked.
      // Compare against the coerced current state instead.
      const desiredOptOut = !clipOn;
      if (Boolean(vol.__optOutClip) === desiredOptOut) return;
      vol.__optOutClip = desiredOptOut;
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Atlas region colours + region isolation. Both are the same per-volume
    // label LUT (see colormapUtils.applyAtlasLabelLut), so they compose: an
    // isolated set keeps whatever colours the user assigned.
    setOverlayLabelColors: (id, regions) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      applyAtlasLabelLut(vol, regions, vol.__labelFilter || null);
      vol.__labelRegions = regions || [];
      nv.updateGLVolume();
      nv.drawScene();
    },

    setOverlayLabelFilter: (id, values) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      vol.__labelFilter = values && values.length ? values : null;
      applyAtlasLabelLut(vol, vol.__labelRegions || [], vol.__labelFilter);
      nv.updateGLVolume();
      nv.drawScene();
    },

    setOverlayColormap: (id, colormap) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;

      if (isContinuousOverlay(nv, vol)) {
        // Stable-thresholding path: record the user's chosen colormap as
        // __origColormap and rebuild the derived alpha-masked LUT so the
        // base palette changes without disturbing visibility.
        vol.__origColormap = colormap;
        const ut = vol.__userThreshold || { lo: vol.cal_min, hi: vol.cal_max };
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold, vol.__colorRange?.min, vol.__colorRange?.max);
        if (vol.colormapNegative) vol.colormapNegative = colormap;
      } else {
        // Base volume / categorical atlas: assign directly.
        vol.colormap = colormap;
        if (vol.colormapNegative) vol.colormapNegative = colormap;
      }
      nv.updateGLVolume();
      nv.drawScene();
    },

    setOverlayColorbarVisible: (id, visible) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      // niivue defaults vol.colorbarVisible=true for every volume, which means
      // .some(colorbarVisible) is always true once volumes exist — toggling
      // off our layer alone doesn't actually hide the colorbar. Force all
      // other volumes' colorbar off so only explicit user toggles drive it.
      for (const v of nv.volumes) {
        if (v && v !== vol) v.colorbarVisible = false;
      }
      vol.colorbarVisible = visible;
      nv.opts.isColorbar = visible;
      nv.updateGLVolume();
      nv.drawScene();
    },

    setOverlayCalRange: (id, cal_min, cal_max) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      const lo = Math.min(cal_min, cal_max);
      const hi = Math.max(cal_min, cal_max);

      if (isContinuousOverlay(nv, vol)) {
        // Stable-thresholding path: store the user's logical threshold and
        // rebuild the alpha-masked LUT. vol.cal_min/cal_max stay pinned to
        // global by applyThresholdColormap so colors don't remap.
        vol.__userThreshold = { lo, hi };
        applyThresholdColormap(nv, vol, lo, hi, !!vol.__invertThreshold, vol.__colorRange?.min, vol.__colorRange?.max);
        // Bilateral symmetric sync still applies when colormapNegative is set
        // (out of scope for stable-color phase; preserved as-is).
        if (vol.colormapNegative) {
          vol.cal_maxNeg = -lo;
          vol.cal_minNeg = -hi;
        }
      } else {
        // Base / categorical: direct cal range with NiiVue's standard semantics.
        vol.cal_min = lo;
        vol.cal_max = hi;
      }
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Bin counts of a layer's voxel values across its global range, for
    // rendering a histogram under the threshold slider. Scans the full
    // volume array, so callers should compute this lazily (e.g. once when
    // the layer's advanced panel expands) rather than on every render.
    getOverlayHistogram: (id, bins = 64) => {
      const { vol } = findVolume(id);
      if (!vol) return null;
      return computeHistogram(vol, bins, vol.global_min, vol.global_max);
    },

    // Voxel count + mL currently visible under a layer's own dual-threshold
    // window — a live readout next to the threshold slider. Scans the full
    // volume array; callers should debounce (e.g. while dragging) rather
    // than call this on every slider tick.
    getOverlayThresholdVolume: (id, lo, hi, invert = false) => {
      const { vol } = findVolume(id);
      if (!vol) return null;
      // Pass the mask-zero toggle so the "N voxels / mL visible" readout counts
      // exactly what the LUT renders (zeros are drawn when the toggle is off and
      // the window spans 0).
      return thresholdedVolume(vol, lo, hi, invert, !!vol.__maskZero);
    },

    // Set the mrview-style COLOUR-SCALING range (contrast), independent of the
    // visibility window set by setOverlayCalRange. Only meaningful for
    // continuous overlays; base/categorical layers ignore it.
    setOverlayColorRange: (id, color_min, color_max) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      if (!isContinuousOverlay(nv, vol)) return;
      const min = Math.min(color_min, color_max);
      const max = Math.max(color_min, color_max);
      vol.__colorRange = { min, max };
      const ut = vol.__userThreshold || { lo: vol.cal_min, hi: vol.cal_max };
      applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold, min, max);
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Toggle inverse-threshold mode: when on, voxels OUTSIDE [lo, hi] are
    // visible, inside is hidden. With stable thresholding this is just an
    // alpha-mask flip in the unified applyThresholdColormap path.
    setOverlayInvertThreshold: (id, on) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      vol.__invertThreshold = !!on;
      if (isContinuousOverlay(nv, vol)) {
        const ut = vol.__userThreshold || { lo: vol.cal_min, hi: vol.cal_max };
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!on, vol.__colorRange?.min, vol.__colorRange?.max);
      }
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Flips the colormap direction for a continuous overlay (index 0 ↔ index 255).
    // Composes with threshold inversion — both flags are independent and additive.
    setColormapInverted: (id, on) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      vol.__colormapInverted = !!on;
      if (isContinuousOverlay(nv, vol)) {
        const ut = vol.__userThreshold || { lo: vol.cal_min, hi: vol.cal_max };
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold, vol.__colorRange?.min, vol.__colorRange?.max);
      }
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Returns stats for the threshold UI. For continuous overlays the user's
    // logical threshold lives on __userThreshold (vol.cal_min/cal_max are
    // pinned to global_min/global_max by applyThresholdColormap). The
    // colormap dropdown shows __origColormap, not the derived __thr_* key.
    getOverlayInfo: (id) => {
      const { vol } = findVolume(id);
      if (!vol) return null;
      const ut = vol.__userThreshold;
      const cr = vol.__colorRange;
      const gMin = vol.global_min ?? vol.cal_min ?? 0;
      const gMax = vol.global_max ?? vol.cal_max ?? 1;
      return {
        global_min: gMin,
        global_max: gMax,
        cal_min: ut?.lo ?? vol.cal_min ?? 0,
        cal_max: ut?.hi ?? vol.cal_max ?? 1,
        // Colour-scaling range (mrview-style, independent of the visibility
        // window above). Defaults to the full data range.
        color_min: cr?.min ?? gMin,
        color_max: cr?.max ?? gMax,
        colormap: vol.__origColormap || vol.colormap || "gray",
        // Whether the volume has any actual zero-valued voxel worth masking —
        // NOT whether its range straddles zero (see computeHasZeroVoxels).
        hasZeroVoxels: computeHasZeroVoxels(vol),
        ignoreZeroVoxels: !!vol.__maskZero,
        invertThreshold: !!vol.__invertThreshold,
        colormapInverted: !!vol.__colormapInverted,
      };
    },

    // "Mask zero voxels" toggle. A pure OVERRIDE on top of the threshold logic:
    //   ON  → value-0 voxels hidden in every mode/window.
    //   OFF → value 0 follows the threshold rules like any other value.
    // It can only ever REMOVE zeros, never reveal them.
    //
    // Implemented purely as an alpha rule in the derived LUT (see
    // applyThresholdColormap) — one mechanism, rebuilt on every threshold/invert/
    // colour-range change so it can't be dropped or inverted.
    //
    // Replaces a previous approach that rewrote value-0 voxels to NaN in vol.img.
    // That was mode-dependent and backwards: NaN clamps to a LUT endpoint, and in
    // invert ("show outside") mode the endpoints are exactly the VISIBLE region, so
    // enabling the mask made the background APPEAR. It also mutated the user's voxel
    // data, corrupting every downstream reader of vol.img (voxel/mL counts, overlap,
    // reports), and silently did nothing at all for integer-typed volumes.
    setIgnoreZeroVoxels: (id, on) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol) return;
      vol.__maskZero = !!on;
      if (!isContinuousOverlay(nv, vol)) return; // label atlases: 0 already transparent
      const ut = vol.__userThreshold || { lo: vol.cal_min, hi: vol.cal_max };
      applyThresholdColormap(
        nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold,
        vol.__colorRange?.min, vol.__colorRange?.max
      );
      nv.updateGLVolume();
      nv.drawScene();
    },

    // World-mm center of an atlas region (integer label), for the "navigate to
    // region" buttons in the atlas label list. Snapped to an in-region voxel
    // (see regionCentroidMM) and cached per label on the volume so repeat
    // clicks don't rescan. null if the label has no voxels in the loaded atlas.
    getAtlasRegionCentroidMM: (atlasId, labelValue) => {
      const nv = nvRef.current;
      if (!nv) return null;
      const vol = volumeMap.current.get(atlasId) || nv.volumes.find((v) => v?.name === atlasId);
      if (!vol?.img) return null;
      const lab = Math.round(labelValue);
      if (!(lab > 0)) return null;
      vol.__regionCentroidMM = vol.__regionCentroidMM || {};
      if (vol.__regionCentroidMM[lab] !== undefined) return vol.__regionCentroidMM[lab];
      const mm = regionCentroidMM(vol, lab);
      vol.__regionCentroidMM[lab] = mm;
      return mm;
    },

    // Return the raw NVImage for a layer id (base, overlay, atlas) so
    // callers can run voxel analysis (measurements, lesion report).
    getVolume: (id) => {
      const nv = nvRef.current;
      if (!nv) return null;
      return volumeMap.current.get(id) || nv.volumes.find((v) => v?.name === id) || null;
    },

    // Apply an intensity window to the base volume (cal_min/cal_max).
    setBaseWindow: (cal_min, cal_max) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return;
      const lo = Math.min(cal_min, cal_max);
      const hi = Math.max(cal_min, cal_max);
      nv.volumes[0].cal_min = lo;
      nv.volumes[0].cal_max = hi;
      nv.updateGLVolume();
      nv.drawScene();
    },

    // Global data range of the base volume — drives the "Full" window.
    getBaseRange: () => {
      const nv = nvRef.current;
      const v = nv?.volumes?.[0];
      if (!v) return null;
      return {
        global_min: v.global_min ?? v.cal_min ?? 0,
        global_max: v.global_max ?? v.cal_max ?? 1,
        cal_min: v.cal_min ?? 0,
        cal_max: v.cal_max ?? 1,
      };
    },

    // The base NVImage (index 0), for voxel-level analysis (e.g. robust range).
    getBaseVolume: () => nvRef.current?.volumes?.[0] || null,

    setBaseVisible: (visible) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return;
      nv.setOpacity(0, visible ? 1 : 0);
      nv.volumes[0].opacity = visible ? 1 : 0;
      nv.updateGLVolume();
      nv.drawScene();
    },

    setBaseOpacity: (opacity) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return;
      // See setOverlayOpacity above: skip nv.setOpacity()'s forced synchronous
      // updateGLVolume() and redraw ourselves.
      nv.volumes[0].opacity = opacity;
      nv.updateGLVolume();
      nv.drawScene();
    },

    setBaseColormap: (colormap) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return;
      nv.volumes[0].colormap = colormap;
      nv.updateGLVolume();
      nv.drawScene();
    },

    setBaseColorbarVisible: (on) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return;
      nv.volumes[0].colorbarVisible = !!on;
      nv.opts.isColorbar = !!on;
      nv.updateGLVolume();
      nv.drawScene();
    },

    resetToBase: async (baseCfg) => {
      const nv = nvRef.current;
      if (!nv) return false;
      try {
        // Re-load just the base from URL; overlays/meshes are preserved.
        const overlays = nv.volumes.slice(1).map((v) => v);
        for (const v of [...nv.volumes]) nv.removeVolume(v);
        volumeMap.current.clear();
        await nv.loadVolumes([{ url: baseCfg.url, colormap: baseCfg.colormap || "gray", opacity: 1 }]);
        if (nv.volumes[0]) {
          try { nv.volumes[0].name = baseCfg.id; } catch (_e) {}
          try { nv.volumes[0].colorbarVisible = false; } catch (_e) {}
          volumeMap.current.set(baseCfg.id, nv.volumes[0]);
        }
        for (const ov of overlays) nv.addVolume(ov);
        nv.updateGLVolume();
        nv.drawScene();
        return true;
      } catch (err) {
        toast.error("Failed to reset to template", { description: err?.message });
        return false;
      }
    },

    // Remove an added overlay volume by its name/id (added via addOverlayFromUrl).
    removeVolume: (id) => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        const vol = nv.volumes.find((v) => v.name === id);
        if (vol) {
          nv.removeVolume(vol);
          // Purge the 3D-render ghost of the removed overlay (see
          // resetOverlayTexture). NiiVue's removeVolume leaves the overlay
          // texture stale, so ROI/network-map deletes would otherwise linger in
          // the 3D render even though 2D slices update.
          resetOverlayTexture();
          nv.updateGLVolume();
          nv.drawScene();
        }
      } catch (_e) { /* best-effort */ }
    },
  };
}
