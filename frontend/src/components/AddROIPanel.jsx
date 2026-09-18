import React, { useState, useEffect } from "react";
import { Target, Download, Crosshair } from "lucide-react";
import { createSphereROI, roiResultUrl } from "@/lib/roi";
import { colormapGradient } from "@/lib/colormaps";
import { toast } from "sonner";

// Curated colormaps offered for ROIs. Solid-ish maps read clearly as a mask.
const ROI_COLORMAPS = ["red", "green", "blue", "warm", "cool", "winter", "plasma", "viridis"];

export const AddROIPanel = ({ viewerRef, clearNonce, onRoiFile }) => {
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [z, setZ] = useState("0");
  const [radius, setRadius] = useState("5");
  const [label, setLabel] = useState("ROI");
  const [colormap, setColormap] = useState("red");
  const [busy, setBusy] = useState(false);
  const [lastRoi, setLastRoi] = useState(null);

  // Clear All removes the ROI overlay volume from the viewer; drop the stale
  // result card / download link here to match.
  useEffect(() => {
    if (clearNonce) setLastRoi(null);
  }, [clearNonce]);

  const useCrosshair = () => {
    try {
      const nv = viewerRef.current?.getNiivue?.();
      const mm = nv?.frac2mm?.(nv.scene.crosshairPos);
      if (mm && mm.length >= 3 && mm.every((v) => Number.isFinite(v))) {
        setX(mm[0].toFixed(1));
        setY(mm[1].toFixed(1));
        setZ(mm[2].toFixed(1));
      } else {
        toast.error("Crosshair position unavailable.");
      }
    } catch {
      toast.error("Crosshair position unavailable.");
    }
  };

  const createROI = async () => {
    const nx = parseFloat(x), ny = parseFloat(y), nz = parseFloat(z);
    const nr = parseFloat(radius);
    if (![nx, ny, nz].every(Number.isFinite)) {
      toast.error("Enter numeric X, Y, Z coordinates (mm).");
      return;
    }
    if (!Number.isFinite(nr) || nr <= 0) {
      toast.error("Radius must be a positive number (mm).");
      return;
    }

    setBusy(true);
    try {
      const info = await createSphereROI({
        x: nx, y: ny, z: nz, radius: nr, label: label || "ROI",
      });
      setLastRoi(info);

      const overlayId = `roi-${info.id}`;
      await viewerRef.current?.addOverlayFromUrl?.({
        url: roiResultUrl(info.file),
        id: overlayId,
        colormap,
        opacity: 0.7,
        cal_min: 0.5,
        cal_max: 1,
        ignoreZeroVoxels: true,
      });

      // Register the ROI as a user layer + cached file (without re-adding the
      // overlay — it's already loaded above) so it appears in the sidebar
      // layer list and becomes selectable as a Tract Dissection seed.
      if (onRoiFile) {
        try {
          const resp = await fetch(roiResultUrl(info.file));
          const blob = await resp.blob();
          const filename = `roi_${info.label}.nii.gz`;
          const file = new File([blob], filename, { type: "application/gzip" });
          onRoiFile(file, overlayId, { name: `ROI · ${info.label}`, colormap });
        } catch (_e) {
          // Non-fatal: the overlay is already loaded in the viewer either way.
        }
      }

      toast.success("ROI created", {
        description: `${info.label} — ${info.voxels.toLocaleString()} voxels`,
      });
    } catch (e) {
      toast.error("ROI creation failed", { description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const coordInput = (val, setVal, testId) => (
    <input
      type="number"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
      data-testid={testId}
    />
  );

  return (
    <div className="space-y-3" data-testid="add-roi-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
        <Target size={11} /> spherical ROI (MNI mm)
      </div>

      {/* ── Coordinates ── */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">Center X / Y / Z (mm)</div>
        <div className="grid grid-cols-3 gap-1.5">
          {coordInput(x, setX, "roi-x")}
          {coordInput(y, setY, "roi-y")}
          {coordInput(z, setZ, "roi-z")}
        </div>
        <button
          onClick={useCrosshair}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
          data-testid="roi-use-crosshair"
        >
          <Crosshair size={11} />Use crosshair
        </button>
      </div>

      {/* ── Radius ── */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">Radius (mm)</div>
        <input
          type="number"
          min="0"
          step="0.5"
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
          className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
          data-testid="roi-radius"
        />
      </div>

      {/* ── Label ── */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">Label</div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
          data-testid="roi-label"
        />
      </div>

      {/* ── Colormap ── */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">Color</div>
        <select
          value={colormap}
          onChange={(e) => setColormap(e.target.value)}
          className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
          data-testid="roi-colormap"
        >
          {ROI_COLORMAPS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <div
          className="h-2 w-full border border-border"
          style={{ background: colormapGradient(colormap) }}
        />
      </div>

      <button
        onClick={createROI}
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50"
        data-testid="roi-create-button"
      >
        <Target size={12} />
        {busy ? "Creating…" : "Create ROI"}
      </button>

      <div className="font-mono text-[9px] text-subtle leading-relaxed">
        Sphere is built on the MNI152 grid — it aligns in the viewer only when the
        displayed scan is MNI-registered.
      </div>

      {/* ── Result / download ── */}
      {lastRoi && (
        <a
          href={roiResultUrl(lastRoi.file)}
          download
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground no-underline"
          data-testid="roi-download-nifti"
        >
          <Download size={11} />Download NIfTI ({lastRoi.voxels.toLocaleString()} vox)
        </a>
      )}
    </div>
  );
};

export default AddROIPanel;
