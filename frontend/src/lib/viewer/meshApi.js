import { NVMesh } from "@niivue/niivue";
import { toast } from "sonner";
import { applyFiberScalarColor } from "@/lib/viewer/meshGeometry";
import { disposeTractBuffers, autoStrideFor } from "@/lib/gl/tractBuffers";
import { POINT_BUDGET_TUBES } from "@/lib/gl/tractShaders";
import { pctToStride } from "@/lib/gl/tractSettings";

// Auto-stride budget used at load, for BOTH addMeshFromFile and
// addMeshFromUrl. POINT_BUDGET_TUBES (not the laxer POINT_BUDGET_LINES) is
// used unconditionally rather than reading the current geometry mode: it is
// the tighter of the two per-geometry budgets, so a tract auto-strided
// against it is guaranteed to also fit under Lines' budget if the user later
// switches geometry — the only cost is occasionally decimating a bit more
// than Lines strictly needs, never too little. Keeps this module free of any
// dependency on tractRenderStateRef (which lives in NiivueViewer.jsx).
function applyAutoStride(nv, mesh) {
  try {
    const stride = autoStrideFor(mesh, POINT_BUDGET_TUBES);
    if (stride > 1) {
      mesh.fiberDecimationStride = stride;
      mesh.updateFibers(nv.gl); // the patched version (tractBuffers.js) — recompacts mesh.__tract too
    }
  } catch (_e) { /* best-effort — a failed auto-stride just leaves the tract at its parsed density */ }
}

/**
 * Mesh / tract loading and per-mesh display controls.
 *
 * Backs the addMeshFromFile / addMeshFromUrl / setMeshScalarColor /
 * setMeshFiberColor / setMeshOpacity / removeMesh entries of NiivueViewer's
 * imperative handle. Method names, signatures and behaviour are unchanged —
 * this is a relocation, not a redesign.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef and meshMap.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {(withVolumeUpdate?: boolean) => void} deps.scheduleRedraw
 */
