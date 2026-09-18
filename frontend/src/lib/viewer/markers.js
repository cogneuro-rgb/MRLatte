import { NVMesh } from "@niivue/niivue";
import { MEASURE_COLORS_RGB, MEASURE_NBANDS, appendSphere, appendCylinder } from "@/lib/viewer/meshGeometry";

/**
 * Measurement point markers (ruler A/B, midline landmark).
 *
 * Backs the setMeasurementPoints entry of NiivueViewer's imperative handle.
 * Method name, signature and behaviour are unchanged — this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, measurementMeshRef, measurementPointsRef.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {() => void} deps.recomputeMeasure2D
 */
export function createMarkersApi(ctx, { recomputeMeasure2D }) {
  const { nvRef, measurementMeshRef, measurementPointsRef } = ctx;

  return {
    // ===== Measurement point markers =====
    // points: Array<{ id, mm:[x,y,z], label, colorIdx }>.
    // edges:  Array<[i, j]> — node-index pairs to connect with a 3D segment
    //         (e.g. the two ends of a distance, or the two rays of an angle).
    // Entries with a missing/non-finite mm are dropped; edges referencing a
    // dropped node are skipped. Rebuilds the sphere+segment mesh from scratch
    // each call (cheap — only a handful of points).
    setMeasurementPoints: (points, edges = []) => {
      const nv = nvRef.current;
      if (!nv) return;
      // Keep original indices so edge references survive the validity filter.
      const kept = [];
      const remap = new Map();
      (points || []).forEach((p, origIdx) => {
        if (Array.isArray(p.mm) && p.mm.length === 3 && p.mm.every(Number.isFinite)) {
          remap.set(origIdx, kept.length);
          kept.push(p);
        }
      });
      measurementPointsRef.current = kept;

      if (measurementMeshRef.current) {
        try { nv.removeMesh(measurementMeshRef.current); } catch (_e) {}
        measurementMeshRef.current = null;
      }
      if (kept.length > 0) {
        try {
          const pts = [], tris = [], rgba = [];
          for (const p of kept) {
            const rgb = MEASURE_COLORS_RGB[(p.colorIdx ?? 0) % MEASURE_NBANDS];
            appendSphere(pts, tris, rgba, p.mm, 3, rgb);
          }
          for (const [a, b] of edges || []) {
            const ma = remap.get(a), mb = remap.get(b);
            if (ma != null && mb != null) {
              const rgb = MEASURE_COLORS_RGB[(kept[ma].colorIdx ?? 0) % MEASURE_NBANDS];
              appendCylinder(pts, tris, rgba, kept[ma].mm, kept[mb].mm, 0.6, rgb);
            }
          }
          const mesh = new NVMesh(
            new Float32Array(pts), new Uint32Array(tris), "measurement_points",
            new Uint8Array(rgba), 1.0, true, nv.gl
          );
          nv.addMesh(mesh);
          measurementMeshRef.current = mesh;
        } catch (e) {
          console.warn("measurement point sphere mesh failed:", e);
        }
      }
      // In the 3D render, NiiVue's volume raycast pass writes depth across its
      // whole bounding box (even fully-transparent voxels), which depth-tests
      // out any mesh sitting inside that box — our markers were being drawn
      // but fully occluded. opts.meshXRay makes NiiVue re-draw meshes in a
      // second, depth-test-free pass; nothing else in this app reads/sets it,
      // so the measurement feature can own it outright: on while any markers
      // exist, off (NiiVue's own default) otherwise.
      nv.opts.meshXRay = kept.length > 0 ? 1.0 : 0.0;
      recomputeMeasure2D();
      nv.drawScene();
    },
  };
}
