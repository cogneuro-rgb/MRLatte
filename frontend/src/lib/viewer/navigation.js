import { DRAG_MODE } from "@niivue/niivue";

/**
 * View & navigation controls: crosshair placement/appearance, clip plane,
 * zoom/pan, slice stepping, radiological convention, orientation labels and
 * right-drag mode.
 *
 * Backs the corresponding entries of NiivueViewer's imperative handle. Method
 * names, signatures and behaviour are unchanged — this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, rightDragModeRef and resizeCanvasRef.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {(withVolumeUpdate?: boolean) => void} deps.scheduleRedraw
 * @param {(factor: number) => void} deps.applyZoomFactor
 * @param {() => void} deps.resetAllZoom
 */
export function createNavigationApi(ctx, { scheduleRedraw, applyZoomFactor, resetAllZoom }) {
  const { nvRef, rightDragModeRef, resizeCanvasRef } = ctx;

  return {
    setCrosshairMM: (x, y, z) => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        // niivue's public-ish API: mm2frac → set scene.crosshairPos → drawScene.
        const frac = nv.mm2frac?.([x, y, z]);
        if (frac && nv.scene) {
          nv.scene.crosshairPos = frac;
          // Fire the same location callback a click would, so the mm/vox/value
          // readout and the atlas-label bar refresh to the jumped-to point
          // (drawScene alone never re-runs it). Used by the atlas region-nav
          // buttons and the visfAtlas auto-jump.
          try { nv.createOnLocationChange(); } catch (_e) {}
          nv.drawScene();
        }
      } catch (_e) {}
    },

    setClipPlane: (depth, az = 0, el = 0) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.setClipPlane([depth, az, el]);
      nv.opts.clipPlaneColor = [0, 0, 0, 0];
      scheduleRedraw(false);
    },

    // ===== View & navigation =====
    // Radiological convention: horizontally mirrors AXIAL + CORONAL views
    // (sagittal untouched); NiiVue also flips the L/R orientation labels to
    // match. off = neurological (the default).
    setRadiologicalConvention: (on) => {
      const nv = nvRef.current;
      if (!nv) return;
      try { nv.setRadiologicalConvention(!!on); } catch (_e) {}
      scheduleRedraw(false);
    },

    // Toggle NiiVue's native A/P/S/I/L/R orientation letters on the 2D tiles.
    setOrientationLabels: (on) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.opts.isOrientationTextVisible = !!on;
      scheduleRedraw(false);
    },

    // Zoom the 2D slices by a step. delta > 0 zooms in, < 0 out. pan2Dxyzmm is
    // [x, y, z, zoom]; we scale index 3 and clamp to a sane range.
    zoom2D: (delta) => {
      const nv = nvRef.current;
      if (!nv?.scene?.pan2Dxyzmm) return;
      applyZoomFactor(delta > 0 ? 1.1 : 1 / 1.1);
    },

    resetZoomPan: () => {
      const nv = nvRef.current;
      if (!nv) return;
      resetAllZoom();
      resizeCanvasRef.current?.();
      scheduleRedraw(false);
    },

    // Step the crosshair (and thus the displayed slice) by ±1 voxel along an
    // axis: axis 0/1/2 = i/j/k. Used by keyboard slice navigation.
    stepSlice: (axis = 2, dir = 1) => {
      const nv = nvRef.current;
      if (!nv) return;
      const d = [0, 0, 0];
      d[axis] = dir > 0 ? 1 : -1;
      try { nv.moveCrosshairInVox(d[0], d[1], d[2]); } catch (_e) {}
    },

    // Right-drag behaviour: "zoom" (default — our own custom drag-zoom, see
    // handleRightDown/Move in the setup effect), "windowing" (brightness/
    // contrast), or "pan". Left-click is ALWAYS crosshair (when not drawing)
    // and is never touched here — this only configures the RIGHT button.
    // "zoom" sets rightButton to DRAG_MODE.none so NiiVue's native handling is
    // inert for right-click (exactly as the constructor's initial config did)
    // and our own pointer handlers own the drag; "windowing"/"pan" hand the
    // right button to NiiVue's own native drag handling via mouseEventConfig,
    // and our own handlers back off (see rightDragModeRef checks below).
    setDragMode: (mode) => {
      const nv = nvRef.current;
      if (!nv) return;
      const m = mode === "windowing" || mode === "pan" ? mode : "zoom";
      rightDragModeRef.current = m;
      const map = { zoom: DRAG_MODE.none, windowing: DRAG_MODE.windowing, pan: DRAG_MODE.pan };
      const dm = map[m];
      try {
        if (nv.opts.mouseEventConfig?.rightButton !== undefined) {
          nv.opts.mouseEventConfig.rightButton = dm;
        }
      } catch (_e) {}
      scheduleRedraw(false);
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
  };
}
