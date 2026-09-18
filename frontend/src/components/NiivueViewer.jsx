import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { Niivue, NVMesh, NVImage, SLICE_TYPE, MULTIPLANAR_TYPE, SHOW_RENDER, PEN_TYPE, DRAG_MODE, NVUtilities } from "@niivue/niivue";
import { toast } from "sonner";
import { VISFATLAS_COLORMAP } from "@/lib/visfAtlasColormap";
import { interpolateSlices, computeErasedFootprint } from "@/lib/drawInterpolate";
import { DrawHistory, rleEncode, rleDecode } from "@/lib/drawHistory";
import { histogram as computeHistogram } from "@/lib/volumeAnalysis";
import { thresholdedVolume } from "@/lib/measure";
import { installTractRenderer, uninstallTractRenderer } from "@/lib/gl/tractRenderer";
import { DEFAULT_TRACT_RENDER, sliderToThicknessMM } from "@/lib/gl/tractSettings";
import { installVolumeClipPass, uninstallVolumeClipPass } from "@/lib/gl/volumeClip";
import { installCustomRenderShader, uninstallCustomRenderShader } from "@/lib/gl/volumeRenderShader";
import { MULTIPLANAR_GRID_LAYOUT } from "@/lib/viewer/layoutConstants";
import { applyThresholdColormap, isContinuousOverlay, computeHasZeroVoxels, fixGlobalMinMax } from "@/lib/viewer/colormapUtils";
import { applyFiberScalarColor, MEASURE_COLORS_RGB, MEASURE_NBANDS, appendSphere, appendCylinder } from "@/lib/viewer/meshGeometry";
import { buildViewerContext } from "@/lib/viewer/context";
import { createMeshApi } from "@/lib/viewer/meshApi";
import { createNavigationApi } from "@/lib/viewer/navigation";
import { createMarkersApi } from "@/lib/viewer/markers";
import { createLayoutApi } from "@/lib/viewer/layout";
import { createVolumeApi } from "@/lib/viewer/volumeApi";
import { createFrameApi } from "@/lib/viewer/frameApi";
import { createScreenshotApi } from "@/lib/viewer/screenshot";
import { createSegmentationApi } from "@/lib/viewer/segmentation";
import { createDrawingApi } from "@/lib/viewer/drawingApi";
import { createPointerMath } from "@/lib/viewer/pointerMath";
import { createZoomMath } from "@/lib/viewer/zoomMath";

