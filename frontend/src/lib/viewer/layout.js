import { SLICE_TYPE } from "@niivue/niivue";
import { MULTIPLANAR_GRID_LAYOUT } from "@/lib/viewer/layoutConstants";

/**
 * Asymmetric layout (1 large + 3 small stacked side views) and canvas-pixel
 * → slice-slot hit-testing.
 *
 * Backs the setAsymmetricLayout / getSliceAtCanvasPx entries of NiivueViewer's
 * imperative handle. Method names, signatures and behaviour are unchanged —
 * this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, sliceTypeRef, resizeCanvasRef, sideLayoutRef.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {() => void} deps.updateActiveTileHighlight
 * @param {() => void} deps.updateTileSliceInfo
 * @param {(v: any[]) => void} deps.setSideLayout
 * @param {(v: any) => void} deps.setHoveredSlice
 */
export function createLayoutApi(ctx, { updateActiveTileHighlight, updateTileSliceInfo, setSideLayout, setHoveredSlice }) {
  const { nvRef, sliceTypeRef, resizeCanvasRef, sideLayoutRef } = ctx;

  return {
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
