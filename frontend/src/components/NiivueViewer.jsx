import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { Niivue, NVMesh, SLICE_TYPE, MULTIPLANAR_TYPE, SHOW_RENDER, PEN_TYPE, cmapper } from "@niivue/niivue";
import { toast } from "sonner";
import { VISFATLAS_COLORMAP } from "@/lib/visfAtlasColormap";

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
function invertLut(lut) {
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

function applyThresholdColormap(nv, vol, lo, hi, invert = false) {
  const baseName = vol.__origColormap || vol.colormap || "warm";
  // Invert the LUT entries when the user has toggled "Invert Color Bar", so
  // the colormap direction flips while threshold alpha-masking still applies.
  let baseLut = cmapper.colormap(baseName, false);
  if (!baseLut) return;
  if (vol.__colormapInverted) baseLut = invertLut(baseLut);
  const gMin = vol.global_min ?? lo;
  const gMax = vol.global_max ?? hi;
  const range = gMax - gMin;
  if (range <= 0) return;

  const N = 256;
  const R = [], G = [], B = [], A = [], I = [];
  for (let i = 0; i < N; i++) {
    const v = gMin + (i / (N - 1)) * range;
    const o = i * 4;
    R.push(baseLut[o]);
    G.push(baseLut[o + 1]);
    B.push(baseLut[o + 2]);
    const inRange = v >= lo && v <= hi;
    // When inverting, only expose voxels that fall within the natural display
    // range captured at load time. This prevents background voxels (e.g.
    // value=0 on a polar-angle map whose cal_min=1) from becoming visible just
    // because they are technically "outside" the user's threshold window.
    const naturalMin = vol.__naturalCalMin ?? lo;
    const naturalMax = vol.__naturalCalMax ?? hi;
    const inNaturalRange = v >= naturalMin && v <= naturalMax;
    const visible = invert ? (!inRange && inNaturalRange) : (inRange && inNaturalRange);
    A.push(visible ? baseLut[o + 3] : 0);
    I.push(i);
  }
  const key = `__thr_${vol.id || vol.name || baseName}`;
  try {
    nv.addColormap(key, { R, G, B, A, I });
    vol.colormap = key;
    // Pin to global so the LUT covers the entire data range; alpha alone
    // decides visibility.
    vol.cal_min = gMin;
    vol.cal_max = gMax;
  } catch (_e) {}
}

// Continuous overlays get stable thresholding via applyThresholdColormap.
// Base volume and categorical label atlases keep NiiVue's native behavior.
function isContinuousOverlay(nv, vol) {
  if (!nv || !vol) return false;
  if (vol === nv.volumes[0]) return false;
  if (vol.colormapLabel) return false;
  return true;
}

// Colour streamlines of a loaded tract mesh.
//   scalar: a per-vertex data name carried by the .trx ("polar_angle" /
//           "eccentricity"), or "direction" (NiiVue "Local") / "uniform"
//           ("Fixed") / "Global".
// For a named scalar we locate its dpv index, pin its cal_min/cal_max to the
// requested range (so the cyclic polar_angle_360 colormap maps 1..360 around the
// wheel rather than to the bundle's own min..max), set the mesh colormap, then
// switch fiberColor to "dpv<index>". Mirrors the threshold-pinning used for the
// voxel retinotopy overlays in applyThresholdColormap().
function applyFiberScalarColor(nv, mesh, opts = {}) {
  if (!nv || !mesh) return;
  const { scalar, colormap, calMin, calMax } = opts;
  try {
    if (!scalar || scalar === "direction" || scalar === "Local") {
      nv.setMeshProperty(mesh.id, "fiberColor", "Local");
      return;
    }
    if (scalar === "Global" || scalar === "Fixed") {
      nv.setMeshProperty(mesh.id, "fiberColor", scalar);
      return;
    }
    const dpv = mesh.dpv || [];
    const idx = dpv.findIndex((d) => d.id === scalar);
    if (idx < 0) {
      // Unknown scalar — fall back to direction colouring rather than blank.
      nv.setMeshProperty(mesh.id, "fiberColor", "Local");
      return;
    }
    if (Number.isFinite(calMin)) dpv[idx].cal_min = calMin;
    if (Number.isFinite(calMax)) dpv[idx].cal_max = calMax;
    if (colormap) nv.setMeshProperty(mesh.id, "colormap", colormap);
    nv.setMeshProperty(mesh.id, "fiberColor", `dpv${idx}`);
  } catch (e) {
    console.warn("applyFiberScalarColor failed:", e);
  }
}

const NiivueViewer = forwardRef(function NiivueViewer(
  { baseVolume, sliceType = "multiplanar", onReady, onLocationChange, onError, onDoubleClickSlice },
  ref
) {
  const canvasRef = useRef(null);
  const nvRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  // Stable refs to track volumes by our application id
  const volumeMap = useRef(new Map()); // id -> NVImage
  const meshMap = useRef(new Map());   // id -> mesh
  const hiddenLabelLayers = useRef({});
  const baseRef = useRef(baseVolume);
  React.useEffect(() => { baseRef.current = baseVolume; }, [baseVolume]);
  // Keep the LATEST onDoubleClickSlice callback in a ref so the canvas
  // dblclick listener (registered once at mount) always invokes the freshest
  // closure — otherwise it captures the initial `asymmetric=false` state
  // and the swap is a no-op forever.
  const onDoubleClickSliceRef = useRef(onDoubleClickSlice);
  React.useEffect(() => { onDoubleClickSliceRef.current = onDoubleClickSlice; }, [onDoubleClickSlice]);
  // Same stale-closure guard for onLocationChange: nv.onLocationChange is
  // bound once at mount, so route through a ref to always call the freshest
  // callback (otherwise crosshair-driven features see stale state).
  const onLocationChangeRef = useRef(onLocationChange);
  React.useEffect(() => { onLocationChangeRef.current = onLocationChange; }, [onLocationChange]);
  // Holds the latest click-to-segment completion callback (set via the
  // imperative handle). Niivue fires onClickToSegment with {mm3, mL}.
  const clickToSegmentCb = useRef(null);
  const baseFileRef = useRef(null); // retains the last File loaded as base volume

  // Tracks current sliceType prop for use inside imperative setAsymmetricLayout
  // (avoids stale closure — same pattern as onDoubleClickSliceRef).
  const sliceTypeRef = useRef(sliceType);
  React.useEffect(() => { sliceTypeRef.current = sliceType; }, [sliceType]);

  // Side-panel overlay state for asymmetric mode hover UX.
  const [sideLayout, setSideLayout] = useState([]);
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const sideLayoutRef = useRef([]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const nv = new Niivue({
      backColor: [0.02, 0.02, 0.02, 1],
      crosshairColor: [0.95, 0.95, 0.95, 0.85],
      crosshairWidth: 1,
      show3Dcrosshair: true,
      isColorbar: false,
      isOrientCube: true,
      fontMinPx: 12,
      multiplanarLayout: MULTIPLANAR_TYPE.GRID,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      multiplanarPadPixels: 6,
      // Clip tractography/mesh rendering to a thin slab around the current 2D
      // slice (NiiVue default is Infinity = whole mesh on every slice, which made
      // the optic-radiation bundle float "outside the brain" on empty slices).
      // 5 mm keeps the slab strictly within the head extent everywhere — the
      // binding case is the optic radiation's occipital end (y≈-103), only ~7.6mm
      // inside the template's posterior edge (y≈-110); a thicker slab projected
      // the posterior tract onto the empty edge slice. The 3D render is unaffected.
      meshThicknessOn2D: 5,
      isResizeCanvas: false,   // manual ResizeObserver handles this; NiiVue's own handler races with it
      colorbarHeight: 0,
      clipPlaneColor: [0, 0, 0, 0],
      sliceType: SLICE_TYPE.MULTIPLANAR,
    });

    // Register a single 0..360 circular polar-angle colormap. The merged
    // benson14_polar_angle.nii.gz stores LH cortex as 1..180 (right
    // hemifield) and RH cortex as 180..360 (left hemifield); background
    // voxels are 0 and stay transparent via cal_min=1.
    //
    //    1°  = red    (LH · UVM)
    //   90°  = yellow (LH · RHM)
    //  180°  = blue   (LVM, both hemispheres meet)
    //  270°  = cyan   (RH · LHM)
    //  360°  = red    (RH · UVM)
    try {
      const N = 256;
      const build = (stops) => {
        const R = [], G = [], B = [], A = [], I = [];
        const lo = stops[0][0];
        const hi = stops[stops.length - 1][0];
        for (let i = 0; i < N; i++) {
          const x = lo + (i / (N - 1)) * (hi - lo);
          let s0 = 0;
          while (s0 < stops.length - 2 && stops[s0 + 1][0] < x) s0++;
          const s1 = s0 + 1;
          const f = (x - stops[s0][0]) / (stops[s1][0] - stops[s0][0]);
          R.push(Math.round(stops[s0][1] * (1 - f) + stops[s1][1] * f));
          G.push(Math.round(stops[s0][2] * (1 - f) + stops[s1][2] * f));
          B.push(Math.round(stops[s0][3] * (1 - f) + stops[s1][3] * f));
          // CRITICAL: LUT[0] must be alpha=0 so that values <= cal_min and the
          // background (value=0) render as TRANSPARENT, not LUT[0] color. Niivue
          // clamps below-threshold voxels to LUT[0] and uses its alpha as-is —
          // hard-coding A=255 here causes a red flood across the entire volume
          // on coronal / sagittal / 3D render (interpolated fractional values
          // between cortex and background still land in this index).
          A.push(i <= 1 ? 0 : 255);
          I.push(i);
        }
        return { R, G, B, A, I };
      };
      nv.addColormap("polar_angle_360", build([
        [1,   255,   0,   0  ],   // LH · UVM        — red
        [45,  255, 165,   0  ],   // LH · upper-right — orange
        [90,  255, 255,   0  ],   // LH · RHM        — yellow
        [135,  60, 220,  60  ],   // LH · lower-right — green
        [180,   0,   0, 255  ],   // LVM (both)      — blue
        [225,   0, 180, 200  ],   // RH · lower-left  — teal
        [270,   0, 255, 255  ],   // RH · LHM        — cyan
        [315, 200, 100, 255  ],   // RH · upper-left  — magenta
        [360, 255,   0,   0  ],   // RH · UVM        — red (wraps)
      ]));
    } catch (_e) {}

    // Register the visfAtlas (Rosenke et al. 2020) categorical colormap
    // synchronously at niivue init so user toggles can't race the addColormap.
    try { nv.addColormap("visfAtlas", VISFATLAS_COLORMAP); } catch (_e) {}
    nvRef.current = nv;
    nv.attachToCanvas(canvasRef.current);

    nv.onLocationChange = (data) => {
      try { onLocationChangeRef.current?.(data); } catch (_e) {}
    };

    // Double-click on the canvas → notify Dashboard so it can swap the
    // large slot in asymmetric layout mode.
    const canvas = canvasRef.current;
    const handleDblClick = (e) => {
      if (!onDoubleClickSliceRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      // Defer to the imperative-handle helper to map px→slice key.
      if (!nv?.customLayout?.length) return;
      const w = nv.gl?.canvas?.width || 1;
      const h = nv.gl?.canvas?.height || 1;
      const fx = px / w, fy = py / h;
      const sliceName = (st) =>
        st === SLICE_TYPE.AXIAL ? "axial"
        : st === SLICE_TYPE.CORONAL ? "coronal"
        : st === SLICE_TYPE.SAGITTAL ? "sagittal"
        : st === SLICE_TYPE.RENDER ? "render"
        : null;
      for (const entry of nv.customLayout) {
        const [x, y, ew, eh] = entry.position;
        if (fx >= x && fx <= x + ew && fy >= y && fy <= y + eh) {
          onDoubleClickSliceRef.current(sliceName(entry.sliceType));
          return;
        }
      }
    };
    canvas.addEventListener("dblclick", handleDblClick);

    const handleMouseMove = (e) => {
      if (!sideLayoutRef.current.length) {
        canvas.style.cursor = "default";
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      const w = nv.gl?.canvas?.width || 1;
      const h = nv.gl?.canvas?.height || 1;
      const fx = px / w, fy = py / h;
      let found = null;
      for (const panel of sideLayoutRef.current) {
        const [x, y, ew, eh] = panel.position;
        if (fx >= x && fx <= x + ew && fy >= y && fy <= y + eh) { found = panel.key; break; }
      }
      setHoveredSlice(found);
      canvas.style.cursor = found ? "pointer" : "default";
    };
    const handleMouseLeave = () => {
      setHoveredSlice(null);
      canvas.style.cursor = "default";
    };
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    nv.loadVolumes([{ url: baseVolume.url, colormap: baseVolume.colormap, opacity: baseVolume.opacity }])
      .then(() => {
        nv.setClipPlane([2, 0, 0]);
        // tag the base volume and force its colorbar OFF (niivue defaults
        // colorbarVisible=true on every volume — leaving the base on causes
        // toggles for overlays to misbehave because the global isColorbar
        // is derived from .some(colorbarVisible)).
        if (nv.volumes[0]) {
          try { nv.volumes[0].name = baseVolume.id; } catch (_e) {}
          try { nv.volumes[0].colorbarVisible = false; } catch (_e) {}
          volumeMap.current.set(baseVolume.id, nv.volumes[0]);
        }
        setLoaded(true);
        onReady?.(nv);
        toast.success("MNI152 template loaded");
      })
      .catch((err) => {
        toast.error("Failed to load base volume", { description: err?.message });
        onError?.(err);
      });

    // Observe container size changes and resize the canvas pixel dimensions to
    // match before redrawing. drawScene() alone is not enough — it redraws at
    // whatever canvas.width/height currently are, which are stale after a
    // minimize→maximize cycle. We set them explicitly, guard against zero-size
    // frames, and defer via requestAnimationFrame so the DOM layout is fully
    // settled before we measure.
    const container = canvas?.parentElement;
    let rafId = null;

    const resizeCanvas = () => {
      try {
        const nv = nvRef.current;
        if (!nv || !canvas) return;
        // Measure the canvas's OWN displayed (CSS) box — this is exactly what
        // NiiVue maps pointer coordinates against. Previously we sized from the
        // *container's* clientWidth, which desynced uiData.dpr from the true
        // backing-store/CSS ratio whenever the canvas's rendered box differed
        // from the container (padding/border/scrollbar/flex). That made NiiVue
        // under-scale the cursor X, leaving the right portion of every view an
        // unreachable wheel-scroll dead zone ("one hemisphere", all 3 views).
        const rect = canvas.getBoundingClientRect();
        let cssW = rect.width;
        let cssH = rect.height;
        if ((cssW <= 0 || cssH <= 0) && container) {  // fallback before first layout
          cssW = container.clientWidth;
          cssH = container.clientHeight;
        }
        if (cssW <= 0 || cssH <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        const pw = Math.round(cssW * dpr);
        const ph = Math.round(cssH * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw;
          canvas.height = ph;
        }
        // Derive dpr from the ACTUAL backing-store/CSS ratio so NiiVue's
        // CSS→device pointer mapping (uiData.dpr) always matches the rendered
        // canvas — this is what eliminates the one-sided scroll dead zone.
        nv.uiData.dpr = canvas.width / cssW;
        nv.textSizePoints();
        nv.drawScene();
        if (typeof window !== "undefined" && window.__nvScrollDebug) {
          console.debug("[resizeCanvas]", {
            canvasW: canvas.width, cssW: +cssW.toFixed(2),
            windowDpr: dpr, uiDataDpr: +nv.uiData.dpr.toFixed(4),
            realRatio: +(canvas.width / cssW).toFixed(4),
          });
        }
      } catch (_e) {}
    };

    const scheduleResize = () => {
      cancelAnimationFrame(rafId);
      // Double-rAF: the first frame lets the browser commit the new layout
      // (e.g. after a minimize→maximize), the second reads correct dimensions.
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(resizeCanvas);
      });
    };

    let ro;
    if (container && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleResize);
      ro.observe(container);
    }
    window.addEventListener("resize", scheduleResize);

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      try { canvas.removeEventListener("dblclick", handleDblClick); } catch (_e) {}
      try { canvas.removeEventListener("mousemove", handleMouseMove); } catch (_e) {}
      try { canvas.removeEventListener("mouseleave", handleMouseLeave); } catch (_e) {}
      nvRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const nv = nvRef.current;
    if (!nv || !loaded) return;
    const map = {
      multiplanar: SLICE_TYPE.MULTIPLANAR,
      axial: SLICE_TYPE.AXIAL,
      coronal: SLICE_TYPE.CORONAL,
      sagittal: SLICE_TYPE.SAGITTAL,
      render: SLICE_TYPE.RENDER,
    };
    nv.setSliceType(map[sliceType] ?? SLICE_TYPE.MULTIPLANAR);
  }, [sliceType, loaded]);

  // Helper: get volume by id from our internal map (more reliable than name match)
  const findVolume = (id) => {
    const nv = nvRef.current;
    if (!nv) return { vol: null, idx: -1 };
    const vol = volumeMap.current.get(id);
    if (!vol) return { vol: null, idx: -1 };
    const idx = nv.volumes.indexOf(vol);
    return { vol, idx };
  };

  useImperativeHandle(ref, () => ({
    getNiivue: () => nvRef.current,

    replaceBaseVolume: async (file) => {
      const nv = nvRef.current;
      if (!nv) return false;
      try {
        // Remove all current volumes (and re-add overlays after)
        const overlays = nv.volumes.slice(1).map((v) => v);
        for (const v of [...nv.volumes]) nv.removeVolume(v);
        volumeMap.current.clear();

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
        }
        // Re-add previous overlays
        for (const ov of overlays) nv.addVolume(ov);
        baseFileRef.current = file;
        toast.success("Base volume replaced", { description: file.name });
        return true;
      } catch (err) {
        toast.error("Failed to replace base volume", { description: err?.message });
        return false;
      }
    },

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
          // NiiVue internally uses a falsy check for the opacity URL option, so
          // opacity:0 is silently skipped (0 is falsy) and the volume loads at its
          // default opacity instead of invisible. Explicitly enforce the requested
          // opacity here — mirrors the setOverlayOpacity pattern — so that
          // silently-loaded atlases (e.g. Jülich for Eloquent Warn) truly have no
          // visual impact on the canvas.
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
            vol.__origColormap = layerCfg.colormap || vol.colormap || "warm";
            vol.__naturalCalMin = vol.cal_min;
            vol.__naturalCalMax = vol.cal_max;
            vol.__userThreshold = { lo: vol.cal_min, hi: vol.cal_max };
            applyThresholdColormap(nv, vol, vol.cal_min, vol.cal_max, false);
            nv.updateGLVolume();
          }
          volumeMap.current.set(layerCfg.id, vol);
        }
        return vol;
      } catch (err) {
        toast.error(`Failed to load ${layerCfg.name}`, { description: err?.message });
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
          // Initialise stable-color thresholding for continuous overlays.
          if (isContinuousOverlay(nv, vol)) {
            vol.__origColormap = opts.colormap || vol.colormap || "warm";
            vol.__naturalCalMin = vol.cal_min;
            vol.__naturalCalMax = vol.cal_max;
            vol.__userThreshold = { lo: vol.cal_min, hi: vol.cal_max };
            applyThresholdColormap(nv, vol, vol.cal_min, vol.cal_max, false);
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
      const baseId = baseRef.current?.id || nv.volumes[0]?.name || "mni152";
      const baseUrl = baseRef.current?.url || nv.volumes[0]?.url;
      // 1. Remove ALL meshes (incl. tracts and inflated brain)
      for (const mesh of [...nv.meshes]) {
        try { nv.removeMesh(mesh); } catch (_e) {}
      }
      meshMap.current.clear();
      // 2. Clear drawing
      try {
        nv.drawClearAllUndoBitmaps();
        if (nv.drawBitmap) nv.drawBitmap.fill(0);
        nv.refreshDrawing(true);
      } catch (_e) {}
      // 3. Reload only the base volume to wipe overlay GL textures
      try {
        await nv.loadVolumes([{ url: baseUrl, colormap: "gray", opacity: 1.0 }]);
        if (nv.volumes[0]) {
          try { nv.volumes[0].name = baseId; } catch (_e) {}
        }
        volumeMap.current.clear();
        hiddenLabelLayers.current = {};
        if (nv.volumes[0]) volumeMap.current.set(nv.volumes[0].name, nv.volumes[0]);
      } catch (_e) {
        // Fallback per-volume removal
        const toRemove = nv.volumes.slice(1).map((v) => v);
        for (const v of toRemove) { try { nv.removeVolume(v); } catch (_e2) {} }
      }
      // 4. Full GL refresh
      try {
        nv.updateGLVolume();
        nv.drawScene();
      } catch (_e) {}
    },

    setOverlayOpacity: (id, opacity) => {
      const nv = nvRef.current;
      const { idx, vol } = findVolume(id);
      if (!nv || idx < 0 || !vol) return;
      nv.setOpacity(idx, opacity);
      vol.opacity = opacity; // ensure 3D ray-cast picks it up
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
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold);
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
        applyThresholdColormap(nv, vol, lo, hi, !!vol.__invertThreshold);
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
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!on);
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
        applyThresholdColormap(nv, vol, ut.lo, ut.hi, !!vol.__invertThreshold);
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
      return {
        global_min: vol.global_min ?? vol.cal_min ?? 0,
        global_max: vol.global_max ?? vol.cal_max ?? 1,
        cal_min: ut?.lo ?? vol.cal_min ?? 0,
        cal_max: ut?.hi ?? vol.cal_max ?? 1,
        colormap: vol.__origColormap || vol.colormap || "gray",
        // signed = both negative and positive values present, with a small
        // tolerance to ignore floating-point interpolation drift around 0
        // (e.g. polar-angle maps that read -0.001 from .mgz interpolation).
        isSigned:
          (vol.global_min ?? 0) < -1e-3 && (vol.global_max ?? 0) > 1e-3,
        ignoreZeroVoxels: vol.__zeroMaskCache !== undefined,
        invertThreshold: !!vol.__invertThreshold,
      };
    },

    // Mask out voxels whose value is EXACTLY 0.
    //
    // True zero-only masking: walk the voxel buffer, replace 0 with NaN, cache
    // the affected indices. NaN fails all GLSL comparisons in the shader, so
    // those voxels are discarded (alpha=0) regardless of threshold, colormap,
    // or any other rendering state. Toggle OFF restores the original zeros.
    //
    // This is the ONLY runtime mechanism that achieves the strict requirement:
    //   if (voxelValue === 0) transparent  else render per existing threshold rules
    //
    // Does NOT touch cal_min, cal_max, cal_minNeg, cal_maxNeg, colormap,
    // colormapNegative, colormapType, opacity, or any other rendering state.
    // Threshold / colormap / invert / bilateral logic is completely unaffected.
    setIgnoreZeroVoxels: (id, on) => {
      const nv = nvRef.current;
      const { vol } = findVolume(id);
      if (!nv || !vol || !vol.img) return;

      // Integer-typed volumes (Int8/Int16/Uint8/Uint16/Int32/Uint32) can't hold
      // NaN. For these, fall back to a UI-only toggle so the rest of the app
      // (slider state, colorbar, threshold logic) is never corrupted.
      const arr = vol.img;
      const isFloatArr = arr instanceof Float32Array || arr instanceof Float64Array;

      if (on) {
        if (vol.__zeroMaskCache) return; // idempotent: already masked
        if (!isFloatArr) {
          vol.__zeroMaskCache = []; // sentinel: UI toggled, no voxel mutation
          return;
        }
        const cache = [];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === 0) {
            cache.push(i);
            arr[i] = NaN;
          }
        }
        vol.__zeroMaskCache = cache;
        nv.updateGLVolume();
        nv.drawScene();
      } else {
        const cache = vol.__zeroMaskCache;
        if (!cache) return;
        if (isFloatArr) {
          for (let i = 0; i < cache.length; i++) arr[cache[i]] = 0;
        }
        delete vol.__zeroMaskCache;
        nv.updateGLVolume();
        nv.drawScene();
      }
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
      nv.setOpacity(0, opacity);
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

    // ===== Asymmetric layout (1 large + 3 small stacked side views) =====
    // Niivue lets us position each slice via nv.customLayout: an array of
    // entries with sliceType + position [x, y, w, h] in fractional canvas
    // coordinates. We expose a setter so Dashboard can flip in/out of
    // asymmetric mode and swap which slice is large.
    setAsymmetricLayout: (largeSlice /* "axial"|"coronal"|"sagittal"|"render"|null */) => {
      const nv = nvRef.current;
      if (!nv) return;
      const ST = SLICE_TYPE;
      const sliceMap = {
        axial: ST.AXIAL,
        coronal: ST.CORONAL,
        sagittal: ST.SAGITTAL,
        render: ST.RENDER,
        multiplanar: ST.MULTIPLANAR,
      };
      if (!largeSlice) {
        nv.customLayout = [];
        // Restore whatever slice type was active before asymmetric mode.
        // Hardcoding MULTIPLANAR here is the bug — use the tracked ref instead.
        nv.setSliceType(sliceMap[sliceTypeRef.current] ?? ST.MULTIPLANAR);
        nv.drawScene();
        setSideLayout([]);
        sideLayoutRef.current = [];
        setHoveredSlice(null);
        return;
      }
      const allKeys = ["axial", "coronal", "sagittal", "render"];
      const sides = allKeys.filter((k) => k !== largeSlice);
      // Large slice on left ~78% width, full height; three small side views
      // stacked vertically on the RIGHT (~22% width)
      const layout = [
        { sliceType: sliceMap[largeSlice], position: [0.0, 0.0, 0.78, 1.0] },
      ];
      const sideH = 1 / sides.length;
      sides.forEach((k, i) => {
        layout.push({
          sliceType: sliceMap[k],
          position: [0.78, i * sideH, 0.22, sideH],
        });
      });
      nv.customLayout = layout;
      nv.setSliceType(ST.MULTIPLANAR);
      nv.drawScene();
      const sideData = sides.map((k, i) => ({
        key: k,
        label: k.charAt(0).toUpperCase() + k.slice(1),
        position: [0.78, i * sideH, 0.22, sideH],
      }));
      setSideLayout(sideData);
      sideLayoutRef.current = sideData;
    },

    // Identify which custom-layout slot the user clicked on (used to swap
    // large/side views on double-click). Returns the slice key
    // ("axial"|"coronal"|"sagittal"|"render") or null.
    getSliceAtCanvasPx: (px, py) => {
      const nv = nvRef.current;
      if (!nv?.customLayout?.length) return null;
      const w = nv.gl?.canvas?.width || 1;
      const h = nv.gl?.canvas?.height || 1;
      const fx = px / w, fy = py / h;
      const ST = SLICE_TYPE;
      const sliceName = (st) =>
        st === ST.AXIAL ? "axial"
        : st === ST.CORONAL ? "coronal"
        : st === ST.SAGITTAL ? "sagittal"
        : st === ST.RENDER ? "render"
        : null;
      for (const entry of nv.customLayout) {
        const [x, y, ew, eh] = entry.position;
        if (fx >= x && fx <= x + ew && fy >= y && fy <= y + eh) {
          return sliceName(entry.sliceType);
        }
      }
      return null;
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

    // ===== Mesh / tract loading =====
    // Uses nv.loadMeshes with a blob URL + explicit `name` carrying the
    // original extension. This is the path niivue actually displays
    // tractography streamlines (.trk/.tck) through — NVMesh.loadFromFile +
    // addMesh loads the data but skips the post-load scene/camera setup the
    // tractography renderer needs, leaving streamlines invisible.
    addMeshFromFile: async (file, opts = {}) => {
      const nv = nvRef.current;
      if (!nv) return null;
      try {
        const id = opts.name || file.name;
        const rgba = opts.rgba255 || [255, 165, 0, 255];
        const ext = file.name.match(/\.[^./]+(\.gz)?$/i)?.[0] || "";
        const niivueName = id.toLowerCase().endsWith(ext.toLowerCase()) ? id : `${id}${ext}`;
        opts.onProgress?.("Parsing streamlines…");
        // Read the File directly via NVMesh.loadFromFile (FileReader-based, no
        // fetch). This avoids the blob-URL fetch path in nv.loadMeshes, which
        // fails ("Failed to fetch") on some Electron/large-file cases.
        const mesh = await NVMesh.loadFromFile({
          file,
          gl: nv.gl,
          name: niivueName,
          rgba255: rgba,
          opacity: opts.opacity ?? 1.0,
        });
        opts.onProgress?.("Building scene…");
        if (!mesh) {
          toast.error(`Mesh ${file.name} loaded but not displayed`);
          opts.onError?.("Mesh loaded but not rendered — check file format");
          return null;
        }
        nv.addMesh(mesh);
        try { mesh.name = id; } catch (_e) {}
        if (opts.fiberScalar) {
          applyFiberScalarColor(nv, mesh, opts.fiberScalar);
        } else if (opts.colorByDirection) {
          try { nv.setMeshProperty(mesh.id, "fiberColor", "Local"); } catch (_e) {}
        }
        meshMap.current.set(id, mesh);
        nv.drawScene();
        return mesh;
      } catch (err) {
        console.error("addMeshFromFile failed:", err);
        toast.error(`Failed to load mesh ${file.name}`, { description: err?.message });
        opts.onError?.(err?.message || "Unknown error");
        return null;
      }
    },

    // ===== Preloaded tract loading (by URL) =====
    // Used to auto-load bundled tractography (e.g. the optic-radiation .trx in
    // public/tracts) on startup. Fetches the URL into a File and reuses the same
    // NVMesh.loadFromFile display path as addMeshFromFile (the blob-URL fetch
    // inside nv.loadMeshes is unreliable for large/Electron cases). Pass
    // opts.fiberScalar = { scalar, colormap, calMin, calMax } to colour by a
    // per-vertex retinotopy scalar immediately on load.
    addMeshFromUrl: async (url, opts = {}) => {
      const nv = nvRef.current;
      if (!nv) return null;
      const id = opts.name || url.split("/").pop();
      // Idempotent: if already loaded, just return the existing mesh.
      if (meshMap.current.has(id)) return meshMap.current.get(id);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        const blob = await resp.blob();
        const fname = url.split("/").pop() || `${id}.trx`;
        const file = new File([blob], fname, { type: "application/octet-stream" });
        const ext = fname.match(/\.[^./]+(\.gz)?$/i)?.[0] || "";
        const niivueName = id.toLowerCase().endsWith(ext.toLowerCase()) ? id : `${id}${ext}`;
        const mesh = await NVMesh.loadFromFile({
          file,
          gl: nv.gl,
          name: niivueName,
          rgba255: opts.rgba255 || [255, 165, 0, 255],
          opacity: opts.opacity ?? 1.0,
        });
        if (!mesh) {
          opts.onError?.("Tract loaded but not rendered — check file format");
          return null;
        }
        nv.addMesh(mesh);
        try { mesh.name = id; } catch (_e) {}
        if (opts.fiberScalar) {
          applyFiberScalarColor(nv, mesh, opts.fiberScalar);
        } else if (opts.colorByDirection) {
          try { nv.setMeshProperty(mesh.id, "fiberColor", "Local"); } catch (_e) {}
        }
        meshMap.current.set(id, mesh);
        nv.drawScene();
        return mesh;
      } catch (err) {
        console.error("addMeshFromUrl failed:", err);
        opts.onError?.(err?.message || "Unknown error");
        return null;
      }
    },

    // Re-colour an already-loaded tract by a per-vertex scalar (or direction).
    setMeshScalarColor: (id, fiberScalar) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      applyFiberScalarColor(nv, mesh, fiberScalar || {});
      nv.drawScene();
    },

    // (Inflated-brain mesh support removed per user request — surface
    // projection of volumetric overlays was unreliable and the UI was
    // dropped from the dashboard.)

    setMeshFiberColor: (id, mode) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      try { nv.setMeshProperty(mesh.id, "fiberColor", mode); } catch (_e) {}
    },

    setMeshOpacity: (id, opacity) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      try {
        const idx = nv.meshes.indexOf(mesh);
        if (idx >= 0) {
          nv.setMeshProperty(mesh.id, "opacity", opacity);
          nv.drawScene();
        }
      } catch (_e) {}
    },

    removeMesh: (id) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      try { nv.removeMesh(mesh); } catch (_e) {}
      meshMap.current.delete(id);
    },

    // Remove an added overlay volume by its name/id (added via addOverlayFromUrl).
    removeVolume: (id) => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        const vol = nv.volumes.find((v) => v.name === id);
        if (vol) nv.removeVolume(vol);
      } catch (_e) { /* best-effort */ }
    },

    setCrosshairMM: (x, y, z) => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        // niivue's public-ish API: mm2frac → set scene.crosshairPos → drawScene.
        const frac = nv.mm2frac?.([x, y, z]);
        if (frac && nv.scene) {
          nv.scene.crosshairPos = frac;
          nv.drawScene();
        }
      } catch (_e) {}
    },

    setClipPlane: (depth, az = 0, el = 0) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.setClipPlane([depth, az, el]);
      nv.opts.clipPlaneColor = [0, 0, 0, 0];
      nv.drawScene();
    },

    setCrosshair: (visible) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.opts.show3Dcrosshair = visible;
      // crosshairWidth=0 hides the crosshair in all 2D slice views too.
      // Preserve the configured width when turning back on.
      if (!visible) {
        nv.opts.crosshairWidth = 0;
      } else {
        // Restore the last user-set width (stored on opts directly when setCrosshairStyle runs).
        nv.opts.crosshairWidth = nv.opts.__crosshairWidthSaved ?? 1;
      }
      nv.drawScene();
    },

    setCrosshairStyle: ({ width, color } = {}) => {
      const nv = nvRef.current;
      if (!nv) return;
      if (typeof width === "number") {
        nv.opts.__crosshairWidthSaved = width;
        nv.opts.crosshairWidth = width;
      }
      if (color) {
        nv.opts.crosshairColor = color; // [r,g,b,a] 0–1
      }
      nv.drawScene();
    },

    saveScreenshot: () => {
      nvRef.current?.saveScene("neurovue-scene.png");
    },

    // ===== Drawing API =====
    setDrawingEnabled: (enabled, hideCrosshair = true) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.setDrawingEnabled(enabled);
      if (enabled && hideCrosshair) {
        nv.opts.show3Dcrosshair = false;
        nv.opts.crosshairWidth = 0;
        nv.opts.crosshairColor = [0, 0, 0, 0];
      } else {
        nv.opts.show3Dcrosshair = true;
        nv.opts.crosshairWidth = 1;
        nv.opts.crosshairColor = [0.95, 0.95, 0.95, 0.85];
      }
      nv.drawScene();
    },
    // ===== Semi-automatic segmentation (Niivue native click-to-segment) =====
    // Niivue grows a region by intensity similarity from the clicked voxel
    // and writes it into the draw bitmap (orientation handled internally),
    // then fires onClickToSegment with the segmented volume in mm3 / mL.
    setSegmentCallback: (cb) => { clickToSegmentCb.current = cb; },
    setClickToSegment: (on, opts = {}) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.opts.clickToSegment = !!on;
      if (on) {
        nv.setDrawingEnabled(true);
        nv.opts.show3Dcrosshair = false;
        nv.opts.clickToSegmentAutoIntensity = opts.autoIntensity ?? true;
        // percent = intensity tolerance band around the seed (0..1).
        nv.opts.clickToSegmentPercent = typeof opts.percent === "number" ? opts.percent : 0.1;
        nv.opts.clickToSegmentIs2D = !!opts.is2D;
        nv.opts.clickToSegmentMaxDistanceMM =
          typeof opts.maxDistanceMM === "number" && opts.maxDistanceMM > 0
            ? opts.maxDistanceMM
            : Number.POSITIVE_INFINITY;
        if (typeof opts.penValue === "number") nv.setPenValue(opts.penValue, true);
        nv.onClickToSegment = (data) => {
          try { clickToSegmentCb.current?.(data); } catch (_e) {}
        };
      } else {
        nv.opts.clickToSegment = false;
      }
      nv.drawScene();
    },
    setSegmentTolerance: (percent) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.opts.clickToSegmentPercent = percent;
    },

    setCrosshairWhileDrawing: (visible) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.opts.show3Dcrosshair = visible;
      nv.opts.crosshairWidth = visible ? 1 : 0;
      nv.opts.crosshairColor = visible
        ? [0.95, 0.95, 0.95, 0.85]
        : [0, 0, 0, 0];
      nv.drawScene();
    },
    setPenValue: (value, filled = false) => nvRef.current?.setPenValue(value, filled),
    setPenType: () => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.penType = PEN_TYPE.PEN;
    },
    setDrawOpacity: (opacity) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.drawOpacity = opacity;
      nv.drawScene();
    },
    drawUndo: () => { try { nvRef.current?.drawUndo(); } catch (_e) {} },
    drawClear: () => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        nv.drawClearAllUndoBitmaps();
        if (nv.drawBitmap) nv.drawBitmap.fill(0);
        nv.refreshDrawing(true);
      } catch (_e) {}
    },
    saveDrawing: async (filename = "drawn_lesion.nii.gz") => {
      const nv = nvRef.current;
      if (!nv) return false;
      try {
        await nv.saveImage({ filename, isSaveDrawing: true });
        return true;
      } catch (err) {
        toast.error("Failed to save drawing", { description: err?.message });
        return false;
      }
    },
    // Return the gzipped NIfTI bytes of the current drawing without triggering a
    // download. NiiVue's saveImage returns the Uint8Array when filename is empty;
    // used to upload the lesion to the server.
    getDrawingBytes: async () => {
      const nv = nvRef.current;
      if (!nv) return null;
      try {
        const bytes = await nv.saveImage({ filename: "", isSaveDrawing: true });
        return bytes instanceof Uint8Array ? bytes : null;
      } catch (err) {
        toast.error("Failed to read drawing", { description: err?.message });
        return null;
      }
    },

    // Expose the in-memory scratch drawing as a lightweight volume-like object
    // ({ img, dimsRAS, matRAS }) compatible with lib/measure + lib/volumeAnalysis
    // helpers — lets measurements run on an unsaved drawing.
    getDrawingAsVolume: () => {
      const nv = nvRef.current;
      if (!nv?.drawBitmap || !nv.back) return null;
      return {
        img: nv.drawBitmap,
        dimsRAS: nv.back.dimsRAS,
        dims: nv.back.dims,
        matRAS: nv.back.matRAS,
      };
    },

    // Non-destructive morphological ops on the in-memory scratch drawing
    // (nv.drawBitmap). op ∈ "dilate" | "erode" | "smooth". Each op registers an
    // undo bitmap first, so drawUndo() reverts it. Labels are preserved: dilate
    // grows into background using the max neighbouring label; erode removes any
    // foreground voxel touching background; smooth is a 3×3×3 majority filter.
    drawMorph: (op = "dilate") => {
      const nv = nvRef.current;
      if (!nv || !nv.drawBitmap) {
        toast.error("Nothing drawn yet");
        return false;
      }
      const dims = nv.back?.dims;
      const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
      const src = nv.drawBitmap;
      if (!nx || !ny || !nz || src.length !== nx * ny * nz) {
        toast.error("Drawing grid unavailable");
        return false;
      }
      const idx = (i, j, k) => i + nx * (j + ny * k);
      const out = new Uint8Array(src.length);
      const nb6 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

      try {
        nv.drawAddUndoBitmap?.();
      } catch (_e) { /* undo is best-effort */ }

      if (op === "dilate") {
        out.set(src);
        for (let k = 0; k < nz; k++)
          for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
              const p = idx(i, j, k);
              if (src[p]) continue; // keep existing foreground
              let best = 0;
              for (const [di, dj, dk] of nb6) {
                const ii = i + di, jj = j + dj, kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                const v = src[idx(ii, jj, kk)];
                if (v > best) best = v;
              }
              out[p] = best;
            }
      } else if (op === "erode") {
        for (let k = 0; k < nz; k++)
          for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
              const p = idx(i, j, k);
              if (!src[p]) continue;
              let keep = true;
              for (const [di, dj, dk] of nb6) {
                const ii = i + di, jj = j + dj, kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz || !src[idx(ii, jj, kk)]) {
                  keep = false;
                  break;
                }
              }
              out[p] = keep ? src[p] : 0;
            }
      } else { // smooth: 3×3×3 majority vote (fills holes, removes speckle)
        for (let k = 0; k < nz; k++)
          for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
              let count = 0, best = 0;
              const votes = {};
              for (let dk = -1; dk <= 1; dk++)
                for (let dj = -1; dj <= 1; dj++)
                  for (let di = -1; di <= 1; di++) {
                    const ii = i + di, jj = j + dj, kk = k + dk;
                    if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                    const v = src[idx(ii, jj, kk)];
                    if (v) {
                      count++;
                      votes[v] = (votes[v] || 0) + 1;
                      if (votes[v] > (votes[best] || 0)) best = v;
                    }
                  }
              out[idx(i, j, k)] = count >= 14 ? best : 0;
            }
      }

      src.set(out);
      try { nv.refreshDrawing(true); } catch (_e) { /* redraw is best-effort */ }
      return true;
    },
  }));

  return (
    <div className="relative h-full w-full bg-black" data-testid="niivue-viewer">
      <canvas ref={canvasRef} className="niivue-canvas" id="niivue-canvas" data-testid="niivue-canvas" style={{ width: "100%", height: "100%", display: "block" }} />
      {sideLayout.length > 0 && (
        <div className="absolute inset-0 pointer-events-none">
          {sideLayout.map(({ key, label, position }) => {
            const [x, y, w, h] = position;
            const isHovered = hoveredSlice === key;
            return (
              <div
                key={key}
                className={`absolute transition-all duration-150 ${
                  isHovered ? "border border-cyan-400/70" : "border border-transparent"
                }`}
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
              >
                <span className="absolute top-1.5 left-1.5 text-[9px] font-semibold uppercase tracking-widest text-white/50 bg-black/40 px-1.5 py-0.5 rounded-sm select-none">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div className="h-1 w-32 bg-zinc-900 overflow-hidden">
              <div className="h-full w-1/3 bg-white animate-pulse" />
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
              loading mni152 template…
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default NiivueViewer;
