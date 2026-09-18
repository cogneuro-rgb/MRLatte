/**
 * Semi-automatic segmentation (NiiVue native click-to-segment).
 *
 * NiiVue grows a region by intensity similarity from the clicked voxel and
 * writes it into the draw bitmap (orientation handled internally), then
 * fires onClickToSegment with the segmented volume in mm3 / mL.
 *
 * Backs the setSegmentCallback / setClickToSegment / setSegmentTolerance
 * entries of NiivueViewer's imperative handle. Method names, signatures and
 * behaviour are unchanged — this is a relocation.
 *
 * @param {object} ctx  viewer context (see lib/viewer/context.js); uses
 *                      nvRef, clickToSegmentCb.
 */
export function createSegmentationApi(ctx) {
  const { nvRef, clickToSegmentCb } = ctx;

  return {
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
  };
}
