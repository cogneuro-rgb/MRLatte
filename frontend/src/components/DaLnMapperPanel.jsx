import React, { useState, useEffect } from "react";
import { Network, Download, FileCode, FileSpreadsheet, ExternalLink, Eye, EyeOff, Trash2 } from "lucide-react";
import FileUploader from "@/components/FileUploader";
import {
  lnmAvailable,
  lnmCompute,
  lnmResultUrl,
  lnmToCSV,
  lnmToHTML,
  LNM_NETWORK_LABELS,
} from "@/lib/lnm";
import { downloadText } from "@/lib/volumeAnalysis";
import { currentDrawingAsFile } from "@/lib/lesions";
import { toast } from "sonner";

const FILE_LABELS = {
  spec_net: "specificity net",
  spec_zscore: "specificity z",
  thresh_cont: "thresholded map",
  da: "degree-adjusted map",
  raw: "raw map",
  pos_bin: "positive mask",
  neg_bin: "negative mask",
};
const FILE_ORDER = ["spec_net", "spec_zscore", "thresh_cont", "da", "raw", "pos_bin", "neg_bin"];

// Colormap choices for the sign-split overlay (positive/negative pickers).
// All confirmed-valid niivue built-in colormap names (see LayerControl.jsx).
const LNM_COLOR_OPTIONS = [
  "warm", "red", "actc", "plasma", "viridis", "inferno", "magma",
  "turbo", "jet", "winter", "cool", "blue", "green", "gray",
];

// cal_min/cal_max sentinel for "negative only" mode: pins the positive
// channel's alpha-mask to a range no real stat value can ever fall in, so it
// renders nothing while colormapNegative keeps rendering the negative side.
const SIGN_HIDDEN_RANGE = [1e6, 1e6 + 1];

/**
 * DaLnMapperPanel — Degree-Adjusted Lesion Network Mapping (DA-LNM v2.1).
 * Upload / pick / draw a lesion → backend Connectome → seed-to-voxel stat map
 * (t or Fisher-z), optional degree adjustment + randomized-lesion specificity
 * filtering, atlas-labelled networks (Harvard-Oxford + Yeo-7), exportable as
 * HTML & CSV, plus a full server-rendered report.
 */
