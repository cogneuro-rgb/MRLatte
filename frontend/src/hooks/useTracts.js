import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { buildTractReportModel } from "@/lib/htmlReport";
import { tractSubsampleAvailable, subsampleTract } from "@/lib/tractography";
import { pctToStride } from "@/lib/gl/tractSettings";

const MESH_EXTS = [".trk", ".tck", ".trx", ".vtk", ".gii", ".mz3", ".obj", ".stl", ".ply"];
// NiiVue parses tractograms entirely in the WebGL renderer (one contiguous
// ArrayBuffer + several typed-array copies), so files past this size reliably
// exhaust the renderer's memory. Larger files are decimated on the backend.
const TRACT_CLIENT_MAX_BYTES = 700 * 1024 * 1024; // ~700 MB
const TRACT_RGB_PALETTE = [
  [255, 165, 0, 255],
  [120, 200, 255, 255],
  [180, 80, 255, 255],
  [80, 230, 180, 255],
  [255, 90, 140, 255],
];

// "#rrggbb" -> [r,g,b] (0-255), or null for anything malformed. Used by the
// item-97 solid-color tract picker.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// nStreamlines = mesh.offsetPt0.length-1 and nPoints = mesh.pts.length/3 are
// the TOTAL counts (fiberDecimationStride
// only filters the index array; offsetPt0/pts always hold every parsed vertex,
// undecimated). shownStreamlines is the extra field this module adds on top:
// the count actually surviving mesh's CURRENT fiberDecimationStride (1 unless
// meshApi's load-time autoStrideFor decimated it, or the display-fraction
// slider has been moved since) — without this, the sidebar readout would read
// "100%" immediately after a huge auto-strided load, which is exactly the
// "decimation invisible" failure T5 exists to fix.
function tractCountsFromMesh(mesh) {
  const nStreamlines = mesh?.offsetPt0 ? mesh.offsetPt0.length - 1 : 0;
  const nPoints = mesh?.pts ? mesh.pts.length / 3 : 0;
  const stride = mesh?.fiberDecimationStride > 0 ? mesh.fiberDecimationStride : 1;
  const shownStreamlines = stride > 1 ? Math.ceil(nStreamlines / stride) : nStreamlines;
  return { nStreamlines, nPoints, shownStreamlines };
}

/**
 * Tract / mesh layer load, remove, opacity, direction, save, and HTML report
 * export. Extracted from Dashboard.jsx; behaviour is unchanged — this is a
 * relocation, not a redesign. Call sites elsewhere in Dashboard keep the
 * exact same handler names via destructuring.
 *
 * @param {object} deps
 * @param {React.MutableRefObject} deps.viewerRef
 * @param {Array} deps.tractLayers
 * @param {(updater: any) => void} deps.setTractLayers
 * @param {(v: any) => void} deps.setTractLoading
 * @param {(v: any) => void} deps.setTractLoadError
 * @param {React.MutableRefObject} deps.tractDirectionMap
 * @param {object} [deps.tractRender] global tractography render settings
 * @param {(updater: any) => void} [deps.setTractRender]
 */
