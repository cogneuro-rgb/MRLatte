import React, { useState } from "react";
import { GitMerge, Download } from "lucide-react";
import { computeAtlasOverlap, overlapToCSV, downloadText } from "@/lib/volumeAnalysis";
import { toast } from "sonner";

/**
 * Lesion → Atlas overlap report (MRIcroGL-style).
 * For a selected lesion layer + atlas layer, compute % overlap per region.
 */
export const OverlapPanel = ({ viewerRef, lesionLayers, atlasOptions, atlasLabelsRef }) => {
  const [lesionId, setLesionId] = useState("");
  const [atlasId, setAtlasId] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  const runOverlap = () => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return;
    const lid = lesionId || lesionLayers[0]?.id;
    const aid = atlasId || atlasOptions[0]?.id;
    if (!lid || !aid) return toast.error("Select lesion + atlas");
    const lesionVol = nv.volumes.find((v) => v?.name === lid);
    const atlasVol = nv.volumes.find((v) => v?.name === aid);
    if (!lesionVol || !atlasVol)
      return toast.error("Both layers must be loaded (toggled visible)");
    setBusy(true);
    setTimeout(() => {
      const labels = atlasLabelsRef?.current?.[aid] || null;
      const { rows: result, stats } = computeAtlasOverlap(lesionVol, atlasVol, labels);
      setRows(result);
      setBusy(false);
      if (!result.length) {
        toast(`No overlap with this atlas`, {
          description: `lesion voxels=${stats.totalLesion}, sameGrid=${stats.sameGrid}`,
        });
      } else {
        toast.success(`${result.length} regions overlapped`, {
          description: stats.sameGrid ? "direct" : "resampled via MNI mm",
        });
      }
    }, 50);
  };

  const exportCSV = () => {
    if (!rows.length) return;
    const aid = atlasId || atlasOptions[0]?.id || "atlas";
    const csv = overlapToCSV(rows, aid);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`overlap_${stamp}.csv`, csv);
    toast.success("Overlap CSV downloaded");
  };

  if (lesionLayers.length === 0) {
    return (
      <div className="font-mono text-[10px] text-zinc-600 leading-relaxed" data-testid="overlap-empty">
        Load a lesion mask first to compute atlas overlap.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="overlap-panel">
      <div className="flex items-center gap-2">
        <GitMerge size={12} className="text-zinc-400" />
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-300">lesion ∩ atlas overlap</span>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <select value={lesionId} onChange={(e) => setLesionId(e.target.value)}
          className="bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[10px] px-2 py-1"
          data-testid="overlap-lesion-select">
          <option value="">— lesion —</option>
          {lesionLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
        </select>
        <select value={atlasId} onChange={(e) => setAtlasId(e.target.value)}
          className="bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[10px] px-2 py-1"
          data-testid="overlap-atlas-select">
          <option value="">— atlas —</option>
          {atlasOptions.map((a) => (<option key={a.id} value={a.id}>{a.short || a.name}</option>))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={runOverlap} disabled={busy}
          className="py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
          data-testid="overlap-run">
          {busy ? "Computing…" : "Compute"}
        </button>
        <button onClick={exportCSV} disabled={!rows.length}
          className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-200 border-[#27272A] hover:border-zinc-500 disabled:opacity-30"
          data-testid="overlap-export">
          <Download size={11} /> CSV
        </button>
      </div>

      {rows.length > 0 && (
        <div className="border border-[#27272A] bg-[#050505] max-h-44 overflow-y-auto thin-scroll" data-testid="overlap-table">
          <table className="w-full text-[10px] font-mono">
            <thead className="bg-[#0a0a0a] sticky top-0">
              <tr className="text-zinc-500 uppercase">
                <th className="text-left px-2 py-1">region</th>
                <th className="text-right px-2 py-1">vox</th>
                <th className="text-right px-2 py-1">% les</th>
                <th className="text-right px-2 py-1">% reg</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 80).map((r, i) => (
                <tr key={i} className="border-t border-[#27272A] text-zinc-300" data-testid={`overlap-row-${i}`}>
                  <td className="px-2 py-1 truncate max-w-[140px]" title={r.regionName}>{r.regionName}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.voxelCount}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.percentOfLesion.toFixed(1)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.percentOfRegion.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default OverlapPanel;