export function createMeshApi(ctx, { scheduleRedraw }) {
  const { nvRef, meshMap } = ctx;

  return {
    // ===== Mesh / tract loading =====
    // Reads the File directly via NVMesh.loadFromFile (FileReader-based, no
    // fetch) — this avoids the blob-URL fetch path in nv.loadMeshes, which
    // fails ("Failed to fetch") on some Electron/large-file cases. This path
    // parses and adds the mesh correctly; the "streamlines don't render" bug
    // was NOT here — it was a 3D-render depth-occlusion issue
    // in NiiVue itself, worked around in NiivueViewer.jsx where the Niivue
    // instance is constructed (search "Fiber/streamline 3D-render occlusion
    // workaround").
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
        // NVMesh.loadFromFile already built this mesh's
        // STRIDE=1 (undecimated) buffers during parsing — for a huge tract
        // (e.g. S35_1mm.trk: 479,457 streamlines) that would blow well past
        // the instanced-tube point budget on the very first frame.
        // applyAutoStride rebuilds at the smallest stride that fits before
        // the mesh ever draws; small tracts that already fit are untouched
        // (autoStrideFor returns 1 — no-op).
        applyAutoStride(nv, mesh);
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
        // See the identical comment in addMeshFromFile above.
        applyAutoStride(nv, mesh);
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

    // Solid-color tract mode: sets mesh.rgba255 (a real NVMesh
    // property — setProperty() just assigns this[key]=val + updateMesh()) and
    // switches fiberColor to "Fixed", the built-in niivue mode that reads
    // rgba255 for every streamline instead of per-segment direction/group
    // color (see the "fixed" branch in niivue's fiber-vertex colorizer).
    // Double-rebuild fix: this used to call
    // nv.setMeshProperty() twice — once for "rgba255", once for "fiberColor"
    // — i.e. two full mesh.updateFibers() rebuilds per colour-picker drag
    // frame. rgba255 is a plain NVMesh field (setProperty() just does
    // this[key]=val + updateMesh()), so assign it directly and let the single
    // remaining setMeshProperty("fiberColor", "Fixed") call do the one rebuild
    // that's actually necessary (Fixed mode reads rgba255 at rebuild time).
    // Verified type: NVMesh's own constructor default and every internal
    // colourizer read rgba255 as a Uint8Array (grep "rgba255" in
    // dist/index.js), so match that rather than a plain array.
    setMeshFixedColor: (id, rgb) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh || !Array.isArray(rgb) || rgb.length < 3) return;
      try {
        mesh.rgba255 = new Uint8Array([rgb[0], rgb[1], rgb[2], 255]);
        nv.setMeshProperty(mesh.id, "fiberColor", "Fixed"); // one rebuild, not two
      } catch (_e) {}
    },

    // NEVER route opacity through setMeshProperty. NVMesh's own
    // setProperty() calls updateMesh() -> updateFibers() unconditionally, and
    // Niivue.setMeshProperty() additionally calls updateGLVolume() — i.e.
    // every single slider tick rebuilt the entire tractogram (recompacted
    // every streamline, reuploaded both GL buffers) just to change a blend
    // uniform. Opacity is read live, per-frame, straight off mesh.opacity by
    // the tract renderer (lib/gl/tractRenderer.js) — it is a pure uniform
    // there, so a direct assignment + redraw is correct and sufficient.
    setMeshOpacity: (id, opacity) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      try {
        const idx = nv.meshes.indexOf(mesh);
        if (idx >= 0) {
          mesh.opacity = Math.max(0, Math.min(1, opacity));
          scheduleRedraw(false);
        }
      } catch (_e) {}
    },

    // Per-tract 3D-clip-plane opt-out. Read live every
    // frame by tractRenderer.js as `mesh.__tractClip` (default true when
    // undefined) — a plain field write, never a rebuild.
    setTractClip: (id, enabled) => {
      const mesh = meshMap.current.get(id);
      if (!mesh) return;
      mesh.__tractClip = !!enabled;
      scheduleRedraw(false);
    },

    // Per-tract visibility. `mesh.visible` is read by
    // both niivue's own shouldRenderMesh gate and tractRenderer.js's
    // isDrawableTract — a plain field write, never a rebuild.
    setTractVisible: (id, visible) => {
      const mesh = meshMap.current.get(id);
      if (!mesh) return;
      mesh.visible = !!visible;
      scheduleRedraw(false);
    },

    // The global display-fraction slider (TractographySection's
    // Rendering block). Display-fraction changes are exempt from
    // the "uniform-only, never rebuild" rule — fiberDecimationStride only
    // takes effect through mesh.updateFibers's index-building pass, so
    // a real rebuild is unavoidable here (unlike opacity/clip/visible above).
    // Applies uniformly to every currently loaded tract mesh, matching the
    // single global slider. NEVER nv.setMeshProperty — same reasoning as
    // setMeshOpacity above (it would additionally trigger updateGLVolume()
    // for nothing). Skips meshes already at the target stride so an
    // unrelated tract's rebuild isn't triggered by every debounced tick.
    setTractDisplayFraction: (pct) => {
      const nv = nvRef.current;
      if (!nv) return;
      const stride = pctToStride(pct);
      for (const mesh of meshMap.current.values()) {
        if (!mesh || !mesh.offsetPt0) continue; // tract meshes only
        if (mesh.fiberDecimationStride === stride) continue;
        try {
          mesh.fiberDecimationStride = stride;
          mesh.updateFibers(nv.gl); // the patched version — recompacts
        } catch (_e) {}
      }
      scheduleRedraw(false);
    },

    removeMesh: (id) => {
      const nv = nvRef.current;
      const mesh = meshMap.current.get(id);
      if (!nv || !mesh) return;
      // nv.removeMesh deletes niivue's own vaoFiber/vertexBuffer/indexBuffer
      // for this mesh but knows nothing about the compacted instanced-draw
      // buffers attached at mesh.__tract (lib/gl/tractBuffers.js) —
      // free those FIRST, before the mesh itself (and its gl context access
      // via meshMap) goes away, or they leak.
      try { disposeTractBuffers(nv.gl, mesh); } catch (_e) {}
      try { nv.removeMesh(mesh); } catch (_e) {}
      meshMap.current.delete(id);
    },
  };
}
