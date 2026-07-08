import React, { useState } from "react";
import { Sigma, Download, Activity } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { findClusters, clustersToCSV, downloadText } from "@/lib/volumeAnalysis";
import { toast } from "sonner";

export const ClusterPanel = ({ viewerRef, activationLayers, atlasOptions = [], atlasLabelsRef, onSelectAtlas }) => {
  const [layerId, setLayerId] = useState("");
  const [labelAtlasId, setLabelAtlasId] = useState(atlasOptions[0]?.id || "");
  const [threshold, setThreshold] = useState(2.3);
  const [minSize, setMinSize] = useState(10);
  const [sign, setSign] = useState("pos");
  const [colorbarOn, setColorbarOn] = useState(true);
  const [clusters, setClusters] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggleColorbar = (next) => {
    setColorbarOn(next);
    if (layerId) viewerRef.current?.setOverlayColorbarVisible(layerId, next);
  };

  // Rescale niivue-normalized img values back to true physical units
  // using vol.cal_min / vol.cal_max.
  const rescaleValue = (vol, normalizedVal) => {
    const cmn = vol?.cal_min;
    const cmx = vol?.cal_max;
    if (typeof cmn !== "number" || typeof cmx !== "number" || cmx === cmn) return normalizedVal;
    // niivue often loads as 0..255 uint8; map back to physical range
    return cmn + (normalizedVal / 255) * (cmx - cmn);
  };

  // Look up region label at a peak voxel using the chosen atlas
  const peakLabelLookup = (peakVox) => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return null;
    const atlas = nv.volumes.find((v) => v?.name === labelAtlasId);
    if (!atlas?.img || !atlas?.dimsRAS) return null;
    const [, nx, ny] = atlas.dimsRAS;
    const [i, j, k] = peakVox.map((n) => Math.round(n));
    const idx = i + nx * (j + ny * k);
    const val = Math.round(atlas.img[idx] || 0);
    return atlasLabelsRef?.current?.[labelAtlasId]?.[val] || null;
  };

  const runAnalysis = () => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return;
    const id = layerId || activationLayers[0]?.id;
    if (!id) return toast.error("No activation map selected");
    const vol = nv.volumes.find((v) => v?.name === id);
    if (!vol) return toast.error("Layer not loaded");
    setBusy(true);
    setTimeout(() => {
      // Convert physical-unit threshold to whatever scale vol.img uses.
      // niivue typically rescales float NIfTI into 0..255 for textures.
      // Detect normalization: if max(img) is far above cal_max, treat as 0..255.
      let workingThreshold = threshold;
      let scaleBack = (v) => v;
      const cmn = vol.cal_min, cmx = vol.cal_max;
      if (typeof cmn === "number" && typeof cmx === "number" && cmx > cmn) {
        const probe = vol.img[0] !== undefined ? Math.abs(vol.img[Math.floor(vol.img.length / 2)]) : 0;
        // Heuristic: if cal_max < 100 but img typically goes to ~255, it's normalized
        if (cmx < 100 && vol.img.length > 0) {
          // Compute a quick max
          let mx = 0;
          const step = Math.max(1, Math.floor(vol.img.length / 5000));
          for (let i = 0; i < vol.img.length; i += step) {
            const av = Math.abs(vol.img[i]);
            if (av > mx) mx = av;
          }
          if (mx > cmx * 5) {
            // assume linear normalization to [0, mx], map physical->normalized
            workingThreshold = (threshold - cmn) / (cmx - cmn) * mx;
            scaleBack = (nv2) => cmn + (nv2 / mx) * (cmx - cmn);
          }
        }
      }
      const { clusters: cs, stats } = findClusters(vol, workingThreshold, sign, minSize);
      // Rescale peak values back to physical units
      const cs2 = cs.map((c) => ({ ...c, peakValue: scaleBack(c.peakValue) }));
      setClusters(cs2);
      setBusy(false);
      if (cs2.length === 0) {
        toast.error("No clusters above threshold", {
          description: `img range ${stats.minVal?.toFixed(1)}..${stats.maxVal?.toFixed(1)}, ${stats.aboveThreshold} above`,
        });
      } else {
        toast.success(`${cs2.length} clusters found`);
      }
    }, 50);
  };

  const exportCSV = () => {
    if (!clusters.length) return;
    const csv = clustersToCSV(clusters, labelAtlasId || null, peakLabelLookup);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`clusters_${stamp}.csv`, csv);
    toast.success("Clusters CSV downloaded");
  };

  // For displayed table: lookup label live so user sees them inline
  const labelForCluster = (c) => peakLabelLookup(c.peakVox);

  return (
    <div className="space-y-3 mt-3 pt-3 border-t border-[#27272A]" data-testid="cluster-panel">
      <div className="flex items-center gap-2">
        <Sigma size={12} className="text-zinc-400" />
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-300">cluster analysis</span>
      </div>

      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 mb-1">map</div>
        <select value={layerId} onChange={(e) => setLayerId(e.target.value)}
          className="w-full bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-zinc-500"
          data-testid="cluster-layer-select">
          <option value="">— select activation map —</option>
          {activationLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
        </select>
      </div>

      <div>
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 mb-1">label atlas (peak)</div>
        <select value={labelAtlasId} onChange={(e) => {
          setLabelAtlasId(e.target.value);
          onSelectAtlas?.(e.target.value);
        }}
          className="w-full bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-zinc-500"
          data-testid="cluster-atlas-select">
          <option value="">— none —</option>
          {atlasOptions.map((a) => (<option key={a.id} value={a.id}>{a.short || a.name}</option>))}
        </select>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">threshold</span>
          <span className="font-mono text-[10px] text-zinc-300 tabular-nums">{threshold.toFixed(2)}</span>
        </div>
        <Slider value={[threshold]} min={0} max={10} step={0.05}
          onValueChange={(v) => setThreshold(v[0])} data-testid="cluster-threshold" />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">min size (voxels)</span>
          <span className="font-mono text-[10px] text-zinc-300 tabular-nums">{minSize}</span>
        </div>
        <Slider value={[minSize]} min={1} max={500} step={1}
          onValueChange={(v) => setMinSize(v[0])} data-testid="cluster-minsize" />
      </div>

      <div className="grid grid-cols-3 gap-1">
        {["pos", "neg", "abs"].map((s) => (
          <button key={s} onClick={() => setSign(s)}
            className={`py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border ${
              sign === s ? "bg-white text-black border-white" : "bg-transparent text-zinc-400 border-[#27272A] hover:border-zinc-500"
            }`}
            data-testid={`cluster-sign-${s}`}>{s}</button>
        ))}
      </div>

      <label className="flex items-center justify-between cursor-pointer">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">show colorbar</span>
        <button onClick={() => toggleColorbar(!colorbarOn)}
          className={`relative inline-flex h-4 w-8 transition-colors border ${
            colorbarOn ? "bg-white border-white" : "bg-transparent border-[#27272A]"
          }`}
          data-testid="activation-colorbar-toggle">
          <span className={`inline-block h-3 w-3 transition-transform ${
            colorbarOn ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"
          }`} />
        </button>
      </label>

      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={runAnalysis} disabled={busy}
          className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
          data-testid="cluster-run">
          <Activity size={11} />
          {busy ? "Running…" : "Run"}
        </button>
        <button onClick={exportCSV} disabled={!clusters.length}
          className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-200 border-[#27272A] hover:border-zinc-500 disabled:opacity-30"
          data-testid="cluster-export">
          <Download size={11} />
          Export CSV
        </button>
      </div>

      {clusters.length > 0 && (
        <div className="border border-[#27272A] bg-[#050505] max-h-56 overflow-y-auto thin-scroll" data-testid="cluster-table">
          <table className="w-full text-[10px] font-mono">
            <thead className="bg-[#0a0a0a] sticky top-0">
              <tr className="text-zinc-500 uppercase">
                <th className="text-left px-2 py-1">#</th>
                <th className="text-right px-2 py-1">vox</th>
                <th className="text-right px-2 py-1">peak</th>
                <th className="text-right px-2 py-1">MNI</th>
                <th className="text-left px-2 py-1">region</th>
              </tr>
            </thead>
            <tbody>
              {clusters.slice(0, 50).map((c, i) => (
                <tr key={i} className="border-t border-[#27272A] text-zinc-300 hover:bg-[#0a0a0a]"
                  data-testid={`cluster-row-${i}`}>
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{c.size}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{c.peakValue.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {c.peakMM.map((x) => x.toFixed(0)).join(",")}
                  </td>
                  <td className="px-2 py-1 text-zinc-400 truncate max-w-[150px]">
                    {labelForCluster(c) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ClusterPanel;