export const DaLnMapperPanel = ({ viewerRef, lesionLayers = [], userFileCache }) => {
  const [lesionFile, setLesionFile] = useState(null);
  const [selLesionId, setSelLesionId] = useState("");
  const [metric, setMetric] = useState("t");
  const [tThreshold, setTThreshold] = useState(11.0);
  const [zThreshold, setZThreshold] = useState(0.2);
  const [degreeAdjust, setDegreeAdjust] = useState(true);
  const [runSpecificity, setRunSpecificity] = useState(true);
  const [nperm, setNperm] = useState(100);
  const [fdr, setFdr] = useState(false);
  const [signMode, setSignMode] = useState("both"); // "both" | "pos" | "neg" — display-only overlay filter
  const [posColor, setPosColor] = useState("warm");
  const [negColor, setNegColor] = useState("winter");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [available, setAvailable] = useState(null);
  const [overlayId] = useState(() => `lnm-net-${Date.now()}`);
  const [overlayLoaded, setOverlayLoaded] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayBaseOpacity, setOverlayBaseOpacity] = useState(0.8); // opacity used at load (for show/hide restore)

  useEffect(() => {
    lnmAvailable().then((info) => setAvailable(info?.ok ? true : (info || false)));
  }, []);

  const getFile = () =>
    lesionFile || (selLesionId ? userFileCache?.current?.[selLesionId]?.file : null);

  const useDrawing = async () => {
    const f = await currentDrawingAsFile(viewerRef, "drawing_lesion.nii.gz");
    if (!f) {
      toast.error("Nothing drawn yet — draw a lesion first.");
      return;
    }
    setLesionFile(f);
    setSelLesionId("");
  };

  // Builds the addOverlayFromUrl options for a signed diverging map given the
  // current sign filter: "pos" omits colormapNegative entirely (negative
  // voxels never render); "neg" pins the positive channel to a range no real
  // value can hit (SIGN_HIDDEN_RANGE) while colormapNegative stays active;
  // "both" is the original unfiltered diverging behavior.
  const signedOverlayOpts = (lo, hi) => {
    if (signMode === "pos") {
      return { colormap: posColor, cal_min: lo, cal_max: hi };
    }
    if (signMode === "neg") {
      return {
        colormap: negColor,
        cal_min: SIGN_HIDDEN_RANGE[0],
        cal_max: SIGN_HIDDEN_RANGE[1],
        colormapNegative: negColor,
        cal_minNeg: -hi,
        cal_maxNeg: -lo,
      };
    }
    return {
      colormap: posColor,
      colormapNegative: negColor,
      cal_min: lo,
      cal_max: hi,
      cal_minNeg: -hi,
      cal_maxNeg: -lo,
    };
  };

  const loadOverlay = async (info) => {
    const files = info.files || {};
    const disp = info.display || {};
    if (overlayLoaded) {
      try { viewerRef.current?.removeVolume?.(overlayId); } catch (_e) { /* best-effort */ }
    }
    let vol;
    let baseOp = 0.8;
    if (files.spec_net) {
      // Signed, specificity-filtered network: positive (coupled) and negative
      // (anticorrelated) tails rendered with a diverging colormap, both sides
      // windowed off the worker's robust display range.
      const lo = disp.cal_min ?? 1;
      const hi = disp.cal_max ?? lo + 1;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayId,
        url: lnmResultUrl(files.spec_net),
        opacity: 0.8,
        ignoreZeroVoxels: true,
        ...signedOverlayOpts(lo, hi),
      });
    } else if (files.thresh_cont) {
      const lo = disp.cal_min ?? 1;
      const hi = disp.cal_max ?? lo + 1;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayId,
        url: lnmResultUrl(files.thresh_cont),
        opacity: 0.8,
        ignoreZeroVoxels: true,
        ...signedOverlayOpts(lo, hi),
      });
    } else if (files.pos_bin) {
      baseOp = 0.75;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayId,
        url: lnmResultUrl(files.pos_bin),
        colormap: posColor,
        opacity: 0.75,
        cal_min: 0.5,
        cal_max: 1,
        ignoreZeroVoxels: true,
      });
    } else {
      return;
    }
    if (vol) {
      setOverlayLoaded(true);
      setOverlayVisible(true);
      setOverlayBaseOpacity(baseOp);
    }
  };

  // Toggle the network overlay's visibility in the viewer (opacity 0 / restore);
  // keeps the result card, stats, and downloads intact.
  const toggleOverlayVisible = () => {
    const next = !overlayVisible;
    viewerRef.current?.setOverlayOpacity?.(overlayId, next ? overlayBaseOpacity : 0);
    setOverlayVisible(next);
  };

  // Remove the network overlay from the viewer AND dismiss the result card.
  const deleteResult = () => {
    if (overlayLoaded) {
      try { viewerRef.current?.removeVolume?.(overlayId); } catch (_e) { /* best-effort */ }
    }
    setOverlayLoaded(false);
    setOverlayVisible(true);
    setResult(null);
  };

  const run = async () => {
    const file = getFile();
    if (!file) {
      toast.error("Select, upload, or draw a lesion first.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const info = await lnmCompute(file, {
        name: file.name,
        metric,
        threshold: tThreshold,
        zthr: zThreshold,
        degreeAdjust,
        runSpecificity,
        nperm,
        fdr,
      });
      setResult(info);
      await loadOverlay(info);
      const spec = info.specificity;
      toast.success("Lesion network map computed", {
        description: spec?.run
          ? `${spec.n_sig_pos.toLocaleString()} / ${spec.n_sig_neg.toLocaleString()} voxels survive specificity`
          : `${info.n_pos_thr.toLocaleString()} / ${info.n_neg_thr.toLocaleString()} supra-threshold voxels`,
      });
    } catch (e) {
      toast.error("Lesion network mapping failed", { description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  // Re-render the overlay in place when the sign filter or colors change —
  // display-only, no recompute.
  useEffect(() => {
    if (result) loadOverlay(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signMode, posColor, negColor]);

  const exportHtml = () => {
    if (!result) return;
    const html = lnmToHTML(result, getFile()?.name);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`lnm_report_${ts}.html`, html, "text/html");
  };

  const exportCsv = () => {
    if (!result) return;
    const csv = lnmToCSV(result, getFile()?.name);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`lnm_report_${ts}.csv`, csv, "text/csv");
  };

  const networks = result?.networks || {};
  const networkKeys = Object.keys(LNM_NETWORK_LABELS).filter((k) => (networks[k] || []).length > 0);
  const atlasErrors = [
    networks.ho_err && `Harvard-Oxford: ${networks.ho_err}`,
    networks.yeo_err && `Yeo-7: ${networks.yeo_err}`,
  ].filter(Boolean);
  const fileKeys = result?.files ? FILE_ORDER.filter((k) => result.files[k]) : [];

  const runDisabled = busy || available !== true || (!lesionFile && !selLesionId);

  return (
    <div className="space-y-3" data-testid="lnm-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
        <Network size={11} /> degree adjusted lesion networking
      </div>

      {available !== null && available !== true && (
        <div className="font-mono text-[10px] text-zinc-500 border border-[#27272A] px-2 py-2" data-testid="lnm-unavailable">
          {available?.reason?.toLowerCase().includes("fetch")
            ? "Backend server unavailable — start the backend and reload."
            : available?.bundle_present === false
              ? "Connectome bundle not found on server (set LNM_BUNDLE)."
              : (available?.reason || "Degree Adjusted Lesion Networking unavailable.")}
        </div>
      )}

      {(available === null || available === true) && (
        <>
          <FileUploader
            label="Upload lesion mask"
            description=".nii / .nii.gz · MNI152 space"
            accept=".nii,.nii.gz"
            onFile={(f) => { setLesionFile(f); setSelLesionId(""); }}
            testId="lnm-lesion-upload"
          />
          <button
            type="button"
            onClick={useDrawing}
            className="w-full py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
            data-testid="lnm-use-drawing"
          >
            Use current drawing
          </button>
          {lesionFile && (
            <div className="font-mono text-[10px] text-zinc-400 truncate">{lesionFile.name}</div>
          )}
          {lesionLayers.length > 0 && (
            <select
              value={selLesionId}
              onChange={(e) => { setSelLesionId(e.target.value); setLesionFile(null); }}
              className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
              data-testid="lnm-lesion-select"
            >
              <option value="">— or pick loaded lesion —</option>
              {lesionLayers.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}

          {/* Metric */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">metric</span>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              className="w-28 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
              data-testid="lnm-metric"
            >
              <option value="t">one-sample t</option>
              <option value="z">Fisher-z</option>
            </select>
          </div>

          {/* Threshold */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">
              {metric === "z" ? "|z| threshold" : "|t| threshold"}
            </span>
            {metric === "z" ? (
              <input
                type="number" min={0} step={0.05}
                value={zThreshold}
                onChange={(e) => setZThreshold(Math.max(0, Number(e.target.value) || 0))}
                className="w-20 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                data-testid="lnm-threshold"
              />
            ) : (
              <input
                type="number" min={1} step={0.5}
                value={tThreshold}
                onChange={(e) => setTThreshold(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                data-testid="lnm-threshold"
              />
            )}
          </div>

          {/* Degree adjust */}
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">degree adjust</span>
            <input
              type="checkbox"
              checked={degreeAdjust}
              onChange={(e) => setDegreeAdjust(e.target.checked)}
              data-testid="lnm-degree-adjust"
            />
          </label>

          {/* Specificity */}
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">specificity test</span>
            <input
              type="checkbox"
              checked={runSpecificity}
              onChange={(e) => setRunSpecificity(e.target.checked)}
              data-testid="lnm-specificity"
            />
          </label>
          {runSpecificity && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">permutations</span>
                <input
                  type="number" min={10} max={500} step={10}
                  value={nperm}
                  onChange={(e) => setNperm(Math.max(10, Number(e.target.value) || 10))}
                  className="w-20 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                  data-testid="lnm-nperm"
                />
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">BH-FDR correct</span>
                <input
                  type="checkbox"
                  checked={fdr}
                  onChange={(e) => setFdr(e.target.checked)}
                  data-testid="lnm-fdr"
                />
              </label>
            </>
          )}

          <button
            onClick={run}
            disabled={runDisabled}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
            data-testid="lnm-run-button"
          >
            <Network size={12} />
            {busy ? "Computing…" : "Compute Network Map"}
          </button>
        </>
      )}

      {result && (
        <>
          {/* Layer controls: hide/show the network overlay, or delete this result */}
          <div className="flex items-center justify-end gap-1.5">
            {overlayLoaded && (
              <button
                onClick={toggleOverlayVisible}
                title={overlayVisible ? "Hide network overlay" : "Show network overlay"}
                className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="lnm-toggle-visible"
              >
                {overlayVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                {overlayVisible ? "Hide" : "Show"}
              </button>
            )}
            <button
              onClick={deleteResult}
              title="Remove overlay from viewer and clear this result"
              className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-red-400 hover:border-red-900"
              data-testid="lnm-delete"
            >
              <Trash2 size={11} />Delete
            </button>
          </div>
          <div className="border border-[#27272A] bg-[#0a0a0a] p-2 space-y-2" data-testid="lnm-overlay-display">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">coupling sign</span>
              <select
                value={signMode}
                onChange={(e) => setSignMode(e.target.value)}
                className="w-32 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                data-testid="lnm-sign-mode"
              >
                <option value="both">Both</option>
                <option value="pos">Positive only</option>
                <option value="neg">Negative only</option>
              </select>
            </div>
            {signMode !== "neg" && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">positive color</span>
                <select
                  value={posColor}
                  onChange={(e) => setPosColor(e.target.value)}
                  className="w-32 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                  data-testid="lnm-pos-color"
                >
                  {LNM_COLOR_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
            {signMode !== "pos" && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">negative color</span>
                <select
                  value={negColor}
                  onChange={(e) => setNegColor(e.target.value)}
                  className="w-32 bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1"
                  data-testid="lnm-neg-color"
                >
                  {LNM_COLOR_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="border border-[#27272A] bg-[#0a0a0a] p-3 space-y-1" data-testid="lnm-stats">
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Lesion voxels</span>
              <span className="text-zinc-200">{result.n_lesion_voxels.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Degree r (before→after)</span>
              <span className="text-zinc-200">{result.degree_corr_before} → {result.degree_corr_after ?? "n/a"}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Supra-threshold (+/−)</span>
              <span className="text-zinc-200">{result.n_pos_thr.toLocaleString()} / {result.n_neg_thr.toLocaleString()}</span>
            </div>
            {result.specificity?.run && (
              <div className="flex justify-between text-[11px]">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Survives specificity</span>
                <span className="text-zinc-200">
                  {result.specificity.n_sig_pos.toLocaleString()} / {result.specificity.n_sig_neg.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {atlasErrors.length > 0 && (
            <div className="font-mono text-[10px] text-amber-500/80 border border-[#27272A] px-2 py-2">
              {atlasErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {/* Network region tables */}
          {networkKeys.map((key) => (
            <div key={key} className="border border-[#27272A] bg-[#0a0a0a] p-2 space-y-1" data-testid={`lnm-net-${key}`}>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                {LNM_NETWORK_LABELS[key]}
              </div>
              <div className="max-h-40 overflow-y-auto">
                {(networks[key] || []).map((r, i) => (
                  <div key={i} className="flex justify-between text-[10px] text-zinc-400">
                    <span className="truncate pr-2">{r.name}</span>
                    <span className="text-zinc-500 tabular-nums whitespace-nowrap">
                      {r.voxels} · {r.pct}% · {result.metric}{r.mean_t}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {fileKeys.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {fileKeys.map((k) => (
                <a key={k} href={lnmResultUrl(result.files[k])} download
                  className="flex items-center justify-center gap-1 py-1.5 text-[9px] uppercase tracking-[0.1em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500 no-underline"
                  data-testid={`lnm-download-${k}`}>
                  <Download size={10} />{FILE_LABELS[k]}
                </a>
              ))}
            </div>
          )}

          {result.files?.html && (
            <a href={lnmResultUrl(result.files.html)} target="_blank" rel="noreferrer"
              className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500 no-underline"
              data-testid="lnm-open-report">
              <ExternalLink size={11} />Open full report
            </a>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={exportHtml}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="lnm-export-html">
              <FileCode size={11} />HTML
            </button>
            <button onClick={exportCsv}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="lnm-export-csv">
              <FileSpreadsheet size={11} />CSV
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default DaLnMapperPanel;
