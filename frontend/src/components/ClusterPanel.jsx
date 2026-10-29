import React, { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Sigma, Download, Activity, Crosshair } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { EditableNumber } from "@/components/ui/editable-number";
import { findClusters, clustersToCSV, downloadText } from "@/lib/volumeAnalysis";
import { toast } from "sonner";

// `bare`: no heading or rule of its own, for a caller that folds it under one.
export const ClusterPanel = ({ viewerRef, activationLayers, atlasOptions = [], atlasRegions, ensureAtlasLoaded, onSelectAtlas, bare = false }) => {
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
    const region = (atlasRegions?.[labelAtlasId] || []).find((r) => r.value === val);
    return region?.name || null;
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

  // One "label · control" row, as on the other panels.
  const rowLabel = "w-[112px] flex-shrink-0 text-[13px] text-muted-foreground";

  return (
    <div className={`space-y-2.5 ${bare ? "" : "mt-3 pt-3 border-t border-border"}`} data-testid="cluster-panel">
      {!bare && (
        <div className="flex items-center gap-2">
          <Sigma size={13} className="text-subtle" />
          <span className="cap text-subtle">Cluster analysis</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className={rowLabel}>Map</span>
        <select value={layerId} onChange={(e) => setLayerId(e.target.value)}
          className="field min-w-0 flex-1 font-mono"
          data-testid="cluster-layer-select">
          <option value="">— select activation map —</option>
          {activationLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <span className={rowLabel}>Label atlas (peak)</span>
        <select value={labelAtlasId} onChange={(e) => {
          setLabelAtlasId(e.target.value);
          onSelectAtlas?.(e.target.value);
        }}
          className="field min-w-0 flex-1"
          data-testid="cluster-atlas-select">
          <option value="">— none —</option>
          {atlasOptions.map((a) => (<option key={a.id} value={a.id}>{a.short || a.name}</option>))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <span className={rowLabel}>Threshold</span>
        <Slider value={[threshold]} min={0} max={10} step={0.05}
          onValueChange={(v) => setThreshold(v[0])} className="flex-1" aria-label="Threshold" data-testid="cluster-threshold" />
        <EditableNumber value={threshold} min={0} max={10} onCommit={setThreshold} label="Threshold"
          className="w-10 text-right font-mono text-[11.5px] text-foreground">{threshold.toFixed(2)}</EditableNumber>
      </div>

      <div className="flex items-center gap-2">
        <span className={rowLabel}>Min size (voxels)</span>
        <Slider value={[minSize]} min={1} max={500} step={1}
          onValueChange={(v) => setMinSize(v[0])} className="flex-1" aria-label="Minimum cluster size" data-testid="cluster-minsize" />
        <EditableNumber value={minSize} min={1} max={500} integer onCommit={setMinSize} label="Minimum cluster size"
          className="w-10 text-right font-mono text-[11.5px] text-foreground">{minSize}</EditableNumber>
      </div>

      <div className="flex items-center gap-2">
        <span className={rowLabel}>Sign</span>
        <div className="seg" role="group" aria-label="Sign">
          {[["pos", "Positive"], ["neg", "Negative"], ["abs", "Absolute (both signs)"]].map(([s, title]) => (
            <button key={s} onClick={() => setSign(s)} aria-pressed={sign === s} title={title}
              data-testid={`cluster-sign-${s}`}>{s}</button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <span className="flex-1">Show the colour bar</span>
        <Switch checked={!!colorbarOn} onCheckedChange={toggleColorbar} label="Show the colour bar"
          testId="activation-colorbar-toggle" />
      </div>

      <div className="grid gap-1.5">
        <button onClick={runAnalysis} disabled={busy}
          className="btn-primary flex gap-1.5"
          data-testid="cluster-run">
          <Activity size={12} />
          {busy ? "Running…" : "Run cluster analysis"}
        </button>
        <button onClick={exportCSV} disabled={!clusters.length}
          className="btn flex gap-1.5"
          data-testid="cluster-export">
          <Download size={12} />
          Export CSV
        </button>
      </div>

      {clusters.length > 0 && (
        <div className="max-h-56 overflow-y-auto thin-scroll" data-testid="cluster-table">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-card">
              <tr className="text-subtle">
                <th className="cap py-1 pr-1.5 text-left">#</th>
                <th className="cap px-1.5 py-1 text-right">Vox</th>
                <th className="cap px-1.5 py-1 text-right">Peak</th>
                <th className="cap px-1.5 py-1 text-right">MNI</th>
                <th className="cap px-1.5 py-1 text-left">Region</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {clusters.slice(0, 50).map((c, i) => (
                <tr key={i} className="border-t border-border text-foreground hover:bg-panel-hover"
                  data-testid={`cluster-row-${i}`}>
                  <td className="py-[5px] pr-1.5 font-mono text-[11.5px] text-subtle">{i + 1}</td>
                  <td className="px-1.5 py-[5px] text-right font-mono text-[11.5px]">{c.size}</td>
                  <td className="px-1.5 py-[5px] text-right font-mono text-[11.5px]">{c.peakValue.toFixed(2)}</td>
                  <td className="px-1.5 py-[5px] text-right font-mono text-[11.5px] text-muted-foreground">
                    {c.peakMM.map((x) => x.toFixed(0)).join(",")}
                  </td>
                  <td className="max-w-[150px] truncate px-1.5 py-[5px] text-muted-foreground">
                    {labelForCluster(c) || "—"}
                  </td>
                  <td className="py-[3px] text-center">
                    <button
                      onClick={() => viewerRef.current?.setCrosshairMM?.(c.peakMM[0], c.peakMM[1], c.peakMM[2])}
                      title="Go to peak coordinate"
                      aria-label="Go to peak coordinate"
                      className="icon-btn h-[22px] w-[22px]"
                      data-testid={`cluster-goto-${i}`}
                    >
                      <Crosshair size={12} />
                    </button>
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
