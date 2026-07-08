import React, { useState } from "react";
import { Ruler, Move3d, AlignVerticalSpaceAround, Box } from "lucide-react";
import { distanceMM, lesionMaxDiameter, lesionVolume, midlineShift } from "@/lib/measure";
import { toast } from "sonner";

/**
 * MeasurePanel — ruler (2-point distance), lesion max diameter (PCA),
 * lesion volume estimation, and landmark-assisted midline shift.
 * Consumes the live `crosshairMM` already tracked by Dashboard.
 */
export const MeasurePanel = ({ viewerRef, crosshairMM, lesionLayers = [] }) => {
  const [pA, setPA] = useState(null);
  const [pB, setPB] = useState(null);
  const [landmark, setLandmark] = useState(null);
  const [diam, setDiam] = useState(null);
  const [vol, setVol] = useState(null);
  const [selLesion, setSelLesion] = useState("");

  const fmt = (p) => (p ? `${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}` : "—");
  const dist = distanceMM(pA, pB);

  const computeDiameter = () => {
    const id = selLesion || lesionLayers[0]?.id;
    if (!id) return toast.error("No lesion layer");
    const vol = viewerRef.current?.getVolume?.(id);
    if (!vol?.img) return toast.error("Lesion volume unavailable");
    const r = lesionMaxDiameter(vol);
    if (!r) return toast.error("Could not measure");
    setDiam(r);
  };

  const ms = midlineShift(landmark);

  const computeVolume = () => {
    const id = selLesion || lesionLayers[0]?.id;
    if (!id) return toast.error("No lesion layer");
    const v = viewerRef.current?.getVolume?.(id);
    if (!v?.img) return toast.error("Lesion volume unavailable");
    const r = lesionVolume(v);
    if (!r) return toast.error("Could not estimate volume");
    setVol(r);
  };

  const computeDrawingVolume = () => {
    const v = viewerRef.current?.getDrawingAsVolume?.();
    if (!v?.img) return toast.error("Nothing drawn yet");
    const r = lesionVolume(v);
    if (!r) return toast.error("Could not estimate volume");
    setVol(r);
  };

  const btn =
    "flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500";

  return (
    <div className="space-y-4" data-testid="measure-panel">
      {/* Ruler */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
          <Ruler size={11} /> ruler · 2-point distance
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button className={btn} onClick={() => setPA(crosshairMM ? [...crosshairMM] : null)} data-testid="ruler-set-a">
            Set A
          </button>
          <button className={btn} onClick={() => setPB(crosshairMM ? [...crosshairMM] : null)} data-testid="ruler-set-b">
            Set B
          </button>
        </div>
        <div className="font-mono text-[10px] text-zinc-400 space-y-0.5">
          <div>A: <span className="text-zinc-200">{fmt(pA)}</span></div>
          <div>B: <span className="text-zinc-200">{fmt(pB)}</span></div>
          <div>
            distance:{" "}
            <span className="text-white">{dist != null ? `${dist.toFixed(1)} mm` : "—"}</span>
          </div>
        </div>
      </div>

      <div className="h-px bg-[#27272A]" />

      {/* Lesion max diameter */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
          <Move3d size={11} /> lesion max diameter (approx · PCA)
        </div>
        {lesionLayers.length > 1 && (
          <select
            value={selLesion}
            onChange={(e) => setSelLesion(e.target.value)}
            className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
            data-testid="diam-lesion-select"
          >
            <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
            {lesionLayers.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
        <button className={`w-full ${btn}`} onClick={computeDiameter} data-testid="diam-compute"
          disabled={lesionLayers.length === 0}>
          Measure
        </button>
        {diam && (
          <div className="font-mono text-[10px] text-zinc-400">
            diameter: <span className="text-white">{diam.diameterMM.toFixed(1)} mm</span>
            <span className="text-zinc-600"> · {diam.voxelCount} vox</span>
          </div>
        )}
      </div>

      <div className="h-px bg-[#27272A]" />

      {/* Midline shift */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
          <AlignVerticalSpaceAround size={11} /> midline shift (landmark-assisted)
        </div>
        <button className={`w-full ${btn}`} onClick={() => setLandmark(crosshairMM ? [...crosshairMM] : null)}
          data-testid="midline-set">
          Set Landmark @ Crosshair
        </button>
        <div className="font-mono text-[10px] text-zinc-400">
          landmark: <span className="text-zinc-200">{fmt(landmark)}</span>
          {ms && (
            <div>
              shift: <span className="text-white">{ms.shiftMM.toFixed(1)} mm</span>{" "}
              <span className="text-zinc-600">({ms.side})</span>
            </div>
          )}
        </div>
        <div className="font-mono text-[9px] text-zinc-600 leading-relaxed">
          place crosshair on a structure expected at the midline (MNI x≈0).
        </div>
      </div>

      <div className="h-px bg-[#27272A]" />

      {/* Lesion volume estimation */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
          <Box size={11} /> lesion volume (voxel count × spacing)
        </div>
        {lesionLayers.length > 1 && (
          <select
            value={selLesion}
            onChange={(e) => setSelLesion(e.target.value)}
            className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
            data-testid="vol-lesion-select"
          >
            <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
            {lesionLayers.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
        <div className="grid grid-cols-2 gap-1">
          <button className={btn} onClick={computeVolume} data-testid="vol-compute"
            disabled={lesionLayers.length === 0}>
            Lesion Layer
          </button>
          <button className={btn} onClick={computeDrawingVolume} data-testid="vol-compute-drawing">
            Current Drawing
          </button>
        </div>
        {vol && (
          <div className="font-mono text-[10px] text-zinc-400 space-y-0.5">
            <div>
              volume: <span className="text-white">{vol.volumeCM3.toFixed(2)} cm³</span>
              <span className="text-zinc-600"> · {vol.volumeMM3.toFixed(0)} mm³</span>
            </div>
            <div className="text-zinc-600">
              {vol.voxelCount.toLocaleString()} vox · {vol.spacingMM.map((s) => s.toFixed(2)).join(" × ")} mm
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MeasurePanel;