const NiivueViewer = forwardRef(function NiivueViewer(
  { baseVolume, sliceType = "multiplanar", activeOrientation = 0, onReady, onLocationChange, onError, onDoubleClickSlice, onClipRotateDelta, onFrameChange, clipEnabled = false, tractRender = DEFAULT_TRACT_RENDER, drawToolLabel = "" },
  ref
) {
  const canvasRef = useRef(null);
  const nvRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  // Stable refs to track volumes by our application id
  const volumeMap = useRef(new Map()); // id -> NVImage
  const meshMap = useRef(new Map());   // id -> mesh
  const hiddenLabelLayers = useRef({});
  // Measurement point markers (ruler A/B, midline landmark): a single
  // connectome-derived mesh holds the 3D spheres; measurementPointsRef is the
  // source of truth the 2D-overlay and 3D-hover-label projections read from.
  const measurementMeshRef = useRef(null);
  const measurementPointsRef = useRef([]); // [{id,mm,label}]
  const [measure2D, setMeasure2D] = useState([]);     // [{id,label,colorIdx,x,y}] CSS px
  const [measureHover, setMeasureHover] = useState(null); // {id,label,colorIdx,x,y} | null
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
  // Same stale-closure guard for onFrameChange (4D frame stepper): nv.onFrameChange
  // is bound once at mount too.
  const onFrameChangeRef = useRef(onFrameChange);
  React.useEffect(() => { onFrameChangeRef.current = onFrameChange; }, [onFrameChange]);
  // Item 102 (6d) / item 104: fires (deltaAzDeg, deltaElDeg) for a right-drag
  // over the 3D render tile. DELTAS, not absolutes: Dashboard folds them into
  // clipAz/clipEl with a functional setState, so the drag always continues
  // from whatever the sliders currently say (moving a slider mid-session no
  // longer snaps back to the last drag's values on the next drag). Deliberately
  // NOT wired to nv.onAzimuthElevationChange — the render camera (left-drag)
  // and the clip plane (right-drag) are now fully independent.
  const onClipRotateDeltaRef = useRef(onClipRotateDelta);
  React.useEffect(() => { onClipRotateDeltaRef.current = onClipRotateDelta; }, [onClipRotateDelta]);
  // Right-drag over the render tile only rotates the clip plane while the
  // plane is actually engaged; with it off, right-drag there does nothing.
  const clipEnabledRef = useRef(clipEnabled);
  React.useEffect(() => { clipEnabledRef.current = clipEnabled; }, [clipEnabled]);
  // Holds the latest click-to-segment completion callback (set via the
  // imperative handle). Niivue fires onClickToSegment with {mm3, mL}.
  const clickToSegmentCb = useRef(null);
  const baseFileRef = useRef(null); // retains the last File loaded as base volume
  // mrview-parity tractography render state, read live inside the drawMesh3D
  // wrapper (lib/gl/tractRenderer.js) every frame — changing it never
  // rebuilds a buffer, only its uniform reads change. Seeded from
  // tractSettings.js's DEFAULT_TRACT_RENDER rather than an inline literal; thicknessMM
  // is derived once here and again on every setTractRenderOptions/thicknessUI
  // patch (sliderToThicknessMM), since the renderer reads thicknessMM, not
  // thicknessUI.
  const tractRenderStateRef = useRef({
    ...DEFAULT_TRACT_RENDER,
    thicknessMM: sliderToThicknessMM(DEFAULT_TRACT_RENDER.thicknessUI),
  });

  // Coalesces GL texture rebuild + redraw into a single call per animation
  // frame. withVolumeUpdate=true is for callers that mutated a volume's GL
  // texture (cal_min/cal_max, colormap, etc.) and need updateGLVolume() before
  // the redraw — that rebuild is genuinely expensive, so it stays batched to
  // at most once per rAF tick. (No current caller actually passes true — every
  // real call site below passes false — but the batching is kept here for
  // whichever future caller needs it, per the original "sliders firing
  // updateGLVolume() every tick made drags laggy" rationale.)
  //
  // SMALL-FIXES item 117 ("new buttons don't update the canvas until the
  // canvas is interacted with"): withVolumeUpdate=false used to ALSO defer
  // through requestAnimationFrame, sharing the same coalescing as the
  // (unused) true path. Every current caller passes false — clip plane, drag
  // mode, orientation labels, radiological convention, tract render options,
  // per-tract clip/visible/opacity, wheel/right-drag zoom — and every one of
  // them could exhibit the deferred-frame bug below: when the call is the tail
  // end of a React effect (Dashboard
  // pushing a prop into the viewer via the imperative handle, not a raw
  // pointer event), the deferred rAF frequently never visibly lands, so the
  // canvas only picks up the change once an unrelated canvas interaction
  // triggers niivue's OWN native drawScene() and incidentally reads the
  // already-updated state. A3.4 fixed this for one control (meshThicknessOn2D)
  // by having that effect call nv.drawScene() directly instead of routing
  // through here. This generalizes the same fix to every withVolumeUpdate=false
  // caller in one place instead of requiring each new button to remember to
  // route around scheduleRedraw. It does NOT reintroduce the drag jank the
  // batching was written for: that jank was specifically updateGLVolume()'s
  // texture reupload, which no false-path caller ever triggers — drawScene()
  // alone, called synchronously even on every tick of a rapid slider/right-
  // drag (e.g. tract opacity, zoom), costs one extra GPU draw per pointer
  // event, not a texture rebuild, matching how niivue's own native drag
  // handlers already redraw synchronously per pointermove.
  const redrawRafRef = useRef(null);
  const pendingVolumeUpdateRef = useRef(false);
  const scheduleRedraw = (withVolumeUpdate = true) => {
    const nv = nvRef.current;
    if (!nv) return;
    if (!withVolumeUpdate) {
      try { nv.drawScene(); } catch (_e) {}
      return;
    }
    pendingVolumeUpdateRef.current = true;
    if (redrawRafRef.current != null) return;
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = null;
      try {
        if (pendingVolumeUpdateRef.current) {
          pendingVolumeUpdateRef.current = false;
          nv.updateGLVolume();
        }
        nv.drawScene();
      } catch (_e) {}
    });
  };
  // Drawing coordination: fired when a stroke starts on the canvas (draw-start),
  // and after a stroke commits (draw-commit) with interpolation availability.
  const drawStartCb = useRef(null);
  const drawCommitCb = useRef(null);
  // History of recently drawn slices: { axCorSag, slice, label }, newest last.
  const lastDraws = useRef([]);
  // Undo/redo history for the draw bitmap (custom — niivue's ring has no redo).
  const drawHistory = useRef(new DrawHistory());
  const historyCb = useRef(null); // fires { canUndo, canRedo } on any change
  // Fires (no args) whenever the draw bitmap itself changes — strokes, undo/redo,
  // interpolate, morph, clear, load. A SEPARATE slot from historyCb/drawCommitCb
  // (both owned by DrawingPanel) so Dashboard can subscribe without either
  // clobbering the other. Used by the retinotopy analysis to recompute against
  // the live drawing.
  const drawChangeCb = useRef(null);
  // Pre-stroke snapshot, stashed on pointerdown and committed on draw-commit so
  // a click that doesn't paint anything creates no bogus undo entry.
  const pendingStrokeSnapshot = useRef(null);
  // Item 12: crosshairPos captured at the start of a native Pen/Cutout stroke,
  // used to freeze the other 2D planes while painting with the crosshair
  // hidden. niivue moves crosshairPos to the paint cursor mid-stroke, which
  // re-slices coronal/sagittal; when the crosshair is OFF we restore it so the
  // planes stay put (with the crosshair ON we leave niivue's move alone, so the
  // planes still follow the cursor — matching "should move if crosshair on").
  const drawFreezeCrosshairRef = useRef(null);
  // Brush radius in voxels (1..10) — drives the true-3D Brush/erase sphere
  // radius now (item 66/69 redesign); no longer affects Pen/Eraser.
  const brushRadiusRef = useRef(1);
  // Which left-click tool is selected in the Draw panel: "pen" | "brush" |
  // "eraser" | "cutout" (item 70 restructure). Pen/Cutout are native
  // single-voxel NiiVue painting (interpolate-eligible); Brush/Eraser are
  // true-3D sphere tools driven entirely by our own pointer pipeline below,
  // which must never let niivue's native pen pipeline run concurrently — see
  // the capture-phase blocker in the setup effect.
  const toolModeRef = useRef("pen");
  // Brush painting / erase mode: "3D" (true-3D sphere stamp) | "2D" (flat disc
  // stamp on the current 2D slice). Default is "3D" for multiplanar/asymmetric
  // views and "2D" for single-slice views; Dashboard switches it automatically
  // when sliceType changes, and DrawingPanel's toggle can override it.
  const brushModeRef = useRef("3D");
  // isTrue3DTool is assembled below (lib/viewer/pointerMath.js) once ctxRef exists.
  // Right-drag behaviour toggle: "zoom" (default, our own custom drag-zoom) |
  // "windowing" | "pan" (both handled natively by NiiVue once mouseEventConfig
  // .rightButton is set — see setDragMode). Left-click is ALWAYS crosshair
  // (when not drawing) regardless of this — this toggle only ever affects the
  // right button now. Read by handleRightDown/Move in the setup effect.
  const rightDragModeRef = useRef("zoom");

  // Snapshot the current draw bitmap onto the undo stack (used before every
  // programmatic mutation: morph, interpolate, clear). No-op if nothing to snap.
  const snapshotForUndo = () => {
    const nv = nvRef.current;
    if (!nv?.drawBitmap) return;
    drawHistory.current.push(rleEncode(nv.drawBitmap));
  };
  const emitHistory = () => {
    historyCb.current?.({
      canUndo: drawHistory.current.canUndo,
      canRedo: drawHistory.current.canRedo,
    });
    // Every path that mutates the draw bitmap already calls emitHistory (stroke
    // commit, undo/redo, interpolate, morph, clear, loadDrawingFromVolume), so
    // this is the one place that catches them all. A couple of callers invoke it
    // with nothing actually changed (setHistoryCallback's initial push) — the
    // subscriber must tolerate a redundant notification rather than assume one
    // fire means one edit.
    drawChangeCb.current?.();
  };

  // Reset the 3D-render overlay texture to blank. NiiVue only (re)allocates the
  // overlay 3D texture in refreshLayers when layer===1 (i.e. when at least one
  // overlay volume exists); when the LAST overlay is removed, updateGLVolume only
  // processes the base (layer 0) and never clears the stale overlay texture, so
  // the 3D render keeps compositing the removed overlay — a "ghost" that the 2D
  // slices don't show. This mirrors what NiiVue.init() does (rgbaTex(..., true)
  // zero-fills) and must be followed by updateGLVolume()/drawScene() so any
  // remaining overlays re-composite into the fresh texture. gl.TEXTURE2 is
  // NiiVue's TEXTURE2_OVERLAY_VOL unit.
  const resetOverlayTexture = () => {
    const nv = nvRef.current;
    if (!nv?.gl || typeof nv.rgbaTex !== "function") return;
    try {
      nv.overlayTexture = nv.rgbaTex(nv.overlayTexture, nv.gl.TEXTURE2, [2, 2, 2, 2], true);
      nv.overlayTextureID = nv.overlayTexture;
    } catch (_e) { /* best-effort */ }
  };

  // applyZoomFactor / resetAllZoom are assembled below (lib/viewer/zoomMath.js)
  // once ctxRef and setSingleFillZoom exist.

  // The two most-recent DISTINCT slices sharing the latest stroke's
  // orientation AND tool ("pen" or "cutout" — item 70), or null if fewer than
  // two exist. Interpolation only makes sense between two parallel slices of
  // the same view drawn with the same tool: Pen fills a label, Cutout carves a
  // void, and the two must not be mixed (a Pen shape and a Cutout footprint
  // aren't comparable).
  function interpolatablePair() {
    const hist = lastDraws.current;
    if (hist.length < 2) return null;
    const axCorSag = hist[hist.length - 1].axCorSag;
    const tool = hist[hist.length - 1].tool || "pen";
    const seen = [];
    for (let i = hist.length - 1; i >= 0 && seen.length < 2; i--) {
      const d = hist[i];
      if (d.axCorSag !== axCorSag) continue;
      if ((d.tool || "pen") !== tool) continue;
      if (seen.some((s) => s.slice === d.slice)) continue;
      seen.push(d);
    }
    if (seen.length < 2) return null;
    return {
      axCorSag,
      tool,
      sliceA: seen[0].slice,
      sliceB: seen[1].slice,
      label: seen[0].label,
      footprintA: tool === "cutout" ? seen[0].footprint : null,
      footprintB: tool === "cutout" ? seen[1].footprint : null,
    };
  }

  // One entry per distinct drawn slice index for a given orientation (0
  // axial / 1 coronal / 2 sagittal), most-recently-drawn tool/label/footprint
  // wins per slice, sorted ascending by slice. Feeds "Interpolate All" (item
  // 62/70).
  function distinctSliceEntriesForOrientation(axCorSag) {
    const bySlice = new Map();
    for (const d of lastDraws.current) {
      if (d.axCorSag !== axCorSag) continue;
      bySlice.set(d.slice, d); // lastDraws is chronological — later writes win
    }
    return [...bySlice.values()].sort((a, b) => a.slice - b.slice);
  }

  // Pushes interpolate-eligibility ("last 2" AND "all") to the Draw panel.
  // Called after every committed stroke AND whenever the app's active/last-
  // interacted orientation changes — switching tiles can flip "All"'s validity
  // (and its button label) even with no new drawing.
  const emitInterpolateState = () => {
    const orientation = activeOrientationRef.current;
    const entries =
      orientation != null && orientation >= 0 && orientation <= 2
        ? distinctSliceEntriesForOrientation(orientation)
        : [];
    drawCommitCb.current?.({
      canInterpolate: !!interpolatablePair(),
      canInterpolateAll: entries.length >= 2,
      activeOrientation: orientation,
    });
  };

  // mmAtCanvasXY / hitTestPenTarget / rasterizeSphere / brushRadiusMM /
  // stampSphereAlongPath are assembled below (lib/viewer/pointerMath.js) once
  // ctxRef exists.

  // Tracks current sliceType prop for use inside imperative setAsymmetricLayout
  // (avoids stale closure — same pattern as onDoubleClickSliceRef).
  const sliceTypeRef = useRef(sliceType);
  React.useEffect(() => { sliceTypeRef.current = sliceType; }, [sliceType]);

  // Side-panel overlay state for asymmetric mode hover UX.
  const [sideLayout, setSideLayout] = useState([]);
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const sideLayoutRef = useRef([]);

  // Brush/Eraser hover-radius ring (item 4): {x, y, diameterPx} in CSS px
  // relative to the canvas, or null when not applicable (wrong tool, drawing
  // not armed, or pointer over the 3D render tile).
  const [brushHover, setBrushHover] = useState(null);

  // Active-orientation tile highlight: shows which 2D view arrow-key slice
  // stepping currently targets, whenever more than one tile is visible
  // (Multi/Asymmetric layouts — single-view modes have nothing to highlight).
  const [activeTileRect, setActiveTileRect] = useState(null);
  const activeOrientationRef = useRef(activeOrientation);
  useEffect(() => {
    activeOrientationRef.current = activeOrientation;
    // Switching the active/last-interacted tile can change which orientation
    // "Interpolate All" targets (and whether it's currently valid) even
    // without any new drawing — keep the Draw panel's button in sync.
    emitInterpolateState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrientation]);
  const updateActiveTileHighlight = () => {
    const nv = nvRef.current;
    const orientation = activeOrientationRef.current;
    // Asymmetric mode (sideLayoutRef non-empty) has no highlight: the biggest
    // window is conceptually the target, so no per-tile border is drawn.
    if (!nv || orientation == null || !nv.customLayout?.length || sideLayoutRef.current.length) {
      setActiveTileRect(null);
      return;
    }
    const st = orientation === 0 ? SLICE_TYPE.AXIAL : orientation === 1 ? SLICE_TYPE.CORONAL : SLICE_TYPE.SAGITTAL;
    const entry = nv.customLayout.find((e) => e.sliceType === st);
    setActiveTileRect(entry ? entry.position : null);
  };

  // Per-tile slice-index readout (e.g. "Ax 84/182") in the corner of each
  // visible 2D tile. Recomputed on every location change (crosshair move),
  // not just orientation switches, so the numbers stay live while scrolling.
  const [tileSliceInfo, setTileSliceInfo] = useState([]);
  // Drawing mode on/off — mirrored from setDrawingEnabled so the on-canvas
  // "DRAW MODE" indicator is always correct regardless of who toggles it.
  const [drawingActive, setDrawingActive] = useState(false);
  // The viewer is the SINGLE SOURCE OF TRUTH for paint mode. DrawingPanel used to
  // keep its own `enabled` mirror, which silently desynced whenever paint mode was
  // changed from outside the panel (the layer-list "Edit" button →
  // loadDrawingFromVolume turns it ON; Clear All turns it off) — the panel then read
  // "Enable Drawing" while the canvas still painted (item 51). Anything that flips
  // drawingActive now notifies the panel, so the two can't drift.
  const drawingActiveCb = useRef(null);
  useEffect(() => { drawingActiveCb.current?.(drawingActive); }, [drawingActive]);
  // Single-slice (Axial/Coronal/Sagittal) fill zoom. At 1 the whole slice is
  // shown (aspect-correct); zooming in GROWS the canvas past the viewport (which
  // is overflow-clipped) so the slice fills the window instead of sitting in a
  // letterboxed box with black bars. NiiVue's own 2D zoom stays at 1 in single
  // mode; this is the zoom instead. Multiplanar/asymmetric use NiiVue zoom.
  const [singleFillZoom, setSingleFillZoom] = useState(1);
  const singleFillZoomRef = useRef(1);
  useEffect(() => { singleFillZoomRef.current = singleFillZoom; }, [singleFillZoom]);
  // Lets zoom/orientation handlers re-run the canvas layout+resize on demand.
  const resizeCanvasRef = useRef(null);

  // ===== Shared viewer context =====
  // Groups the refs declared above into one object so the extracted viewer
  // modules take a single parameter instead of twenty-nine. Every value is a
  // useRef, so this is assembled once and stays referentially stable — no ref
  // is created, replaced, or renamed here. See lib/viewer/context.js.
  const ctxRef = useRef(null);
  if (!ctxRef.current) {
    ctxRef.current = buildViewerContext({
      canvasRef, nvRef,
      volumeMap, meshMap, hiddenLabelLayers,
      measurementMeshRef, measurementPointsRef,
      baseRef, baseFileRef,
      onDoubleClickSliceRef, onLocationChangeRef, clickToSegmentCb,
      drawStartCb, drawCommitCb, historyCb, drawingActiveCb, drawChangeCb,
      redrawRafRef, pendingVolumeUpdateRef,
      lastDraws, drawHistory, pendingStrokeSnapshot,
      brushRadiusRef, toolModeRef, brushModeRef, rightDragModeRef,
      sliceTypeRef, sideLayoutRef, activeOrientationRef,
      singleFillZoomRef, resizeCanvasRef,
    });
  }

  // Pure pointer-math and zoom helpers, bound to ctxRef.current. These return
  // the SAME local names (isTrue3DTool, applyZoomFactor, etc.) the call sites
  // below always used — only where they're defined moved into lib/viewer/,
  // not how or where they're called.
  const { isTrue3DTool, mmAtCanvasXY, hitTestPenTarget, rasterizeSphere, brushRadiusMM, stampSphereAlongPath, rasterize2DCircle, stamp2DCircleAlongPath } =
    createPointerMath(ctxRef.current);
  const { applyZoomFactor, resetAllZoom } = createZoomMath(ctxRef.current, { setSingleFillZoom, scheduleRedraw });

  const updateTileSliceInfo = () => {
    const nv = nvRef.current;
    const dims = nv?.back?.dims;
    if (!nv || !dims) { setTileSliceInfo([]); return; }
    const [nx, ny, nz] = [dims[1], dims[2], dims[3]];
    let vox;
    try { vox = nv.frac2vox(nv.scene.crosshairPos); } catch (_e) { vox = null; }
    if (!vox) { setTileSliceInfo([]); return; }
    const totals = { axial: nz, coronal: ny, sagittal: nx };
    const indices = { axial: Math.round(vox[2]), coronal: Math.round(vox[1]), sagittal: Math.round(vox[0]) };
    const labels = { axial: "Ax", coronal: "Cor", sagittal: "Sag" };
    const stToOrientation = { [SLICE_TYPE.AXIAL]: "axial", [SLICE_TYPE.CORONAL]: "coronal", [SLICE_TYPE.SAGITTAL]: "sagittal" };

    let tiles = [];
    if (nv.customLayout?.length) {
      tiles = nv.customLayout
        .filter((e) => stToOrientation[e.sliceType])
        .map((e) => ({ orientation: stToOrientation[e.sliceType], position: e.position }));
    } else if (["axial", "coronal", "sagittal"].includes(sliceTypeRef.current)) {
      tiles = [{ orientation: sliceTypeRef.current, position: [0, 0, 1, 1] }];
    }
    setTileSliceInfo(
      tiles.map((t) => ({
        key: t.orientation,
        position: t.position,
        text: `${labels[t.orientation]} ${indices[t.orientation] + 1}/${totals[t.orientation]}`,
      }))
    );
  };

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

    // Right-drag zooms the 2D views. NiiVue has no 2D drag-zoom mode
    // (DRAG_MODE.pan only translates), so rightButton is set to `none` and a
    // custom pointer handler below owns right-drag zoom. leftButton.primary is
    // kept in sync by setDragMode(); centerButton pans. Must be set via
    // setMouseEventConfig() — the constructor drops the option.
    nv.setMouseEventConfig({
      leftButton: { primary: DRAG_MODE.crosshair },
      rightButton: DRAG_MODE.none,
      centerButton: DRAG_MODE.pan,
    });

    // mrview-parity tractography rendering. The tract render state is a mutable
    // ref read live inside the drawMesh3D wrapper each frame, so changing it
    // never rebuilds a buffer.
    installTractRenderer(nv, tractRenderStateRef.current);
    // installVolumeClipPass only wraps JS methods (drawScene/updateGLVolume),
    // so it is safe here, before GL exists. installCustomRenderShader is NOT:
    // it compiles GLSL and needs nv.gl plus the stock shaders, neither of
    // which exist until nv.attachToCanvas() runs further down — so it is
    // called immediately after that instead. Ordering between the two is
    // irrelevant: the clip pass only reads our shader's uniforms at DRAW
    // time, never at install time.
    installVolumeClipPass(nv);

    // Item 102 (6b): niivue's own sliceScroll3D steps the clip plane's depth
    // whenever the plane is engaged (clipPlaneDepthAziElevs[...][0] < 1.8) and
    // only zooms the render otherwise — see calculateSliceScroll3D in the
    // vendored niivue source. That meant plain scroll over the 3D render tile
    // silently dragged the clip depth (previously worked around in
    // Dashboard.jsx by swallowing render-tile wheel events, which in turn
    // killed render-tile zoom whenever the plane was OFF, the default state).
    // Override it to ALWAYS zoom and NEVER touch the clip plane — the user
    // wants scroll-to-zoom on the 3D render regardless of clip-plane state,
    // and the clip depth is now only ever changed via its own slider or the
    // az/el render-drag sync (6c/6d below). Math mirrors niivue's own zoom
    // branch exactly (±10%, clamped [0.5, 2]) so the feel is unchanged.
    nv.sliceScroll3D = (posChange = 0) => {
      if (!posChange) return;
      const cur = nv.scene.volScaleMultiplier;
      // posChange comes from niivue's own wheel handler: deltaY < 0 (scroll
      // up / away from the user) yields posChange < 0. Scroll-up = zoom IN,
      // so a NEGATIVE posChange must INCREASE volScaleMultiplier (larger
      // volScaleMultiplier -> smaller ortho frustum in calculateMvpMatrix,
      // i.e. zoomed in). Verified against niivue's calculateScrollAmount
      // (deltaY < 0 -> scrollAmount = -0.01) — flipped from the previous
      // posChange > 0 branch, which zoomed in on scroll-DOWN.
      nv.scene.volScaleMultiplier = posChange < 0
        ? Math.min(2, cur * 1.1)
        : Math.max(0.5, cur * 0.9);
      nv.drawScene();
    };

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
    // isAntiAlias=false (item 93, historical — superseded, kept for the bug
    // archaeology): the now-deleted fiber-occlusion depth-ghost pass needed to
    // blitFramebuffer the default framebuffer's depth into a single-sampled
    // FBO. With isAntiAlias=null niivue resolves MSAA on for most hardware
    // (navigator.hardwareConcurrency > 6), making the default framebuffer
    // multisampled — WebGL2 forbids a depth blit from a multisampled source
    // to a single-sampled destination, so that blit had been silently failing
    // (GL_INVALID_OPERATION), and the ghost pass's captured "surface depth"
    // texture never held real data. false was kept here as the trade-off: no
    // MSAA on 3D-render mesh edges, in exchange for a working depth-aware
    // tract occlusion pass.
    // The depth blit that forced isAntiAlias=false is gone — the
    // current renderer (lib/gl/tractRenderer.js) uses depthFunc(GREATER)
    // against the default framebuffer's own depth, no FBO and no blit. Its
    // depth reads are ordinary fixed-function depth-test comparisons, not
    // readPixels, so multisampling doesn't affect it either way. Verified
    // separately that niivue's own depthPicker() (dist/index.js, the
    // mouse-crosshair depth pick) calls gl.readPixels() with no FBO bound —
    // i.e. against the default framebuffer — which browsers transparently
    // resolve for multisampled reads; only a *manual* multisampled FBO (what
    // the ghost pass used) needs an explicit blitFramebuffer resolve before
    // readPixels. So isAntiAlias=null (MSAA on where supported) is safe here.
    //
    // Pre-create the WebGL2 context ourselves so we can request a STENCIL
    // buffer, which niivue never asks for (its initGL passes only
    // {alpha, antialias}). The tract renderer needs stencil for its
    // behind-tissue pass: that pass cannot use the depth buffer for
    // first-fragment-wins rejection, because the depth buffer holds the
    // tissue depth its GREATER test depends on. Without this, every one of a
    // dense bundle's ~50 overlapping fragments composites per pixel and the
    // opacity slider saturates (measured: tract signal 7.40 at opacity 0.1 vs
    // 10.28 at 1.0 — i.e. visually dead). getContext() attributes are honoured
    // only on the FIRST call for a canvas, so this must run before
    // attachToCanvas; niivue's own getContext then returns this same context
    // and its attribute argument is ignored. antialias mirrors niivue's own
    // default rule (attachToCanvas(.., null) -> hardwareConcurrency > 6) so
    // MSAA behaviour is unchanged.
    try {
      canvasRef.current.getContext("webgl2", {
        alpha: true,
        antialias: (navigator.hardwareConcurrency || 0) > 6,
        stencil: true,
      });
    } catch (_e) { /* fall through: niivue creates it, tracts lose the far-pass dedup */ }
    nv.attachToCanvas(canvasRef.current, null);

    // MUST come after attachToCanvas: this compiles our vendored copy of
    // niivue's volume raycast shader (lib/gl/volumeShaders.js) and swaps it
    // into nv.renderShader + the three sibling variant slots. It needs both
    // nv.gl and the stock shaders, and NEITHER exists until attachToCanvas()
    // has initialised WebGL — calling it earlier throws inside compileShader
    // and takes the whole NiivueViewer component down with it.
    installCustomRenderShader(nv);

    nv.onLocationChange = (data) => {
      // Item 12: while a native Pen/Cutout stroke is painting AND the crosshair
      // is hidden, keep the other 2D planes frozen. niivue has just moved
      // scene.crosshairPos to the paint cursor (re-slicing coronal/sagittal);
      // restore it to where the stroke started and redraw. Both this draw and
      // niivue's own draw for this event run in the same JS turn, so the
      // browser only composites the final (frozen) frame — no flicker. The
      // transient paint-cursor location is not propagated, so the readout stays
      // put too. Only Pen/Cutout reaches here: Brush/Eraser block niivue's
      // native mouse entirely, so they never move the crosshair.
      const frozen = drawFreezeCrosshairRef.current;
      if (frozen && nv.opts?.drawingEnabled && !nv.opts?.show3Dcrosshair) {
        try {
          nv.scene.crosshairPos = frozen.slice();
          nv.drawScene();
          if (data.axCorSag != null) {
            onLocationChangeRef.current?.({ axCorSag: data.axCorSag });
          }
        } catch (_e) { /* fall through to normal handling */ }
        return;
      }
      try { onLocationChangeRef.current?.(data); } catch (_e) {}
      recomputeMeasure2D();
      updateTileSliceInfo();
    };

    // Fires for every REAL frame change — our own stepper (frameApi.setFrame),
    // niivue's own arrow-key handling, anything else — so the displayed frame
    // count can never drift from niivue's internal state.
    nv.onFrameChange = (volume, index) => {
      try { onFrameChangeRef.current?.(index | 0, Math.max(1, volume?.nFrame4D | 0)); } catch (_e) {}
    };

    // Item 104: nv.onAzimuthElevationChange is deliberately left unhooked. It
    // fires for EVERY camera rotation including niivue's own native left-drag
    // render-rotate — mirroring it into the clip-plane sliders (the 6d design)
    // is what made left-drag rotate BOTH the render and the clip plane. The
    // clip plane is now driven only by right-drag deltas (handleRightMove).

    // Commits the pending pre-stroke snapshot (see handleDrawStart) as one
    // undo step, and records which slice + orientation the stroke landed on
    // (used by the interpolate-eligibility check). Reads drawPenAxCorSag /
    // drawPenLocation, which niivue only resets to invalid at the very end of
    // its own mouseUpListener — so these are still valid whether this runs
    // from niivue's onDrawingChanged callback or from our own pointerup
    // listener below, whichever fires first (pointerup always does, since it
    // precedes the mouseup niivue's callback is driven from). Idempotent:
    // guarded by pendingStrokeSnapshot.current, so whichever caller runs
    // first "wins" and the other is a no-op — no double-commit.
    const commitPendingStroke = () => {
      if (!pendingStrokeSnapshot.current) return;
      try {
        const axCorSag = nv.drawPenAxCorSag;
        const loc = nv.drawPenLocation;
        // Native single-voxel tools only reach here (Pen or Cutout — Brush/
        // Eraser are gated out by handleDrawStart/End, see below), so
        // whichever is currently selected is what produced this stroke.
        const isCutout = toolModeRef.current === "cutout";
        if (axCorSag >= 0 && axCorSag <= 2 && loc && Number.isFinite(loc[0])) {
          const slice = axCorSag === 0 ? loc[2] : axCorSag === 1 ? loc[1] : loc[0];
          const dims = nv.back?.dims;
          const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
          const label =
            (nx && ny && nv.drawBitmap?.[loc[0] + nx * (loc[1] + ny * loc[2])]) ||
            nv.opts.penValue || 1;
          const entry = { axCorSag, slice, label, tool: isCutout ? "cutout" : "pen" };
          // Cutout erases to 0, so the shape it carved reads as plain
          // background on the POST-stroke bitmap — diff against the
          // pre-stroke snapshot (still sitting in pendingStrokeSnapshot,
          // right before it's consumed below) to capture the erased
          // footprint while it's still knowable, for later void-carve
          // interpolation between two Cutout slices (item 70).
          if (isCutout && nx && ny && nz && nv.drawBitmap) {
            try {
              const preBitmap = rleDecode(pendingStrokeSnapshot.current);
              entry.footprint = computeErasedFootprint({
                preBitmap, postBitmap: nv.drawBitmap, dims: [nx, ny, nz], axCorSag, slice,
              });
            } catch (_e) { /* footprint capture is best-effort */ }
          }
          const hist = lastDraws.current;
          hist.push(entry);
          if (hist.length > 8) hist.shift();
        }
        // Bitmap-diff guard: a stroke that started (pointerdown fired, so a
        // snapshot exists) but never actually painted anything — e.g. a
        // click-to-navigate with drawing armed but the pen landed exactly on
        // its own last position — should leave no undo entry.
        if (nv.drawBitmap && rleEncode(nv.drawBitmap) === pendingStrokeSnapshot.current) {
          pendingStrokeSnapshot.current = null;
          return;
        }
        emitInterpolateState();
        drawHistory.current.push(pendingStrokeSnapshot.current);
        pendingStrokeSnapshot.current = null;
        emitHistory();
      } catch (_e) { /* recording is best-effort */ }
    };

    // Niivue's own drawingChanged event covers drag strokes reliably. It
    // does NOT fire for a plain click (no movement) even though the click
    // does paint a voxel — a niivue quirk we work around via the pointerup
    // listener below, which commitPendingStroke's idempotency guard makes
    // safe to also trigger from here without double-committing.
    nv.onDrawingChanged = (action) => {
      if (action !== "draw") return;
      commitPendingStroke();
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

    const updateBrushHoverHelper = (e, rect) => {
      const nvD = nvDpr();
      const bx = (e.clientX - rect.left) * nvD;
      const by = (e.clientY - rect.top) * nvD;
      let overRenderTile = false;
      try { overRenderTile = nv.inRenderTile(bx, by) !== -1; } catch (_e) {}
      const mm0 = overRenderTile ? null : mmAtCanvasXY(bx, by);
      const mm1 = mm0 ? mmAtCanvasXY(bx + nvD, by) : null;
      if (mm0 && mm1) {
        const mmPerCssPx = Math.hypot(mm1[0] - mm0[0], mm1[1] - mm0[1], mm1[2] - mm0[2]) || 0.001;
        const diameterPx = (2 * brushRadiusMM()) / mmPerCssPx;
        // The ring <div> is positioned inside the OUTER wrapper (canvas can't
        // host HTML children), not the canvas itself. In multiplanar/
        // asymmetric the canvas fills that wrapper 1:1, so canvas-relative ==
        // wrapper-relative and this was a no-op. In single-slice modes
        // (layoutCanvasBox above) the canvas is a smaller box CSS-centered via
        // left:50%/top:50% + transform:translate(-50%,-50%) — offsetLeft/Top
        // report the PRE-transform position, not the actual inset, so this
        // must come from the two elements' real rendered rects instead.
        const wrapperRect = canvas.parentElement.getBoundingClientRect();
        setBrushHover({
          x: e.clientX - wrapperRect.left,
          y: e.clientY - wrapperRect.top,
          diameterPx,
        });
      } else {
        setBrushHover(null);
      }
    };

    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;

      if (sideLayoutRef.current.length) {
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
      } else {
        canvas.style.cursor = "default";
      }

      // Brush/Eraser hover-radius ring (item 4): only while that tool is
      // selected and drawing is armed. Screen radius is derived by sampling
      // how many mm one on-screen pixel spans at the hovered point (rather
      // than reaching into niivue's projection internals), so it stays
      // correct across zoom/pan for whichever 2D tile the pointer is over.
      if (isTrue3DTool() && nv?.opts?.drawingEnabled) {
        updateBrushHoverHelper(e, rect);
      } else {
        setBrushHover(null);
      }

      // Measurement-point 3D hover label: project each point through the
      // current camera (calculateMvpMatrix/calculateScreenPoint — undocumented
      // public instance methods, no supported alternative exists for
      // world->screen projection) and show the nearest one within a small
      // pixel radius. Recomputed on every mousemove, including during a
      // drag-rotate, so it stays correctly positioned as the camera moves.
      const pts = measurementPointsRef.current;
      if (pts.length) {
        const renderTile = nv.screenSlices?.find((s) => s.axCorSag === SLICE_TYPE.RENDER);
        let nearest = null;
        if (renderTile) {
          const ltwh = renderTile.leftTopWidthHeight;
          const hitRadius = 24 * dpr;
          let nearestDist = hitRadius;
          try {
            const [mvpMatrix] = nv.calculateMvpMatrix(null, ltwh, nv.scene.renderAzimuth, nv.scene.renderElevation);
            for (const p of pts) {
              const sp = nv.calculateScreenPoint(p.mm, mvpMatrix, ltwh);
              const dist = Math.hypot(sp[0] - px, sp[1] - py);
              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = {
                  id: p.id, label: p.label,
                  colorIdx: (p.colorIdx ?? 0) % MEASURE_NBANDS,
                  x: sp[0] / dpr, y: sp[1] / dpr,
                };
              }
            }
          } catch (_e) { /* projection is best-effort */ }
        }
        setMeasureHover(nearest);
      }
    };
    const handleMouseLeave = () => {
      setHoveredSlice(null);
      setMeasureHover(null);
      setBrushHover(null);
      canvas.style.cursor = "default";
    };
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    // Draw-start: when a stroke begins on the canvas while drawing is enabled,
    // notify the panel (used to scroll the Draw Lesion controls into view).
    // Native single-voxel Pen/Cutout only — Brush/Eraser are handled entirely
    // separately below (handleSphereToolDown/Move/Up) and never touch niivue's
    // native pen pipeline (item 66/70 redesign). LEFT BUTTON ONLY: right-drag
    // has its own dedicated handlers (handleRightDown/Move/Up) that now also
    // drive niivue's native pen state (drawPenAxCorSag et al, item 70) — this
    // must not also snapshot/commit on a right-button event, or the two
    // pipelines would read/commit each other's in-progress state.
    const handleDrawStart = (e) => {
      if (e.button !== 0) return;
      if (nv?.opts?.drawingEnabled && !isTrue3DTool()) {
        try { drawStartCb.current?.(); } catch (_e) {}
        // Stash the pre-stroke bitmap; committed to the undo stack only if the
        // stroke actually paints (see onDrawingChanged).
        try {
          if (nv.drawBitmap) pendingStrokeSnapshot.current = rleEncode(nv.drawBitmap);
        } catch (_e) { /* snapshot is best-effort */ }
      }
    };
    canvas.addEventListener("pointerdown", handleDrawStart);

    // Draw-end safety net: pointerup always fires (before niivue's own
    // mouseup-driven onDrawingChanged), so this is what actually makes single
    // clicks undoable — see commitPendingStroke's comment above. Left button
    // only, same reasoning as handleDrawStart above.
    const handleDrawEnd = (e) => {
      if (e.button !== 0) return;
      if (nv?.opts?.drawingEnabled && !isTrue3DTool()) commitPendingStroke();
    };
    canvas.addEventListener("pointerup", handleDrawEnd);

    // NiiVue's own screen geometry (screenSlices[].leftTopWidthHeight,
    // inRenderTile, etc.) is scaled by nv.uiData.dpr, which this app's build
    // deliberately decouples from window.devicePixelRatio (custom canvas
    // scaling) — they can legitimately differ (e.g. 2 vs 1). Hit-testing
    // against niivue's geometry must use niivue's own dpr, not the browser's.
    // Shared by the Brush pointer handlers below and the right-drag code.
    const nvDpr = () => nv?.uiData?.dpr || window.devicePixelRatio || 1;

    // ===== Brush/Eraser — true 3D sphere, own pointer pipeline (item 66/70) ===
    // Brush (paint, labelValue = the current pen label) and Eraser (erase,
    // labelValue always 0) are both "true 3D sphere" tools sharing this exact
    // pipeline — the only difference is the label value stamped. NEITHER ever
    // touches niivue's native pen (no drawPenFillPts/isFilledPen/drawPenFilled
    // involvement) — hit-tests the canvas itself (mmAtCanvasXY) and stamps
    // true-3D spheres via rasterizeSphere, the same template the right-drag
    // code used to use before item 70 moved right-drag to a native-pen-style
    // single-voxel+fill mechanism instead (see below). A capture-phase
    // listener on the canvas's parent (registered further down) blocks
    // niivue's own native mousedown/mousemove/mouseup for left-button events
    // while either tool is selected, so its native pipeline never engages
    // concurrently (no double-paint, no stray flood-fill risk).
    // ===== Brush — true 3D sphere OR flat 2D circle, own pointer pipeline =====
    // Left-button Brush tool: 3D mode stamps a sphere along the drag path via
    // stampSphereAlongPath (same as before); 2D mode stamps a flat disc on the
    // current slice plane via stamp2DCircleAlongPath. Both modes share the same
    // pointer capture + native-pen-block logic so niivue's own pipeline is
    // always idle while this one runs. brushModeRef.current gates which stamp
    // function is called at the moment of each event.
    const sphereToolLabelValue = () => (nv.opts.penValue ?? 1);
    let sphereToolStroke = null; // { snapshot, lastMM } for 3D mode  OR  { snapshot, lastVox, axCorSag } for 2D
    const handleSphereToolDown = (e) => {
      if (e.button !== 0 || !isTrue3DTool() || !nv?.opts?.drawingEnabled) return;
      const dpr = nvDpr();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      try { if (nv.inRenderTile(x, y) !== -1) return; } catch (_e) { /* proceed */ }
      try { drawStartCb.current?.(); } catch (_e) {}
      let snapshot = null;
      try { snapshot = nv.drawBitmap ? rleEncode(nv.drawBitmap) : null; } catch (_e) { snapshot = null; }
      if (brushModeRef.current === "2D") {
        const hit = hitTestPenTarget(x, y);
        if (!hit) return;
        sphereToolStroke = { snapshot, lastVox: null, axCorSag: hit.axCorSag };
        try { onLocationChangeRef.current?.({ axCorSag: hit.axCorSag }); } catch (_e) {}
        if (stamp2DCircleAlongPath(sphereToolStroke, hit.vox, brushRadiusRef.current, hit.axCorSag, sphereToolLabelValue())) {
          try { nv.refreshDrawing(true); } catch (_e) {}
        }
      } else {
        const mm = mmAtCanvasXY(x, y);
        if (!mm) return;
        sphereToolStroke = { snapshot, lastMM: null };
        if (stampSphereAlongPath(sphereToolStroke, mm, brushRadiusMM(), sphereToolLabelValue())) {
          try { nv.refreshDrawing(true); } catch (_e) {}
        }
      }
      updateBrushHoverHelper(e, rect);
      try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
      e.preventDefault();
    };
    const handleSphereToolMove = (e) => {
      if (!sphereToolStroke) return;
      if (!(e.buttons & 1)) return; // left button must be held
      const dpr = nvDpr();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      if (brushModeRef.current === "2D") {
        const hit = hitTestPenTarget(x, y, sphereToolStroke.axCorSag);
        if (!hit) return;
        if (stamp2DCircleAlongPath(sphereToolStroke, hit.vox, brushRadiusRef.current, sphereToolStroke.axCorSag, sphereToolLabelValue())) {
          try { nv.refreshDrawing(true); } catch (_e) {}
        }
      } else {
        const mm = mmAtCanvasXY(x, y);
        if (!mm) return;
        if (stampSphereAlongPath(sphereToolStroke, mm, brushRadiusMM(), sphereToolLabelValue())) {
          try { nv.refreshDrawing(true); } catch (_e) {}
        }
      }
      // Item 5: keep the hover-radius ring moving during a drag stroke.
      updateBrushHoverHelper(e, rect);
    };
    const handleSphereToolUp = () => {
      if (!sphereToolStroke) return;
      const snapshot = sphereToolStroke.snapshot;
      sphereToolStroke = null;
      try {
        if (snapshot && nv.drawBitmap && rleEncode(nv.drawBitmap) !== snapshot) {
          drawHistory.current.push(snapshot); // one undo entry for the whole stroke
          emitHistory();
        }
      } catch (_e) { /* undo bookkeeping is best-effort */ }
    };
    canvas.addEventListener("pointerdown", handleSphereToolDown);
    canvas.addEventListener("pointermove", handleSphereToolMove);
    canvas.addEventListener("pointerup", handleSphereToolUp);
    canvas.addEventListener("pointercancel", handleSphereToolUp);

    // Block niivue's own native mousedown/mousemove/mouseup for left-button
    // events while Brush/Eraser is selected, so its native pen pipeline never
    // runs concurrently with our own sphere stamping above (same capture-phase
    // technique as the wheel-swallow fix — SMALL-FIXES Group C — registered on
    // an ANCESTOR of the canvas so it reliably runs before niivue's own
    // bubble-phase listeners bound directly to the canvas). Exempts the render
    // tile (left-drag there should still rotate the 3D view) and only
    // intervenes while paint mode is actually on, so normal crosshair-click
    // navigation is untouched whenever drawing is disabled.
    const sphereToolWrap = canvas.parentElement;
    const blockNativeSphereToolMouse = (e) => {
      if (!nv?.opts?.drawingEnabled || !isTrue3DTool()) return;
      const isDown = e.type === "mousedown", isUp = e.type === "mouseup";
      const leftInvolved = isDown || isUp ? e.button === 0 : (e.buttons & 1) !== 0;
      if (!leftInvolved) return;
      const dpr = nvDpr();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      try { if (nv.inRenderTile(x, y) !== -1) return; } catch (_e) { /* proceed */ }
      e.stopPropagation();
      e.preventDefault();
    };
    sphereToolWrap?.addEventListener("mousedown", blockNativeSphereToolMouse, true);
    sphereToolWrap?.addEventListener("mousemove", blockNativeSphereToolMouse, true);
    sphereToolWrap?.addEventListener("mouseup", blockNativeSphereToolMouse, true);

    // Item 12: snapshot the crosshair at the START of a native Pen/Cutout
    // stroke (before niivue's own listener moves it), so onLocationChange can
    // restore it and keep the coronal/sagittal planes frozen while painting
    // with the crosshair hidden. Capture-phase pointerdown runs before niivue's
    // own canvas listeners. Only Pen/Cutout: Brush/Eraser (isTrue3DTool) block
    // niivue's native mouse and never move the crosshair. Not the render tile.
    const snapshotDrawFreeze = (e) => {
      drawFreezeCrosshairRef.current = null;
      if (!nv?.opts?.drawingEnabled || nv.opts?.show3Dcrosshair) return; // only when drawing + crosshair off
      if (isTrue3DTool() || e.button !== 0) return;
      try {
        const dpr = nvDpr();
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * dpr;
        const y = (e.clientY - rect.top) * dpr;
        if (nv.inRenderTile(x, y) !== -1) return;   // drawing doesn't apply on the 3D tile
        drawFreezeCrosshairRef.current = nv.scene?.crosshairPos?.slice() || null;
      } catch (_e) { drawFreezeCrosshairRef.current = null; }
    };
    const clearDrawFreeze = () => { drawFreezeCrosshairRef.current = null; };
    canvas.addEventListener("pointerdown", snapshotDrawFreeze, true);
    window.addEventListener("pointerup", clearDrawFreeze, true);
    window.addEventListener("pointercancel", clearDrawFreeze, true);

    // ===== Right-drag = zoom (2D views), default right-drag mode =====
    // NiiVue has no 2D drag-zoom mode, so we implement it: right-button drag
    // vertically scales pan2Dxyzmm[3] via applyZoomFactor — no pan anchor, same
    // as zoom2D (Ctrl+scroll), so both zoom paths center identically. Only
    // active while the right-drag toggle (rightDragModeRef) is "zoom"; for
    // "windowing"/"pan" this backs off and NiiVue's own native right-button
    // handling (configured via mouseEventConfig.rightButton in setDragMode)
    // takes over. rightButton defaults to DRAG_MODE.none in the constructor.
    let rightZoom = null; // { lastY } while a right-drag is in progress
    const suppressContextMenu = (e) => e.preventDefault();
    canvas.addEventListener("contextmenu", suppressContextMenu);

    const applyDragZoom = (dyPixels) => {
      // Drag up (dy < 0) zooms in, drag down zooms out. Exponential for a
      // smooth, scale-independent feel. Routes through applyZoomFactor with NO
      // anchor — matching zoom2D (the Ctrl+scroll zoom) exactly, so right-drag
      // zoom and Ctrl+scroll zoom center/scale the view identically. (Used to
      // pass a crosshair-mm anchor here, which re-centered the pan differently
      // from the wheel path — the two zooms disagreed on where "center" was.)
      applyZoomFactor(Math.exp(-dyPixels * 0.005));
    };

    // Right-drag = erase, but ONLY while paint mode is active (item 69) —
    // right-drag stays zoom everywhere else, no modifier key needed (zoom is
    // still reachable via the scroll wheel while drawing). ITEM 70: no longer
    // a true-3D sphere stamp — right-drag now erases the SAME way Cutout does:
    // a single-voxel path drawn live along the drag (niivue's own drawPt/
    // drawPenLine, so it looks and behaves identically to a native pen
    // stroke), then the enclosed loop is flood-filled to 0 on release via
    // niivue's own drawPenFilled() — literally the same native isFilledPen
    // machinery Cutout drives, just fed by our own hit-testing
    // (hitTestPenTarget) instead of niivue's internal mouse listeners, since
    // niivue's own pipeline never runs for a right-button drag. This is
    // independent of whichever left-click tool is currently selected, exactly
    // like the previous sphere-stamp version was. Deliberately does NOT touch
    // nv.drawPenLocation (native left-pen's own "stroke in progress" marker)
    // and always restores nv.drawPenAxCorSag/opts.penValue/drawPenFillPts to
    // their pre-drag values afterward, so it can't corrupt a native left
    // stroke's state — the two are mutually exclusive in practice (one mouse,
    // one button at a time). Tracked separately from lastDraws/the
    // interpolate-eligibility history — an erase drag isn't a "drawn slice"
    // (unchanged design intent from before item 70).
    let rightErase = null; // { axCorSag, prevVox, fillPts, snapshot, savedAxCorSag } mid-drag
    // Item 102 (6c) / item 104: right-drag over the 3D render tile rotates the
    // CLIP PLANE only (never the render camera — that stays niivue's native
    // left-drag), regardless of the right-drag mode toggle (zoom/windowing/
    // pan), which only governs 2D-tile right-drag below. With the clip plane
    // disabled the drag is still swallowed but does nothing at all.
    // { lastX, lastY, live } while such a drag is in progress; live=false
    // means "clip plane off, swallow only".
    let clipRotate = null;
    const RIGHT_DRAG_MODE_MAP = { zoom: DRAG_MODE.none, windowing: DRAG_MODE.windowing, pan: DRAG_MODE.pan };
    const handleRightDown = (e) => {
      if (e.button !== 2) return;
      const dpr = nvDpr();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      let inRender = false;
      try { inRender = nv.inRenderTile(x, y) !== -1; } catch (_e) { inRender = false; }
      if (inRender) {
        // Neutralize niivue's OWN native right-button handling for the
        // duration of this drag — otherwise a "windowing"/"pan" toggle
        // setting (which hands the right button to niivue's native drag
        // handling for 2D tiles) would also react to this same drag.
        // Restored in handleRightUp from the CURRENT toggle value (not a
        // snapshot), so a toggle change mid-drag still lands correctly.
        if (nv.opts?.mouseEventConfig) nv.opts.mouseEventConfig.rightButton = DRAG_MODE.none;
        clipRotate = { lastX: e.clientX, lastY: e.clientY, live: !!clipEnabledRef.current };
        try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
        e.preventDefault();
        return;
      }
      // Right-drag erase — only while drawing is active. Erase behaviour now
      // depends on the current left-click tool and brush mode:
      //   pen → 2D cutout (native drawPt/drawPenLine path, same as before)
      //   brush + 3D → true-3D sphere erase (sphere stamp along path, label=0)
      //   brush + 2D → flat 2D circle erase (disc stamp along path, label=0)
      if (nv?.opts?.drawingEnabled) {
        if (toolModeRef.current === "brush" && brushModeRef.current === "3D") {
          // 3D sphere erase: mirror of handleSphereToolDown but labelValue=0.
          let overRenderTile = false;
          try { overRenderTile = nv.inRenderTile(x, y) !== -1; } catch (_e) {}
          if (overRenderTile) return;
          const mm = mmAtCanvasXY(x, y);
          if (!mm) return;
          let snapshot = null;
          try { snapshot = nv.drawBitmap ? rleEncode(nv.drawBitmap) : null; } catch (_e) { snapshot = null; }
          rightErase = { mode: "sphere3D", snapshot, lastMM: null };
          if (stampSphereAlongPath(rightErase, mm, brushRadiusMM(), 0)) {
            try { nv.refreshDrawing(true); } catch (_e) {}
          }
          updateBrushHoverHelper(e, rect);
          try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
          e.preventDefault();
          return;
        }
        if (toolModeRef.current === "brush" && brushModeRef.current === "2D") {
          // 2D circle erase: mirror of handleSphereToolDown 2D-mode but labelValue=0.
          const hit = hitTestPenTarget(x, y);
          if (!hit) return;
          let snapshot = null;
          try { snapshot = nv.drawBitmap ? rleEncode(nv.drawBitmap) : null; } catch (_e) { snapshot = null; }
          rightErase = { mode: "circle2D", snapshot, lastVox: null, axCorSag: hit.axCorSag };
          if (stamp2DCircleAlongPath(rightErase, hit.vox, brushRadiusRef.current, hit.axCorSag, 0)) {
            try { nv.refreshDrawing(true); } catch (_e) {}
          }
          updateBrushHoverHelper(e, rect);
          try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
          e.preventDefault();
          return;
        }
        // pen tool (or default): 2D cutout — native drawPt/drawPenLine path.
        const hit = hitTestPenTarget(x, y);
        if (!hit) return;
        let snapshot = null;
        try { snapshot = nv.drawBitmap ? rleEncode(nv.drawBitmap) : null; } catch (_e) { snapshot = null; }
        rightErase = {
          mode: "pen",
          axCorSag: hit.axCorSag,
          prevVox: hit.vox,
          fillPts: [hit.vox],
          snapshot,
          savedAxCorSag: nv.drawPenAxCorSag,
        };
        try {
          nv.drawPenAxCorSag = hit.axCorSag;
          nv.drawPt(hit.vox[0], hit.vox[1], hit.vox[2], 0);
          nv.refreshDrawing(true);
        } catch (_e) { /* draw is best-effort */ }
        try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
        e.preventDefault();
        return;
      }
      // Right-drag mode toggle (top-right UI): "windowing"/"pan" hand the
      // right button to NiiVue's own native drag handling (already configured
      // via mouseEventConfig.rightButton in setDragMode) — back off entirely,
      // no preventDefault/capture, so NiiVue's native listeners drive it.
      // Only "zoom" (the default) is handled by this custom drag below.
      if (rightDragModeRef.current !== "zoom") return;
      rightZoom = { lastY: e.clientY };
      try { canvas.setPointerCapture?.(e.pointerId); } catch (_e) {}
      e.preventDefault();
    };
    const handleRightMove = (e) => {
      if (clipRotate) {
        const dx = e.clientX - clipRotate.lastX;
        const dy = e.clientY - clipRotate.lastY;
        clipRotate.lastX = e.clientX;
        clipRotate.lastY = e.clientY;
        // 1px = 1°, same feel as niivue's own calculateDragRotation. Emitted
        // as a delta; Dashboard owns the wrapping and the authoritative value.
        // The vertical axis is INVERTED relative to screen coordinates: drag up
        // raises the elevation, drag down lowers it (screen y grows downward,
        // so that is -dy). Requested explicitly — it reads as "pull the plane
        // up" rather than niivue's camera-drag convention.
        if (clipRotate.live && (dx || dy)) {
          try { onClipRotateDeltaRef.current?.(dx, -dy); } catch (_e) {}
        }
        return;
      }
      if (rightErase) {
        const dpr = nvDpr();
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * dpr;
        const y = (e.clientY - rect.top) * dpr;
        if (rightErase.mode === "sphere3D") {
          const mm = mmAtCanvasXY(x, y);
          if (mm && stampSphereAlongPath(rightErase, mm, brushRadiusMM(), 0)) {
            try { nv.refreshDrawing(true); } catch (_e) {}
          }
        } else if (rightErase.mode === "circle2D") {
          const hit = hitTestPenTarget(x, y, rightErase.axCorSag);
          if (hit && stamp2DCircleAlongPath(rightErase, hit.vox, brushRadiusRef.current, rightErase.axCorSag, 0)) {
            try { nv.refreshDrawing(true); } catch (_e) {}
          }
        } else {
          // pen / default: native drawPenLine path
          const hit = hitTestPenTarget(x, y, rightErase.axCorSag);
          if (hit) {
            const pt = hit.vox;
            const prev = rightErase.prevVox;
            if (pt[0] !== prev[0] || pt[1] !== prev[1] || pt[2] !== prev[2]) {
              try {
                nv.drawPenAxCorSag = rightErase.axCorSag;
                nv.drawPenLine(pt, prev, 0);
                nv.refreshDrawing(true);
              } catch (_e) { /* draw is best-effort */ }
              rightErase.fillPts.push(pt);
              rightErase.prevVox = pt;
            }
          }
        }

        // Live-update the hover ring during a right-drag if using a true-3D tool
        // (Brush/Eraser), because pointermove fires while capture is held, but
        // mousemove does not, so the ring would freeze. Pen/Cutout don't use
        // the radius ring.
        if (rightErase.mode === "sphere3D" || rightErase.mode === "circle2D") {
          updateBrushHoverHelper(e, rect);
        }
        return;
      }
      if (!rightZoom) return;
      const dy = e.clientY - rightZoom.lastY;
      rightZoom.lastY = e.clientY;
      if (dy) applyDragZoom(dy);
    };
    const handleRightUp = () => {
      if (clipRotate) {
        clipRotate = null;
        // Restore the right-button config to whatever the toggle currently
        // says (not a pre-drag snapshot — see handleRightDown's comment).
        if (nv.opts?.mouseEventConfig) {
          nv.opts.mouseEventConfig.rightButton =
            RIGHT_DRAG_MODE_MAP[rightDragModeRef.current] ?? DRAG_MODE.none;
        }
        return;
      }
      if (rightErase) {
        const saved = rightErase;
        const { mode, snapshot } = saved;
        rightErase = null;
        if (mode === "sphere3D" || mode === "circle2D") {
          // Sphere and 2D circle erase: just push undo entry if bitmap changed.
          try {
            if (snapshot && nv.drawBitmap && rleEncode(nv.drawBitmap) !== snapshot) {
              drawHistory.current.push(snapshot);
              emitHistory();
            }
            try { nv.refreshDrawing(true); } catch (_e) {}
          } catch (_e) {}
          return;
        }
        // pen mode: flood-fill the enclosed loop to 0 on release.
        const { axCorSag, fillPts, savedAxCorSag } = saved;
        try {
          if (fillPts && fillPts.length >= 2) {
            const savedFillPts = nv.drawPenFillPts;
            const savedPenValue = nv.opts.penValue;
            const savedOnDrawingChanged = nv.onDrawingChanged;
            nv.onDrawingChanged = () => {};
            nv.drawPenAxCorSag = axCorSag;
            nv.drawPenFillPts = fillPts;
            nv.opts.penValue = 0;
            try { nv.drawPenFilled(); } finally {
              nv.onDrawingChanged = savedOnDrawingChanged;
              nv.drawPenFillPts = savedFillPts;
              nv.opts.penValue = savedPenValue;
            }
          }
          if (savedAxCorSag !== undefined) nv.drawPenAxCorSag = savedAxCorSag;
          if (snapshot && nv.drawBitmap && rleEncode(nv.drawBitmap) !== snapshot) {
            drawHistory.current.push(snapshot);
            emitHistory();
          }
          try { nv.refreshDrawing(true); } catch (_e) {}
        } catch (_e) {}
        return;
      }
      rightZoom = null;
    };
    canvas.addEventListener("pointerdown", handleRightDown);
    canvas.addEventListener("pointermove", handleRightMove);
    canvas.addEventListener("pointerup", handleRightUp);
    canvas.addEventListener("pointercancel", handleRightUp);

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
          // Same degenerate-affine guard replaceBaseVolume applies on a later
          // swap (lib/viewer/volumeApi.js) — this is the FIRST load, which
          // used to always be the well-formed MNI152 template and never
          // needed it, but can now also be a quick-opened user file.
          if (correctDegenerateAffineIfNeeded(nv.volumes[0])) {
            nv.updateGLVolume();
            toast.info("Centered automatically", {
              description: "This file had no spatial position info in its header.",
            });
          }
          // A 4D volume loaded via THIS path (nv.loadVolumes, the viewer's
          // first-ever load) can land on a non-zero frame4D — observed
          // landing partway through the series instead of frame 0, unlike
          // the same file loaded later via replaceBaseVolume/addVolumeFromUrl
          // (lib/viewer/volumeApi.js), which always starts at frame 0. Force
          // it explicitly so quick-opening a 4D file has a deterministic,
          // correct starting frame regardless of that discrepancy.
          if (nv.volumes[0].nFrame4D > 1) {
            nv.setFrame4D(nv.volumes[0].id, 0);
          }
        }
        setLoaded(true);
        updateTileSliceInfo();
        onReady?.(nv);
        // baseVolume.id is only "mni152" for the actual bundled template
        // (lib/atlasConfig.js); a quick-opened file gets its own id/name and
        // skips this (handleBaseUpload/markBaseLoadedExternally own its
        // messaging instead, matching how every other base-load route works).
        if (baseVolume.id === "mni152") toast.success("MNI152 template loaded");
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
    // Cached GPU texture-size limit (queried once) — see layoutCanvasBox's cap.
    let maxTexSizeCache = null;

    // In-plane aspect (width/height) of the current single-slice orientation,
    // from the base volume's RAS dims × pixel spacing.
    const sliceAspect = (orientation) => {
      const v = nvRef.current?.volumes?.[0];
      const d = v?.dimsRAS || v?.hdr?.dims;
      const p = v?.pixDimsRAS || v?.hdr?.pixDims;
      if (!d || !p) return 1;
      const X = Math.abs(d[1] * (p[1] || 1));
      const Y = Math.abs(d[2] * (p[2] || 1));
      const Z = Math.abs(d[3] * (p[3] || 1));
      if (orientation === "axial") return X / Y;
      if (orientation === "coronal") return X / Z;
      if (orientation === "sagittal") return Y / Z;
      return 1;
    };

    // Largest aspect-correct box (of the current single-slice orientation) that
    // fits the container — i.e. the whole slice at zoom 1. ZOOM-INDEPENDENT: it
    // depends only on container size + orientation, so it's the stable basis for
    // the backing-store resolution (see resizeCanvas). Returns null if unsized.
    const singleFitBox = () => {
      const vw = container?.clientWidth || 0;
      const vh = container?.clientHeight || 0;
      if (vw <= 0 || vh <= 0) return null;
      const aspect = sliceAspect(sliceTypeRef.current) || 1;
      let fitW = vw, fitH = vw / aspect;
      if (fitH > vh) { fitH = vh; fitW = vh * aspect; }
      return { fitW, fitH };
    };

    // Position/size the canvas ELEMENT (CSS box only — never the backing store).
    // Single-slice modes get an aspect-correct box scaled by singleFillZoom
    // (grows past the viewport, which is overflow-clipped, so zoom fills the
    // window); other modes fill the viewport. Because this only touches CSS, a
    // zoom step is a cheap element resize the browser composites — no WebGL
    // buffer reallocation (that realloc blanks the buffer → the jitter we fixed).
    const layoutCanvasBox = () => {
      // A single-slice sliceType with an active MULTI-tile customLayout means
      // asymmetric mode is overlaying a single-slice view (setAsymmetricLayout
      // switches nv to MULTIPLANAR + a 4-tile customLayout but does NOT change
      // sliceTypeRef) — treat that as non-single so the canvas isn't boxed for
      // one slice while 4 tiles are drawn into it (bug: tiles render outside
      // their rects). Normal single-tile modes (sliceType==="multiplanar" has
      // its own 4-tile grid too, but sliceTypeRef.current is never one of the
      // three single-slice strings there, so this only rescues asymmetric).
      const nv = nvRef.current;
      const single = ["axial", "coronal", "sagittal"].includes(sliceTypeRef.current)
        && !(nv?.customLayout?.length > 1);
      if (!single) {
        canvas.style.position = "";
        canvas.style.left = canvas.style.top = canvas.style.transform = "";
        // Drop the single-mode !important width/height so the stylesheet rule
        // `canvas.niivue-canvas { width/height: 100% !important }` governs again.
        canvas.style.removeProperty("width");
        canvas.style.removeProperty("height");
        return;
      }
      const fit = singleFitBox();
      if (!fit) return;
      const z = Math.max(1, singleFillZoomRef.current || 1);
      const boxW = fit.fitW * z, boxH = fit.fitH * z;
      canvas.style.position = "absolute";
      canvas.style.left = "50%";
      canvas.style.top = "50%";
      canvas.style.transform = "translate(-50%, -50%)";
      // index.css has `canvas.niivue-canvas { width/height: 100% !important }`;
      // a plain inline style can't beat an !important stylesheet rule, so set our
      // single-mode box with priority too (inline !important wins at equal weight).
      canvas.style.setProperty("width", `${Math.round(boxW)}px`, "important");
      canvas.style.setProperty("height", `${Math.round(boxH)}px`, "important");
    };

    const resizeCanvas = () => {
      try {
        const nv = nvRef.current;
        if (!nv || !canvas) return;
        layoutCanvasBox();
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
        // Same asymmetric-aware predicate as layoutCanvasBox — see its comment.
        const single = ["axial", "coronal", "sagittal"].includes(sliceTypeRef.current)
          && !(nv?.customLayout?.length > 1);
        // Backing-store (WebGL drawing buffer) resolution.
        //  • Single-slice: size from the ZOOM-INDEPENDENT 1× fit box × dpr × a
        //    supersample factor — NOT the zoom-grown CSS box. So a zoom step
        //    (which only grows the CSS box) leaves canvas.width/height unchanged,
        //    i.e. no buffer realloc, no blank-flash, no jitter. NiiVue keeps
        //    rendering the whole slice into this fixed buffer (native pan2Dxyzmm
        //    stays identity in single mode); the CSS growth + overflow-clip IS
        //    the zoom, GPU-composited by the browser. Supersample keeps it crisp
        //    up to ~SS× zoom; beyond that the fit-res render is upscaled (soft).
        //  • Other modes: match the CSS box (canvas fills the viewport).
        let pw, ph;
        if (single) {
          const fit = singleFitBox();
          if (!fit) return;
          const SS = 2;
          pw = Math.round(fit.fitW * dpr * SS);
          ph = Math.round(fit.fitH * dpr * SS);
        } else {
          pw = Math.round(cssW * dpr);
          ph = Math.round(cssH * dpr);
        }
        // Never exceed the GPU's max texture size (context loss / corruption).
        if (maxTexSizeCache == null) {
          try {
            const gl = nvRef.current?.gl;
            maxTexSizeCache = (gl && gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
          } catch (_e) { maxTexSizeCache = 4096; }
        }
        const cap = Math.max(512, Math.floor(maxTexSizeCache * 0.9));
        if (pw > cap || ph > cap) {
          const s = Math.min(cap / pw, cap / ph);
          pw = Math.round(pw * s);
          ph = Math.round(ph * s);
        }
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw;
          canvas.height = ph;
        }
        // Derive dpr from the ACTUAL backing-store/CSS ratio so NiiVue's
        // CSS→device pointer mapping (uiData.dpr) always matches the rendered
        // canvas — this is what eliminates the one-sided scroll dead zone, and
        // it stays correct as the CSS box grows on zoom (dpr shrinks to match).
        nv.uiData.dpr = canvas.width / cssW;
        nv.textSizePoints();
        nv.drawScene();
        recomputeMeasure2D();
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
    // Expose so zoom / orientation handlers can re-layout the single-slice box.
    resizeCanvasRef.current = resizeCanvas;
    resizeCanvas();

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
      try { canvas.removeEventListener("pointerdown", handleDrawStart); } catch (_e) {}
      try { canvas.removeEventListener("pointerup", handleDrawEnd); } catch (_e) {}
      try { canvas.removeEventListener("pointerdown", handleSphereToolDown); } catch (_e) {}
      try { canvas.removeEventListener("pointermove", handleSphereToolMove); } catch (_e) {}
      try { canvas.removeEventListener("pointerup", handleSphereToolUp); } catch (_e) {}
      try { canvas.removeEventListener("pointercancel", handleSphereToolUp); } catch (_e) {}
      try { sphereToolWrap?.removeEventListener("mousedown", blockNativeSphereToolMouse, true); } catch (_e) {}
      try { sphereToolWrap?.removeEventListener("mousemove", blockNativeSphereToolMouse, true); } catch (_e) {}
      try { sphereToolWrap?.removeEventListener("mouseup", blockNativeSphereToolMouse, true); } catch (_e) {}
      try { canvas.removeEventListener("pointerdown", snapshotDrawFreeze, true); } catch (_e) {}
      try { window.removeEventListener("pointerup", clearDrawFreeze, true); } catch (_e) {}
      try { window.removeEventListener("pointercancel", clearDrawFreeze, true); } catch (_e) {}
      try { canvas.removeEventListener("contextmenu", suppressContextMenu); } catch (_e) {}
      try { canvas.removeEventListener("pointerdown", handleRightDown); } catch (_e) {}
      try { canvas.removeEventListener("pointermove", handleRightMove); } catch (_e) {}
      try { canvas.removeEventListener("pointerup", handleRightUp); } catch (_e) {}
      try { canvas.removeEventListener("pointercancel", handleRightUp); } catch (_e) {}
      // Failure mode audited for item 117: cancelling without nulling would
      // leave redrawRafRef permanently non-null (a dead handle that will
      // never fire), silently short-circuiting every future scheduleRedraw()
      // withVolumeUpdate=true call for the rest of the session (StrictMode's
      // dev-only mount->cleanup->mount can hit this path). Reset it so a
      // fresh scheduleRedraw() after remount can schedule again.
      if (redrawRafRef.current != null) {
        cancelAnimationFrame(redrawRafRef.current);
        redrawRafRef.current = null;
      }
      // Tract-renderer GL resources (compiled programs cached per Niivue
      // instance) are created lazily inside the drawMesh3D override
      // installed above — release them here so they don't leak across
      // remounts/HMR. Also restores nv.drawMesh3D to niivue's original
      // implementation (idempotent — safe even if install never ran).
      uninstallTractRenderer(nv);
      uninstallVolumeClipPass(nv);
      uninstallCustomRenderShader(nv);
      // Dispose the NiiVue instance itself: removes its OWN internal
      // canvas listeners (wheel/mousedown/mouseup/mousemove/dblclick/
      // keyboard/touch/drag, registered via registerInteractions with an
      // AbortController) plus its own resize observer/listener. Without
      // this, React.StrictMode's dev-only double-invoke (mount->cleanup->
      // mount) leaves this first instance's listeners alive on the shared
      // canvas — an orphaned "ghost" instance that still holds the
      // original volume and redraws its stale scene on stray wheel events.
      // Safe/idempotent: internally null-guards its own observer/
      // controller refs, and touches no GL resources, so it doesn't
      // conflict with the tract-renderer/volume-clip-pass GL cleanup above
      // (uninstallTractRenderer/uninstallVolumeClipPass, formerly the
      // now-deleted ghost pass's cleanup) or this effect's own `window`
      // resize listener (already removed above; NiiVue tracks its own
      // separate resize listener internally).
      try { nv.cleanup?.(); } catch (_e) { /* best-effort teardown */ }
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
    // "multiplanar" always uses our own grid layout (see MULTIPLANAR_GRID_LAYOUT);
    // single-view modes use niivue's native rendering (no customLayout needed).
    // Asymmetric mode's own layout (set via setAsymmetricLayout) takes over
    // right after this when both toggle together — see that method.
    nv.customLayout = sliceType === "multiplanar" ? MULTIPLANAR_GRID_LAYOUT : [];
    nv.setSliceType(map[sliceType] ?? SLICE_TYPE.MULTIPLANAR);
    // Reset BOTH zoom systems on every view-mode change — resets the native
    // pan2Dxyzmm zoom too, so a stale multiplanar zoom can't stick in (and block
    // zoom-out of) a single slice. See resetAllZoom.
    resetAllZoom();
    // layoutCanvasBox() sizes the canvas box imperatively (bypassing React's
    // style diffing), so switching orientation — including between two
    // single-slice modes, whose style objects are identical — would otherwise
    // leave the canvas boxed for the PREVIOUS orientation until an unrelated
    // window resize happens to fire the ResizeObserver. Force a relayout here.
    resizeCanvasRef.current?.();
    recomputeMeasure2D();
    updateActiveTileHighlight();
    updateTileSliceInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sliceType, loaded]);

  useEffect(() => {
    updateActiveTileHighlight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrientation]);

  // crop-to-slab's 2D analogue. niivue frustum-clips the 2D mesh draw to a
  // slab of opts.meshThicknessOn2D mm (calculateMvpMatrix2D). The 3D
  // shader-side slab discard is disabled permanently, so this 2D mapping is
  // the ONLY place slabMM has any visible effect. There is no on/off toggle —
  // the slab is always active, so the mapping is unconditional (no more
  // `slabEnabled ? slabMM : 5` fallback). Also pushes the latest tractRender
  // prop into the live ref tractRenderStateRef (uniform-only, never
  // rebuilds) — Dashboard's own setTractRenderOptions push (via the
  // imperative handle) covers every field including this one; this effect
  // additionally owns the niivue-native opts.meshThicknessOn2D field, which
  // setTractRenderOptions does not touch.
  useEffect(() => {
    const nv = nvRef.current; if (!nv) return;
    nv.opts.meshThicknessOn2D = tractRender.slabMM;
    Object.assign(tractRenderStateRef.current, tractRender);
    // Measured bug, not a style choice. scheduleRedraw(false) defers to
    // requestAnimationFrame, and on this path that frame was never arriving —
    // the 2D tiles only picked up a changed meshThicknessOn2D when some other
    // canvas interaction happened to call drawScene() synchronously
    // afterward. Verified separately that drawScene() alone DOES honour a
    // changed meshThicknessOn2D (coronal tile: 2,054 tract px @2mm vs 5,537
    // @50mm), so the option plumbing was fine and only the redraw was
    // missing. Call drawScene() directly and synchronously here instead of
    // routing through scheduleRedraw — deliberately NOT changing
    // scheduleRedraw itself, which is used throughout this component and
    // elsewhere; widening this fix into it risks unrelated redraw regressions.
    nv.drawScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tractRender.slabMM]);

  // Recomputes the 2D-slice overlay positions for the current measurement
  // points. A point's marker+label only appears on a 2D tile whose displayed
  // slice matches that point's coordinate on the relevant axis —
  // frac2canvasPosWithTile returns null otherwise, which is exactly the
  // "only visible on the matching slice" behaviour asked for. Called after
  // every crosshair move, resize, layout change, and slice-type change.
  const recomputeMeasure2D = () => {
    const nv = nvRef.current;
    if (!nv) return;
    const pts = measurementPointsRef.current;
    if (!pts.length) { setMeasure2D((p) => (p.length ? [] : p)); return; }
    const dpr = nv.uiData?.dpr || 1;
    const out = [];
    for (const p of pts) {
      try {
        const frac = nv.mm2frac(p.mm);
        const hit = nv.frac2canvasPosWithTile?.(frac);
        if (hit?.pos) {
          out.push({
            id: p.id, label: p.label,
            colorIdx: (p.colorIdx ?? 0) % MEASURE_NBANDS,
            x: hit.pos[0] / dpr, y: hit.pos[1] / dpr,
          });
        }
      } catch (_e) { /* projection is best-effort */ }
    }
    setMeasure2D(out);
  };

  // Compute a volume's current world-space center (mm) via its own voxel-space
  // center and matRAS. dimsRAS/hdr.dims are NIfTI-style [ndims, nx, ny, nz, ...]
  // (see lib/volumeAnalysis.js's established indexing convention).
  const volumeCenterMM = (v) => {
    const d = v?.dimsRAS || v?.hdr?.dims;
    if (!d || !v?.matRAS) return null;
    const voxelCenter = [d[1] / 2, d[2] / 2, d[3] / 2];
    try {
      return v.vox2mm(voxelCenter, v.matRAS);
    } catch (_e) {
      return null;
    }
  };

  // If a volume's header has neither sform nor qform set (sform_code===0 &&
  // qform_code===0), nifti-reader-js falls back to a spec-documented "Method 0"
  // affine: diagonal voxel-size scaling with ZERO translation — so voxel (0,0,0)
  // lands at world (0,0,0)mm, meaning the volume's CORNER (not its center) sits
  // on the origin, and the volume renders shifted off into a corner / outside
  // the brain. Well-formed files (a real sform or qform — the vast majority)
  // are completely untouched by this check.
  // `targetVol`, if given, re-centers `vol` on THAT volume's current world
  // center (used for overlays, so they land on the base volume regardless of
  // where the base itself ended up); omitted/null re-centers on world origin
  // [0,0,0] (used for the base volume itself). Returns true if the correction
  // fired (caller is responsible for nv.updateGLVolume() + a toast).
  const correctDegenerateAffineIfNeeded = (vol, targetVol = null) => {
    try {
      if (!vol?.hdr) return false;
      if (vol.hdr.sform_code !== 0 || vol.hdr.qform_code !== 0) return false;
      const currentCenterMM = volumeCenterMM(vol);
      if (!currentCenterMM) return false;
      let targetCenterMM = [0, 0, 0];
      if (targetVol && targetVol !== vol) {
        const tc = volumeCenterMM(targetVol);
        if (tc) targetCenterMM = tc;
      }
      const translation = [
        targetCenterMM[0] - currentCenterMM[0],
        targetCenterMM[1] - currentCenterMM[1],
        targetCenterMM[2] - currentCenterMM[2],
      ];
      vol.applyTransform({ translation, rotation: [0, 0, 0], scale: [1, 1, 1] });
      return true;
    } catch (_e) {
      return false;
    }
  };

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

    // mrview-parity tractography global render controls.
    // Patches tractRenderStateRef.current in place — read live, every frame,
    // inside the drawMesh3D wrapper (lib/gl/tractRenderer.js) — so this NEVER
    // rebuilds a buffer, only changes what gets read as a uniform next
    // frame. setTractClip/setTractVisible live in lib/viewer/meshApi.js
    // (createMeshApi below) since they need meshMap, not tractRenderStateRef.
    setTractRenderOptions: (patch) => {
      const st = tractRenderStateRef.current;
      Object.assign(st, patch);
      if (patch.thicknessUI !== undefined) st.thicknessMM = sliderToThicknessMM(patch.thicknessUI);
      scheduleRedraw(false); // uniform-only: never rebuild
    },

    // Base/overlay volume load, threshold, colormap methods (lib/viewer/volumeApi.js).
    ...createVolumeApi(ctxRef.current, {
      correctDegenerateAffineIfNeeded, resetOverlayTexture, findVolume, emitHistory,
      setMeasure2D, setMeasureHover,
    }),

    // Measurement point markers (lib/viewer/markers.js).
    ...createMarkersApi(ctxRef.current, { recomputeMeasure2D }),

    // Asymmetric layout + canvas-px hit-testing (lib/viewer/layout.js).
    ...createLayoutApi(ctxRef.current, { updateActiveTileHighlight, updateTileSliceInfo, setSideLayout, setHoveredSlice }),

    // Mesh / tract loading + per-mesh display controls (lib/viewer/meshApi.js).
    ...createMeshApi(ctxRef.current, { scheduleRedraw }),

    // View & navigation: crosshair, clip plane, zoom/pan, slice stepping (lib/viewer/navigation.js).
    ...createNavigationApi(ctxRef.current, { scheduleRedraw, applyZoomFactor, resetAllZoom }),

    // 4D frame stepping for the base volume (lib/viewer/frameApi.js).
    ...createFrameApi(ctxRef.current, { scheduleRedraw }),

    // Save a PNG of the scene (lib/viewer/screenshot.js).
    ...createScreenshotApi(ctxRef.current),

    // Semi-automatic click-to-segment (lib/viewer/segmentation.js).
    ...createSegmentationApi(ctxRef.current),

    // Drawing API: enable/disable, tool mode, undo/redo, morph, sphere-paint,
    // interpolation, load/save (lib/viewer/drawingApi.js).
    ...createDrawingApi(ctxRef.current, {
      setDrawingActive, snapshotForUndo, emitHistory,
      interpolatablePair, distinctSliceEntriesForOrientation, rasterizeSphere,
    }),
    // Brush mode (2D/3D) setter — updates brushModeRef, which the pointer
    // handlers read live on every event.
    setBrushMode: (mode) => {
      brushModeRef.current = mode === "2D" ? "2D" : "3D";
    },
  }));

  return (
    <div className="relative h-full w-full bg-black overflow-hidden" data-testid="niivue-viewer">
      {/* In single-slice modes resizeCanvas() sizes/positions the canvas
          imperatively (aspect-correct box × fill-zoom), so the style prop must
          NOT set width/height there or React would clobber it each render. */}
      <canvas
        ref={canvasRef}
        className="niivue-canvas"
        id="niivue-canvas"
        data-testid="niivue-canvas"
        style={
          ["axial", "coronal", "sagittal"].includes(sliceType)
            ? { display: "block" }
            : { width: "100%", height: "100%", display: "block" }
        }
      />
      {/* Draw-mode indicator: accent inset border + badge. pointer-events:none so
          it never blocks painting on the canvas underneath. */}
      {drawingActive && (
        <div className="absolute inset-0 pointer-events-none z-20" data-testid="draw-mode-indicator">
          <div className="absolute inset-0 border-2 border-primary/80" />
          <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 bg-primary text-primary-foreground font-mono text-[10px] uppercase tracking-[0.2em] shadow">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-foreground animate-pulse" />
            {drawToolLabel ? `Draw Mode \u2013 ${drawToolLabel}` : "Draw Mode"}
          </div>
        </div>
      )}
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
      {/* Marks which 2D tile arrow-key slice-stepping currently targets
          (the last clicked/scrolled orientation) whenever more than one
          tile is visible. */}
      {activeTileRect && (
        <div className="absolute inset-0 pointer-events-none">
          <div
            className="absolute border-2 border-primary/60 transition-all duration-150"
            style={{
              left: `${activeTileRect[0] * 100}%`,
              top: `${activeTileRect[1] * 100}%`,
              width: `${activeTileRect[2] * 100}%`,
              height: `${activeTileRect[3] * 100}%`,
            }}
          />
        </div>
      )}
      {/* Per-tile slice-index readout, e.g. "Ax 84/182", bottom-right corner
          of each visible 2D tile. */}
      {tileSliceInfo.length > 0 && (
        <div className="absolute inset-0 pointer-events-none">
          {tileSliceInfo.map(({ key, position, text }) => {
            const [x, y, w, h] = position;
            return (
              <div
                key={key}
                className="absolute"
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
              >
                <span className="absolute bottom-1 right-1.5 text-[9px] font-mono tabular-nums text-white/50 bg-black/40 px-1 py-0.5 rounded-sm select-none">
                  {text}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {/* Measurement point markers (ruler A/B, midline landmark). Colors are
          fixed (not theme tokens) for the same reason as the side-layout
          labels above: this overlays the permanently-dark canvas, not an
          adaptive panel. */}
      {measure2D.length > 0 && (
        <div className="absolute inset-0 pointer-events-none">
          {measure2D.map((m) => {
            const rgb = MEASURE_COLORS_RGB[m.colorIdx].join(",");
            return (
              <div
                key={`measure2d-${m.id}`}
                className="absolute flex flex-col items-center"
                style={{ left: `${m.x}px`, top: `${m.y}px`, transform: "translate(-50%, -50%)" }}
              >
                <span
                  className="text-[13px] font-bold leading-none select-none"
                  style={{ color: `rgb(${rgb})`, textShadow: "0 0 3px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,0.9)" }}
                >
                  ×
                </span>
                <span
                  className="mt-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide px-1 rounded-sm select-none whitespace-nowrap"
                  style={{ color: `rgb(${rgb})`, background: "rgba(0,0,0,0.55)" }}
                >
                  {m.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {measureHover && (
        <div
          className="absolute pointer-events-none"
          style={{ left: `${measureHover.x}px`, top: `${measureHover.y - 16}px`, transform: "translate(-50%, -100%)" }}
        >
          <span
            className="block text-[10px] font-mono font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm select-none whitespace-nowrap"
            style={{
              color: `rgb(${MEASURE_COLORS_RGB[measureHover.colorIdx].join(",")})`,
              background: "rgba(0,0,0,0.75)",
              border: `1px solid rgb(${MEASURE_COLORS_RGB[measureHover.colorIdx].join(",")})`,
            }}
          >
            {measureHover.label}
          </span>
        </div>
      )}
      {brushHover && (
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            left: `${brushHover.x}px`,
            top: `${brushHover.y}px`,
            width: `${brushHover.diameterPx}px`,
            height: `${brushHover.diameterPx}px`,
            transform: "translate(-50%, -50%)",
            border: "1px solid rgba(255,255,255,0.85)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.65)",
          }}
        />
      )}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div className="h-1 w-32 bg-zinc-900 overflow-hidden">
              <div className="h-full w-1/3 bg-white animate-pulse" />
            </div>
            {/* Fixed gray, NOT theme-tokenized: this sits on the permanently-
                dark canvas backdrop (see bg-black above), not an adaptive
                panel — text-muted-foreground would go dark-on-dark in light
                theme. */}
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
