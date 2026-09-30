import { SLICE_TYPE } from "@niivue/niivue";
import { MULTIPLANAR_GRID_LAYOUT } from "@/lib/viewer/layoutConstants";
import { MOSAIC_AXIS_INDEX, buildMosaicString, clampMosaicCenter } from "@/lib/viewer/mosaic";

/**
 * Asymmetric layout (1 large + 3 small stacked side views) and canvas-pixel
 * → slice-slot hit-testing.
 *
 * Backs the setAsymmetricLayout / getSliceAtCanvasPx entries of NiivueViewer's
 * imperative handle. Method names, signatures and behaviour are unchanged —
 * this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, sliceTypeRef, resizeCanvasRef, sideLayoutRef,
 *                       mosaicRef.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {() => void} deps.updateActiveTileHighlight
 * @param {() => void} deps.updateTileSliceInfo
 * @param {(v: any[]) => void} deps.setSideLayout
 * @param {(v: any) => void} deps.setHoveredSlice
 */
export function createLayoutApi(ctx, { updateActiveTileHighlight, updateTileSliceInfo, setSideLayout, setHoveredSlice }) {
  const { nvRef, sliceTypeRef, resizeCanvasRef, sideLayoutRef, mosaicRef } = ctx;

  // World-mm extent of the base volume along one axis (0=x, 1=y, 2=z), in the
  // same frac→mm convention drawMosaic uses to place its slices.
  const axisExtentMM = (nv, ax) => {
    const a = nv.frac2mm([0, 0, 0])[ax], b = nv.frac2mm([1, 1, 1])[ax];
    return [Math.min(a, b), Math.max(a, b)];
  };

  const applyMosaic = (nv, m) => {
    const [lo, hi] = axisExtentMM(nv, MOSAIC_AXIS_INDEX[m.axis]);
    m.centerMM = clampMosaicCenter(m.centerMM, m.count * m.rows, m.gapMM, lo, hi);
    mosaicRef.current = m;
    // Centre the grid in the viewer: a multi-row grid is height-limited and
    // would otherwise hug the left edge (niivue's default is top-left).
    nv.opts.centerMosaic = true;
    nv.setSliceMosaicString(buildMosaicString(m.axis, m.count, m.gapMM, m.centerMM, m.rows));
    nv.drawScene(); // fills nv.screenSlices, which the tile readouts read
    updateTileSliceInfo();
  };

  return {
    // ===== Horizontal mosaic strip =====
    // spec = { axis: "A"|"C"|"S", count (per row), rows, gapMM }, or null to
    // leave mosaic.
    // The strip's centre is kept here, not in the spec: it starts on the
    // crosshair (on entry, or when the orientation changes) and afterwards
    // only moves via shiftMosaic, so changing count/gap keeps the strip
    // where the user scrolled it.
    setMosaic: (spec) => {
      const nv = nvRef.current;
      if (!nv?.volumes?.length) return;
      if (!spec) {
        if (!mosaicRef.current) return;
        mosaicRef.current = null;
        nv.setSliceMosaicString("");
        updateTileSliceInfo();
        return;
      }
      const prev = mosaicRef.current;
      const centerMM = prev && prev.axis === spec.axis
        ? prev.centerMM
        : nv.frac2mm(nv.scene.crosshairPos)[MOSAIC_AXIS_INDEX[spec.axis]];
      applyMosaic(nv, { ...spec, centerMM });
    },

    // Slide the strip by `tiles` slice gaps (±1 per scroll notch).
    shiftMosaic: (tiles) => {
      const nv = nvRef.current;
      const m = mosaicRef.current;
      if (!nv || !m) return;
      applyMosaic(nv, { ...m, centerMM: m.centerMM + tiles * m.gapMM });
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
        mosaic: ST.AXIAL, // Dashboard re-applies the mosaic string after this
      };
      if (!largeSlice) {
        // Restore whatever slice type was active before asymmetric mode.
        // Hardcoding MULTIPLANAR here is the bug — use the tracked ref instead.
        nv.customLayout = sliceTypeRef.current === "multiplanar" ? MULTIPLANAR_GRID_LAYOUT : [];
        nv.setSliceType(sliceMap[sliceTypeRef.current] ?? ST.MULTIPLANAR);
        // Recompute the canvas box for the restored layout (bug fix: leaving
        // asymmetric's customLayout unset without this left the canvas boxed
        // for asymmetric's shape until an unrelated resize happened to fire).
        // resizeCanvas() already calls drawScene()/recomputeMeasure2D() itself.
        resizeCanvasRef.current?.();
        updateActiveTileHighlight();
        updateTileSliceInfo();
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
      // Recompute the canvas box for the new asymmetric layout NOW (bug fix:
      // entering asymmetric from a single-slice view left the canvas boxed for
      // one slice — aspect-correct, absolutely centered, supersampled — while
      // 4 tiles were drawn into it, so tiles rendered outside their rects).
      // resizeCanvas() already calls drawScene()/recomputeMeasure2D() itself.
      resizeCanvasRef.current?.();
      updateActiveTileHighlight();
      updateTileSliceInfo();
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
  };
}