export function useTracts({
  viewerRef,
  tractLayers,
  setTractLayers,
  setTractLoading,
  setTractLoadError,
  tractDirectionMap,
  tractRender,
  setTractRender,
}) {
  // ===== Tract files (.trk/.tck/.trx) =====
  const handleTractUpload = async (file) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const lower = file.name.toLowerCase();
    if (!MESH_EXTS.some((ext) => lower.endsWith(ext))) {
      return toast.error("Unsupported tract format", { description: "Use .trk, .tck, .trx, .vtk, .gii, .mz3" });
    }
    const id = `tract-${Date.now()}`;
    const rgba = TRACT_RGB_PALETTE[tractLayers.length % TRACT_RGB_PALETTE.length];
    const colorByDirection = lower.endsWith(".trk") || lower.endsWith(".tck") || lower.endsWith(".trx");
    setTractLoading({ name: file.name, phase: "Reading file…" });
    setTractLoadError(null);
    try {
      // Files too large for the in-browser parser are decimated server-side
      // first; the smaller result is what actually gets rendered.
      let fileToLoad = file;
      let subsampled = false;
      if (file.size > TRACT_CLIENT_MAX_BYTES) {
        setTractLoading({ name: file.name, phase: "Checking server…" });
        if (!(await tractSubsampleAvailable())) {
          setTractLoadError({
            name: file.name,
            message:
              "File too large to render in-browser and the backend is not running. Start the backend (uvicorn) or use a smaller tractogram.",
          });
          return;
        }
        setTractLoading({ name: file.name, phase: "Subsampling on server…" });
        try {
          fileToLoad = await subsampleTract(file);
          subsampled = true;
        } catch (e) {
          setTractLoadError({ name: file.name, message: e?.message || "Server subsampling failed" });
          return;
        }
      }
      const mesh = await viewer.addMeshFromFile(fileToLoad, {
        rgba255: rgba, opacity: 1.0, name: id, colorByDirection,
        onProgress: (phase) => setTractLoading({ name: file.name, phase }),
        onError: (message) => setTractLoadError({ name: file.name, message }),
      });
      if (mesh) {
        // colorMode drives niivue's fiberColor: "direction" -> Local
        // (per-segment DTI RGB), "palette" -> Global (the pre-existing
        // default, an auto-assigned distinguishing color from
        // TRACT_RGB_PALETTE), "solid" -> Fixed (a user-chosen custom
        // color via setMeshFixedColor). tractDirectionMap keeps its original
        // boolean meaning (true only for "direction") since nothing else
        // reads it.
        tractDirectionMap.current[id] = colorByDirection;
        const sizeLabel = `${(file.size / 1024).toFixed(1)} KB`;
        setTractLayers((p) => [
          ...p,
          { id, name: `Tract · ${file.name}`, visible: true, opacity: 1.0,
            color: `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`,
            colorMode: colorByDirection ? "direction" : "palette",
            solidColor: "#c8c8c8",
            description: subsampled ? `${sizeLabel} · subsampled` : sizeLabel,
            // Desktop-only real filesystem path (item 13's hover tooltip);
            // null in the browser build, where File objects carry no path.
            fullPath: window.mrlatte?.getPathForFile?.(file) || null,
            clip: true,          // per-tract 3D-clip-plane opt-out
            // nStreamlines/nPoints are the TOTAL (undecimated)
            // counts; shownStreamlines reflects meshApi's load-time
            // autoStrideFor decimation (or 1:1 if the tract already fit the
            // budget) — see tractCountsFromMesh above.
            ...tractCountsFromMesh(mesh),
          },
        ]);
        toast.success("Tract loaded", { description: file.name });
      }
    } finally {
      setTractLoading(null);
    }
  };
  // 3-way tract color mode. "solid" additionally needs the chosen
  // hex color pushed to the viewer (setMeshFixedColor); the other two modes
  // just switch niivue's built-in fiberColor.
  const handleTractColorMode = (id, mode, solidColor) => {
    setTractLayers((p) => p.map((l) => (l.id === id
      ? { ...l, colorMode: mode, ...(solidColor ? { solidColor } : {}) }
      : l)));
    tractDirectionMap.current[id] = mode === "direction";
    if (mode === "solid") {
      const hex = solidColor || tractLayers.find((l) => l.id === id)?.solidColor || "#c8c8c8";
      const rgb = hexToRgb(hex);
      if (rgb) viewerRef.current?.setMeshFixedColor(id, rgb);
    } else {
      viewerRef.current?.setMeshFiberColor(id, mode === "direction" ? "Local" : "Global");
    }
  };
  // Live-updates the solid color without touching colorMode — used while the
  // user is still dragging/typing in the color picker.
  const handleTractSolidColor = (id, hex) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, solidColor: hex } : l)));
    const rgb = hexToRgb(hex);
    if (rgb) viewerRef.current?.setMeshFixedColor(id, rgb);
  };
  const handleTractOpacity = (id, v) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, opacity: v } : l)));
    viewerRef.current?.setMeshOpacity(id, v);
  };
  const handleTractRemove = (id) => {
    viewerRef.current?.removeMesh(id);
    setTractLayers((p) => p.filter((l) => l.id !== id));
  };

  // The display-fraction slider's rebuild timer. Display-fraction changes are
  // exempt from "uniform-only, never rebuild" (see
  // meshApi.js's setTractDisplayFraction) — but a rebuild per slider TICK
  // would call mesh.updateFibers() on every pixel of drag. Debounced 150ms;
  // cleared on every re-entry (a new patch before the timer fires) AND on
  // unmount, so no updateFibers() fires after the mesh/viewer is gone.
  const displayFractionTimerRef = useRef(null);
  useEffect(() => () => {
    if (displayFractionTimerRef.current) {
      clearTimeout(displayFractionTimerRef.current);
      displayFractionTimerRef.current = null;
    }
  }, []);

  // Global rendering controls (geometry/lighting/thickness/slab/
  // display-fraction) — merges a patch into the shared tractRender state,
  // which Dashboard.jsx pushes to the viewer via setTractRenderOptions
  // (uniform-only, never rebuilds). There is one exception:
  // a displayPct patch ALSO (a) updates every tract layer's shownStreamlines
  // readout immediately (cheap — just arithmetic on already-known counts) and
  // (b) debounces the real mesh.fiberDecimationStride rebuild via
  // viewer.setTractDisplayFraction, which is the only tract-render control
  // that touches GL buffers rather than a pure per-frame uniform.
  const handleTractRenderChange = (patch) => {
    setTractRender?.((p) => ({ ...p, ...patch }));
    if (patch.displayPct !== undefined) {
      const stride = pctToStride(patch.displayPct);
      setTractLayers((p) => p.map((l) => (
        l.nStreamlines ? { ...l, shownStreamlines: Math.ceil(l.nStreamlines / stride) } : l
      )));
      if (displayFractionTimerRef.current) clearTimeout(displayFractionTimerRef.current);
      displayFractionTimerRef.current = setTimeout(() => {
        displayFractionTimerRef.current = null;
        viewerRef.current?.setTractDisplayFraction(patch.displayPct);
      }, 150);
    }
  };

  // Per-tract eye toggle: mirrors into tractLayers (drives the UI) and the
  // viewer (mesh.visible — a plain field write, never a rebuild).
  const handleTractVisible = (id, v) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, visible: v } : l)));
    viewerRef.current?.setTractVisible(id, v);
  };

  // Per-tract 3D-clip-plane opt-out toggle: same pattern as handleTractVisible.
  const handleTractClip = (id, v) => {
    setTractLayers((p) => p.map((l) => (l.id === id ? { ...l, clip: v } : l)));
    viewerRef.current?.setTractClip(id, v);
  };

  // Report model for a saved dissected tract now managed under Tractography
  // (item 103: TractographySection owns the ReportDialog and calls
  // buildReport("tract", model) — the same model shape Tract Dissection's
  // own report uses, built with the same buildTractReportModel here).
  const buildTractReportModelFor = (t) => (t.result ? buildTractReportModel(t.result, t.lesionName) : null);

  // "Save Tract" (item 58) — the dissected mesh is already loaded in the
  // viewer (TractDissectionPanel._loadResults); register it into tractLayers
  // with id = the EXISTING mesh name so handleTractRemove/handleTractOpacity
  // act on that mesh directly, instead of re-loading a duplicate.
  const handleSaveTract = (meshName, displayName, meta = {}) => {
    // The dissected mesh is already loaded (see the doc comment
    // above), so its counts are read straight off the live NVMesh via the
    // viewer rather than threaded through as an extra parameter — mirrors how
    // handleTractUpload reads them off the mesh addMeshFromFile just returned.
    const nv = viewerRef.current?.getNiivue?.();
    const mesh = nv?.meshes?.find((m) => m.name === meshName);
    setTractLayers((p) => {
      if (p.some((l) => l.id === meshName)) return p; // already registered
      return [
        ...p,
        {
          id: meshName, name: displayName, visible: true, opacity: 1.0,
          color: "rgb(200,200,200)", colorMode: "direction", solidColor: "#c8c8c8",
          description: "Dissected tract",
          result: meta.result || null,
          lesionName: meta.lesionName || null,
          clip: true,          // per-tract 3D-clip-plane opt-out
          ...tractCountsFromMesh(mesh),
        },
      ];
    });
    tractDirectionMap.current[meshName] = true;
  };

  return {
    handleTractUpload,
    handleTractColorMode,
    handleTractSolidColor,
    handleTractOpacity,
    handleTractRemove,
    buildTractReportModelFor,
    handleSaveTract,
    handleTractRenderChange,
    handleTractVisible,
    handleTractClip,
  };
}
