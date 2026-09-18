/**
 * Zoom math shared by wheel/keyboard zoom, the right-drag zoom handler, and
 * the setAsymmetricLayout / resetZoomPan imperative-handle methods.
 *
 * Returns bound closures (not a class) so call sites in NiivueViewer keep the
 * exact same local names (`applyZoomFactor`, `resetAllZoom`) they had when
 * these were component-scope functions — only where they're DEFINED moved,
 * not how they're called.
 *
 * @param {object} ctx   viewer context; uses nvRef, sliceTypeRef,
 *                       singleFillZoomRef, resizeCanvasRef.
 * @param {object} deps
 * @param {(z: number) => void} deps.setSingleFillZoom
 * @param {(withVolumeUpdate?: boolean) => void} deps.scheduleRedraw
 */
export function createZoomMath(ctx, { setSingleFillZoom, scheduleRedraw }) {
  const { nvRef, sliceTypeRef, singleFillZoomRef, resizeCanvasRef } = ctx;

  // Apply a multiplicative zoom step. Single-slice modes grow the canvas box
  // (singleFillZoom) so the slice fills the window; other modes use NiiVue's 2D
  // pan-zoom. Shared by wheel/keyboard zoom (no anchor — matches NiiVue's own
  // zoom2D behaviour pre-dating this) and the right-drag zoom handler (anchorMM
  // = crosshair mm, re-centering the pan the same way NiiVue's own wheel-zoom
  // does via calculatePanOffsetAfterZoom, so the drag doesn't drift the view).
  const applyZoomFactor = (factor, anchorMM = null) => {
    const nv = nvRef.current;
    if (!nv?.scene?.pan2Dxyzmm) return;
    const single = ["axial", "coronal", "sagittal"].includes(sliceTypeRef.current);
    if (single) {
      const z = Math.max(1, Math.min(8, (singleFillZoomRef.current || 1) * factor));
      if (z !== singleFillZoomRef.current) {
        singleFillZoomRef.current = z;
        setSingleFillZoom(z);
        resizeCanvasRef.current?.();
      }
      return;
    }
    const p = nv.scene.pan2Dxyzmm;
    const cur = p[3] || 1;
    const next = Math.max(0.2, Math.min(10, cur * factor));
    let [px, py, pz] = p;
    if (anchorMM) {
      const zoomChange = cur - next;
      px += zoomChange * anchorMM[0];
      py += zoomChange * anchorMM[1];
      pz += zoomChange * anchorMM[2];
    }
    try { nv.setPan2Dxyzmm([px, py, pz, next]); } catch (_e) {}
    if (anchorMM && nv.opts.yoke3Dto2DZoom) nv.scene.volScaleMultiplier = next;
    scheduleRedraw(false);
  };

  // Reset BOTH zoom systems to identity: NiiVue's native pan/zoom (pan2Dxyzmm,
  // used by multiplanar / asymmetric / 3D-render) AND the single-slice fill-zoom
  // (singleFillZoom, canvas-box growth). They MUST be reset together on any
  // view-mode change — otherwise a zoom from one mode leaks into another. The
  // binding case: multiplanar zoom writes pan2Dxyzmm[3]; switching to a single
  // slice, NiiVue keeps applying that stale native zoom while single-mode zoom
  // only drives singleFillZoom, so you can't zoom out (or can't fully zoom in
  // after a zoomed-out multiplanar). setPan2Dxyzmm also resets volScaleMultiplier
  // (the 3D yoke). Callers own the subsequent relayout/redraw.
  const resetAllZoom = () => {
    const nv = nvRef.current;
    if (!nv) return;
    try { nv.setPan2Dxyzmm([0, 0, 0, 1]); } catch (_e) {}
    if (singleFillZoomRef.current !== 1) {
      singleFillZoomRef.current = 1;
      setSingleFillZoom(1);
    }
  };

  return { applyZoomFactor, resetAllZoom };
}
