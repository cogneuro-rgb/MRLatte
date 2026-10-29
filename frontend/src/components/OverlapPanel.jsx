import React, { useRef, useState } from "react";
import { Download, FlaskConical } from "lucide-react";
import { overlapToCSV, downloadText } from "@/lib/volumeAnalysis";
import { loadAtlasForReading } from "@/lib/atlasLoad";
import { resolveLesionAtlasMetrics, engineProvenanceLabel } from "@/lib/lesionReport";
import { currentDrawingAsFile } from "@/lib/lesions";
import { isDevBuild, useLesionEngineDevOverride } from "@/lib/lesionMetrics";

import { toast } from "sonner";

/**
 * Lesion → Atlas overlap report (MRIcroGL-style).
 * For a selected lesion layer + atlas layer, compute % overlap per region.
 * Engine defaults to lqtpy (backend/lesion_metrics.py) via
 * resolveLesionAtlasMetrics, falling back visibly to the JS engine
 * (computeAtlasOverlap) when lqtpy is unavailable or a dev toggle forces it.
 */
// `bare`: no heading of its own, for a caller that folds it under one.
export const OverlapPanel = ({ viewerRef, lesionLayers, atlasOptions, ensureAtlasRegions, ensureAtlasLoaded, userFileCache, bare = false }) => {
  const [lesionId, setLesionId] = useState("");
  const [atlasId, setAtlasId] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [provenance, setProvenance] = useState(null);
  const [note, setNote] = useState(null); // excluded-atlas / fallback note shown above the table
  const [devEngine, setDevEngine] = useLesionEngineDevOverride();
  // §6 stale-response guard: a lesion/atlas change (or a second Compute click)
  // while a request is in flight must not let the OLD response overwrite the
  // state a newer request already set.
  const requestIdRef = useRef(0);

  const resolveLesionFile = async (lid) => {
    const cached = userFileCache?.current?.[lid]?.file;
    if (cached) return cached;
    return currentDrawingAsFile(viewerRef, `${lid}.nii.gz`);
  };

  // The atlas list is every INSTALLED atlas, not only the ones currently
  // toggled visible in the Atlases section — the dropdown used to be filtered
  // to `atlasState[a.id]?.visible`, so it read as empty ("no atlases") right
  // after loading a lesion even with the core atlas module installed. Any
  // atlas the user picks is loaded on demand below, exactly the way
  // LesionReportPanel and OneClickSummaryPanel already do it.
  const runOverlap = async () => {
    const nv = viewerRef.current?.getNiivue();
    if (!nv) return;
    const lid = lesionId || lesionLayers[0]?.id;
    const aid = atlasId || atlasOptions[0]?.id;
    if (!lid || !aid) return toast.error("Select lesion + atlas");
    const lesionVol = nv.volumes.find((v) => v?.name === lid);
    if (!lesionVol) return toast.error("Lesion layer is not loaded");
    const myRequestId = ++requestIdRef.current;
    setBusy(true);
    setNote(null);
    try {
      // Load the atlas silently if it isn't in the viewer yet (it does not
      // need to be visible — this reads its voxels for the JS engine/fallback,
      // and gives us its display name for the lqtpy path either way).
      const atlas = atlasOptions.find((a) => a.id === aid);
      const loaded = await loadAtlasForReading(atlas, {
        viewerRef, ensureAtlasLoaded, ensureRegions: ensureAtlasRegions,
      });
      if (!loaded) {
        if (requestIdRef.current === myRequestId) setBusy(false);
        return toast.error("Could not load that atlas");
      }
      const lesionFile = await resolveLesionFile(lid);
      const { atlasBreakdowns, excludedAtlases, provenance: prov } = await resolveLesionAtlasMetrics({
        lesionFile,
        lesionVol,
        atlases: [{ id: aid, name: atlas.short || atlas.name, vol: loaded.vol, labels: loaded.labels }],
      });
      if (requestIdRef.current !== myRequestId) return; // a newer request already landed

      if (excludedAtlases.length) {
        // Task requirement: an atlas the lqtpy engine can't bridge (continuous
        // / tracts4d kinds) must say so, not silently produce zero rows.
        setRows([]);
        setProvenance(prov);
        setNote(`"${atlas.short || atlas.name}" isn't supported by the lqtpy engine (${excludedAtlases[0].reason}). Use the dev JS engine toggle or pick a different atlas.`);
        toast.warning("Atlas not supported by lqtpy", { description: excludedAtlases[0].reason });
        return;
      }

      const result = atlasBreakdowns[0]?.rows || [];
      setRows(result);
      setProvenance(prov);
      if (prov.fallback) {
        toast.warning("Using JS engine (fallback)", { description: prov.fallbackReason || "lqtpy unavailable" });
      }
      if (!result.length) {
        toast(`No overlap with this atlas`, { description: `lesion voxels=${prov.engine === "lqtpy" ? "n/a (atlas grid)" : "see volume"}` });
      } else {
        toast.success(`${result.length} regions overlapped`, { description: engineProvenanceLabel(prov) });
      }
    } catch (e) {
      if (requestIdRef.current !== myRequestId) return;
      toast.error("Overlap failed", { description: e?.message });
    } finally {
      if (requestIdRef.current === myRequestId) setBusy(false);
    }
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
      <div className="text-[12px] text-subtle leading-relaxed" data-testid="overlap-empty">
        Load a lesion mask first to compute atlas overlap.
      </div>
    );
  }

  const voxelsLabel = rows.length && provenance?.engine === "lqtpy" ? "vox (atlas)" : "vox";

  return (
    <div className="space-y-2" data-testid="overlap-panel">
      {(!bare || isDevBuild()) && (
      <div className="flex items-center gap-2">
        {!bare && <span className="cap flex-1 text-subtle">Lesion ∩ atlas overlap</span>}
        {isDevBuild() && (
          <button
            onClick={() => setDevEngine(devEngine === "js" ? null : "js")}
            title="Dev only: force the JS engine instead of lqtpy, for side-by-side comparison"
            aria-pressed={devEngine === "js"}
            className={`btn-mini ${devEngine === "js" ? "!border-warn !bg-warn/15 !text-warn" : ""}`}
            data-testid="overlap-dev-engine-toggle"
          >
            <FlaskConical size={11} /> JS
          </button>
        )}
      </div>
      )}

      {/* Item 105: with exactly one lesion in scope (the per-lesion mount in
          LesionMasksSection passes just its own layer) the lesion picker is
          noise — the atlas row then stands alone. */}
      {lesionLayers.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="w-12 flex-shrink-0 text-[13px] text-muted-foreground">Lesion</span>
          <select value={lesionId} onChange={(e) => setLesionId(e.target.value)}
            className="field min-w-0 flex-1"
            data-testid="overlap-lesion-select">
            <option value="">— lesion —</option>
            {lesionLayers.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
          </select>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="w-12 flex-shrink-0 text-[13px] text-muted-foreground">Atlas</span>
        <select value={atlasId} onChange={(e) => setAtlasId(e.target.value)}
          className="field min-w-0 flex-1"
          data-testid="overlap-atlas-select">
          <option value="">— atlas —</option>
          {atlasOptions.map((a) => (<option key={a.id} value={a.id}>{a.short || a.name}</option>))}
        </select>
      </div>
      <button onClick={runOverlap} disabled={busy}
        className="btn w-full"
        data-testid="overlap-run">
        {busy ? "Computing…" : "Compute overlap"}
      </button>

      {note && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn" data-testid="overlap-note">
          {note}
        </div>
      )}

      {(rows.length > 0 || provenance) && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="flex-1">
            {rows.length > 0 ? `${rows.length} region${rows.length === 1 ? "" : "s"} overlapped` : ""}
          </span>
          {provenance && (
            <span className="truncate font-mono text-[11px] text-subtle" title={engineProvenanceLabel(provenance)} data-testid="overlap-provenance">
              {engineProvenanceLabel(provenance)}
            </span>
          )}
          <button onClick={exportCSV} disabled={!rows.length}
            className="btn-mini"
            title="Download the overlap table as CSV"
            data-testid="overlap-export">
            <Download size={11} /> CSV
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="max-h-44 overflow-y-auto thin-scroll" data-testid="overlap-table">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-card">
              <tr className="text-subtle">
                <th className="cap py-1 pr-2 text-left">Region</th>
                <th className="cap px-1.5 py-1 text-right">{voxelsLabel}</th>
                <th className="cap px-1.5 py-1 text-right">% les</th>
                <th className="cap py-1 pl-1.5 text-right">% reg</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 80).map((r, i) => (
                <tr key={i} className="border-t border-border text-foreground" data-testid={`overlap-row-${i}`}>
                  <td className="max-w-[140px] truncate py-[5px] pr-2" title={r.regionName}>{r.regionName}</td>
                  <td className="px-1.5 py-[5px] text-right font-mono text-[11.5px] text-muted-foreground">{r.voxelCount}</td>
                  <td className="px-1.5 py-[5px] text-right font-mono text-[11.5px]">{r.percentOfLesion.toFixed(1)}</td>
                  <td className="py-[5px] pl-1.5 text-right font-mono text-[11.5px]">{r.percentOfRegion.toFixed(1)}</td>
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
