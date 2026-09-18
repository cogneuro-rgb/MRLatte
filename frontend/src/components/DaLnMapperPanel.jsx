import React, { useState, useEffect, useRef } from "react";
import { Network, Download, FileCode, FileSpreadsheet, Eye, EyeOff, Trash2, Save, Scissors } from "lucide-react";
import FileUploader from "@/components/FileUploader";
import { ToggleButton } from "@/components/ui/toggle-button";
import {
  lnmAvailable,
  startLnm,
  lnmStatus,
  cancelLnm,
  lnmResultUrl,
  lnmToCSV,
  LNM_NETWORK_LABELS,
} from "@/lib/lnm";
import { buildReport } from "@/lib/report";
import { ReportDialog } from "@/components/ReportDialog";
import { downloadText } from "@/lib/volumeAnalysis";
import { currentDrawingAsFile } from "@/lib/lesions";
import { useModuleAvailable } from "@/hooks/useModuleAvailable";
import { useReportDialog } from "@/hooks/useReportDialog";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { RunningIndicator } from "@/components/RunningIndicator";
import { useJobPoll } from "@/hooks/useJobPoll";
import { buildStageSteps } from "@/lib/jobStages";
import { toast } from "sonner";
import { MAX_DEFAULT_NAME_LEN, stripNiftiExt, truncateName } from "@/lib/nameUtils";

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

// Ordered stages for the live progress indicator. Keys match the worker's
// status.json `stage` field (lnm_worker.py). "specificity" is the fine-grained
// permutation phase; it's filtered out of the display when the specificity test
// is off.
const STAGE_STEPS = [
  { key: "load", label: "Loading connectome" },
  { key: "seed", label: "Seed-to-voxel map" },
  { key: "specificity", label: "Specificity permutations" },
  { key: "regions", label: "Labelling regions" },
  { key: "render", label: "Rendering report" },
  { key: "done", label: "Done" },
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
export const DaLnMapperPanel = ({
  viewerRef, lesionLayers = [], userFileCache, clearNonce,
  // (file, name) => Promise<id> — thin wrapper over Dashboard's addUserFile,
  // registers the network map as a full activation layer (item 59).
  onSaveActivation,
}) => {
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
  // Pollable job (progress bar). `job` drives the RunningIndicator; `result`
  // still holds the final worker info exactly as before, so all downstream UI
  // (overlay load, stats, network tables, downloads) is unchanged.
  // Pollable job (progress bar) — see useJobPoll() call below, placed after
  // loadOverlay is defined since its onDone callback needs it in scope.
  const [result, setResult] = useState(null);
  // Was `useState(null)` with NOTHING ever calling setAvailable — lnmAvailable
  // was imported but never invoked, so `available` stayed null forever. That
  // made `runDisabled` (available !== true) permanently true, greying out
  // "Compute Network Map" for good, while the `available !== null` guard on
  // the explanation block below also hid any reason. A refactor regression:
  // the sibling panels moved to this hook, this one kept the dead state.
  const available = useModuleAvailable(lnmAvailable);
  // Stable id for this panel's network-map overlay (item 92: the section is
  // now keepMounted, so this stays a ref rather than state purely to avoid an
  // unnecessary re-render — functionally identical to the previous
  // useState(() => ...)). Unlike TractDissectionPanel's mesh id, this does NOT
  // need to change per run: addOverlayFromUrl has no name-based idempotent
  // cache (addMeshFromUrl does), and loadOverlay() already does an explicit
  // removeVolume(overlayIdRef.current) before loading the next result, so a
  // second compute correctly replaces the first under the same id. Refreshing
  // this per run would break that cleanup (the remove call would then target
  // an id nothing was ever loaded under, leaking the old overlay).
  const overlayIdRef = useRef(`lnm-net-${Date.now()}`);
  const [overlayLoaded, setOverlayLoaded] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayBaseOpacity, setOverlayBaseOpacity] = useState(0.8); // opacity used at load (for show/hide restore)
  // Unsaved-preview clip opt-out (SMALL-FIXES: clip off by default for
  // unsaved tract/network previews). Mirrors TractDissectionPanel's
  // trkClipOn — vol.__optOutClip is reset to true (clip OFF) on every
  // (re)load in loadOverlay(), so this state is kept in lockstep there.
  const [overlayClipOn, setOverlayClipOn] = useState(false);
  // Save → Activation Maps (item 59).
  const [savingActivation, setSavingActivation] = useState(false);
  const [activationSaved, setActivationSaved] = useState(false);
  const [activationSaveName, setActivationSaveName] = useState("");
  // Item 103: uniform Open/Save report dialog.
  // Item 103: uniform Open/Save report dialog.
  const { reportOpen, setReportOpen, openReport } = useReportDialog();

  // Clear All removes the network-map overlay volume from the viewer; drop the
  // stale result card / overlay state here to match.
  useEffect(() => {
    if (!clearNonce) return;
    setResult(null);
    setOverlayLoaded(false);
    setOverlayVisible(true);
    setOverlayClipOn(false);
  }, [clearNonce]);

  // Effective source lesion: an explicit dropdown pick, otherwise the first
  // loaded lesion. Without the fallback, loading a lesion and opening this
  // panel left "Compute Network Map" greyed out until the user ALSO picked
  // that same (often only) lesion from a dropdown that defaults to the
  // "— or pick loaded lesion —" placeholder — it read as "LNM is broken".
  // OneClickSummaryPanel already resolves its lesion this way
  // (`selLesionId || lesionLayers[0]?.id`); this matches it.
  const effLesionId = selLesionId || lesionLayers[0]?.id || "";

  const getFile = () =>
    lesionFile || (effLesionId ? userFileCache?.current?.[effLesionId]?.file : null);

  // SMALL-FIXES: default network-map name — "Network of <lesion mask name>",
  // matching TractDissectionPanel's "Tracts affected by <name>" pattern
  // (Item 100). getFile() is the same source-lesion value already used
  // elsewhere in this panel for the report/CSV lesionName, so it's the
  // correct "which lesion mask is this LNM run based on" value.
  const deriveDefaultActivationName = () => {
    const lesionName = stripNiftiExt(getFile()?.name);
    return lesionName ? truncateName(`Network of ${lesionName}`) : "Lesion Network Map";
  };

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
      try { viewerRef.current?.removeVolume?.(overlayIdRef.current); } catch (_e) { /* best-effort */ }
    }
    let vol;
    let baseOp = 0.8;
    // `files.spec_net` exists whenever specificity testing ran at all, even
    // with zero survivors (an all-zero, effectively invisible volume in that
    // case) — prefer it only when it actually carries signal, otherwise fall
    // back to the real (non-specificity-filtered) thresholded map so the
    // preview overlay isn't silently blank.
    const spec = info.specificity;
    const specHasSignal = !!spec?.run && ((spec.n_sig_pos || 0) + (spec.n_sig_neg || 0) > 0);
    if (specHasSignal && files.spec_net) {
      // Signed, specificity-filtered network: positive (coupled) and negative
      // (anticorrelated) tails rendered with a diverging colormap, both sides
      // windowed off the worker's robust display range.
      const lo = disp.cal_min ?? 1;
      const hi = disp.cal_max ?? lo + 1;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayIdRef.current,
        url: lnmResultUrl(files.spec_net),
        opacity: 0.8,
        ignoreZeroVoxels: true,
        ...signedOverlayOpts(lo, hi),
      });
    } else if (files.thresh_cont || files.spec_net) {
      const lo = disp.cal_min ?? 1;
      const hi = disp.cal_max ?? lo + 1;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayIdRef.current,
        url: lnmResultUrl(files.thresh_cont || files.spec_net),
        opacity: 0.8,
        ignoreZeroVoxels: true,
        ...signedOverlayOpts(lo, hi),
      });
    } else if (files.pos_bin) {
      baseOp = 0.75;
      vol = await viewerRef.current?.addOverlayFromUrl?.({
        id: overlayIdRef.current,
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
      // SMALL-FIXES: unsaved network-map previews default to clip OFF
      // (matches the rest of the app's overlays-default-to-clip-off
      // convention) — volumeClip.js reads this field directly off the
      // NVImage volume object. Reset on every (re)load — including the
      // sign/color re-render effect below, which calls loadOverlay() again
      // on a freshly re-fetched vol — so the clip toggle and the actual GL
      // state never drift apart.
      vol.__optOutClip = true;
      setOverlayLoaded(true);
      setOverlayVisible(true);
      setOverlayBaseOpacity(baseOp);
      setOverlayClipOn(false);
    }
  };

  // Per-preview 3D-clip-plane toggle for the unsaved network-map overlay
  // (SMALL-FIXES). setOverlayClip's `clipOn` polarity is the OPPOSITE of
  // __optOutClip (clipOn=true → __optOutClip=false), so passing `next`
  // straight through is correct.
  const toggleOverlayClip = () => {
    const next = !overlayClipOn;
    viewerRef.current?.setOverlayClip?.(overlayIdRef.current, next);
    setOverlayClipOn(next);
  };

  // Toggle the network overlay's visibility in the viewer (opacity 0 / restore);
  // keeps the result card, stats, and downloads intact.
  const toggleOverlayVisible = () => {
    const next = !overlayVisible;
    viewerRef.current?.setOverlayOpacity?.(overlayIdRef.current, next ? overlayBaseOpacity : 0);
    setOverlayVisible(next);
  };

  // Remove the network overlay from the viewer AND dismiss the result card.
  const deleteResult = () => {
    if (overlayLoaded) {
      try { viewerRef.current?.removeVolume?.(overlayIdRef.current); } catch (_e) { /* best-effort */ }
    }
    setOverlayLoaded(false);
    setOverlayVisible(true);
    setOverlayClipOn(false);
    setResult(null);
    setActivationSaved(false);
  };

  // Save the network map → Activation Maps section (item 59). Fetches the
  // chosen result file (specificity-filtered net, falling back to the
  // thresholded continuous map) into a Blob/File, registers it through
  // Dashboard's addUserFile path (full threshold/colormap controls), then
  // removes this panel's ad-hoc overlay volume to avoid a duplicate render.
  //
  // `files.spec_net` is generated by the backend whenever specificity testing
  // ran at all (`run_specificity`), even if ZERO voxels survived — in that
  // case it's an all-zero volume (a real, if degenerate, map: genuinely no
  // voxel is signed and there's nothing to zero-mask). Preferring it purely
  // because it *exists* silently threw away a perfectly good signed
  // `thresh_cont` map whenever specificity found no survivors. Only prefer
  // spec_net when it actually carries signal.
  const saveActivation = async () => {
    const files = result?.files;
    const spec = result?.specificity;
    const specHasSignal = !!spec?.run && ((spec.n_sig_pos || 0) + (spec.n_sig_neg || 0) > 0);
    const relPath = (specHasSignal && files?.spec_net) || files?.thresh_cont || files?.spec_net;
    if (!relPath || !onSaveActivation) {
      toast.error("No network map file to save");
      return;
    }
    setSavingActivation(true);
    try {
      const resp = await fetch(lnmResultUrl(relPath));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const name = activationSaveName.trim() || deriveDefaultActivationName();
      const file = new File([blob], `${name}.nii.gz`, { type: "application/gzip" });
      const id = await onSaveActivation(file, name);
      if (!id) { toast.error("Save failed"); return; }
      if (overlayLoaded) {
        try { viewerRef.current?.removeVolume?.(overlayIdRef.current); } catch (_e) { /* best-effort */ }
        setOverlayLoaded(false);
      }
      setActivationSaved(true);
      toast.success("Saved to Activation Maps", { description: name });
    } catch (e) {
      toast.error("Save failed", { description: e?.message });
    } finally {
      setSavingActivation(false);
    }
  };

  // ── Poll the running LNM job (hooks/useJobPoll.js) ──────────────────────────
  // Mirrors OneClickSummaryPanel's poll loop. The compute is unchanged — it
  // runs as a background job now, so we poll status.json for a progress bar
  // (the permutation phase fills 0→100%), then consume the final worker result
  // (status.result) exactly as the old single-await did.
  const { job, setJob, busy, cancelling, cancel: handleCancel } = useJobPoll({
    statusFn: lnmStatus,
    cancelFn: cancelLnm,
    onCancelled: () => toast.info("Lesion network mapping cancelled"),
    onError: (s) => toast.error("Lesion network mapping failed", { description: s.error }),
    onDone: async (s) => {
      const info = s.result;
      if (!info) return;
      setResult(info);
      try { await loadOverlay(info); } catch (_e) { /* best-effort viewer load */ }
      const spec = info.specificity;
      toast.success("Lesion network map computed", {
        description: spec?.run
          ? `${spec.n_sig_pos.toLocaleString()} / ${spec.n_sig_neg.toLocaleString()} voxels survive specificity`
          : `${info.n_pos_thr.toLocaleString()} / ${info.n_neg_thr.toLocaleString()} supra-threshold voxels`,
      });
    },
  });

  const run = async () => {
    const file = getFile();
    if (!file) {
      toast.error("Select, upload, or draw a lesion first.");
      return;
    }
    setResult(null);
    setActivationSaved(false);
    setActivationSaveName("");
    // Show the indicator immediately (before the /start round-trip returns).
    setJob({ jobId: null, stage: "queued", message: "Queued…", progress: 0, done: false, spec: runSpecificity });
    try {
      const { job_id } = await startLnm(file, {
        name: file.name,
        metric,
        threshold: tThreshold,
        zthr: zThreshold,
        degreeAdjust,
        runSpecificity,
        nperm,
        fdr,
      });
      setJob({ jobId: job_id, stage: "queued", message: "Queued…", progress: 0, done: false, spec: runSpecificity });
    } catch (e) {
      toast.error("Lesion network mapping failed", { description: e?.message });
      setJob(null);
    }
  };

  // Re-render the overlay in place when the sign filter or colors change —
  // display-only, no recompute.
  useEffect(() => {
    if (result) loadOverlay(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signMode, posColor, negColor]);

  // Item 103: uniform report — buildReport("lnm", …) reuses the same section
  // builders Tract Dissection/Lesion/One-Click Summary use, embedding the
  // figures the worker now returns directly (result.images) instead of this
  // panel pointing at a backend-composed report.html.
  const handleOpenReport = () => {
    if (!result) return;
    openReport();
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

  const runDisabled = busy || available !== true || (!lesionFile && !effLesionId);

  return (
    <div className="space-y-3" data-testid="lnm-panel">
      <SectionLabel icon={Network}>degree adjusted lesion networking</SectionLabel>

      {available !== null && available !== true && (
        <div className="font-mono text-[10px] text-muted-foreground border border-border px-2 py-2" data-testid="lnm-unavailable">
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
            className="w-full py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
            data-testid="lnm-use-drawing"
          >
            Use current drawing
          </button>
          {lesionFile && (
            <div className="font-mono text-[10px] text-muted-foreground truncate">{lesionFile.name}</div>
          )}
          {lesionLayers.length > 0 && (
            <select
              value={selLesionId}
              onChange={(e) => { setSelLesionId(e.target.value); setLesionFile(null); }}
              className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
              data-testid="lnm-lesion-select"
            >
              {/* The placeholder names the lesion that is ACTUALLY used when
                  nothing is explicitly picked (see effLesionId), so the
                  control never implies "no lesion selected" while the run
                  button is enabled. */}
              <option value="">
                {lesionFile ? "— or pick loaded lesion —" : (lesionLayers[0]?.name ?? "— or pick loaded lesion —")}
              </option>
              {lesionLayers.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}

          {/* Metric */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">metric</span>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
              className="w-28 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
              data-testid="lnm-metric"
            >
              <option value="t">one-sample t</option>
              <option value="z">Fisher-z</option>
            </select>
          </div>

          {/* Threshold */}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">
              {metric === "z" ? "|z| threshold" : "|t| threshold"}
            </span>
            {metric === "z" ? (
              <input
                type="number" min={0} step={0.05}
                value={zThreshold}
                onChange={(e) => setZThreshold(Math.max(0, Number(e.target.value) || 0))}
                className="w-20 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
                data-testid="lnm-threshold"
              />
            ) : (
              <input
                type="number" min={1} step={0.5}
                value={tThreshold}
                onChange={(e) => setTThreshold(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
                data-testid="lnm-threshold"
              />
            )}
          </div>

          {/* Degree adjust */}
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">degree adjust</span>
            <input
              type="checkbox"
              checked={degreeAdjust}
              onChange={(e) => setDegreeAdjust(e.target.checked)}
              data-testid="lnm-degree-adjust"
            />
          </label>

          {/* Specificity */}
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">specificity test</span>
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
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">permutations</span>
                <input
                  type="number" min={10} max={500} step={10}
                  value={nperm}
                  onChange={(e) => setNperm(Math.max(10, Number(e.target.value) || 10))}
                  className="w-20 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
                  data-testid="lnm-nperm"
                />
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">BH-FDR correct</span>
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
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50"
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
                className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
                data-testid="lnm-toggle-visible"
              >
                {overlayVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                {overlayVisible ? "Hide" : "Show"}
              </button>
            )}
            {overlayLoaded && (
              <ToggleButton
                pressed={overlayClipOn}
                onPressedChange={toggleOverlayClip}
                icon={Scissors}
                label="Clip"
                title="Clip this preview overlay to the 3D clip plane (off by default)"
                testId="lnm-preview-clip"
              />
            )}
            <button
              onClick={deleteResult}
              title="Remove overlay from viewer and clear this result"
              className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-red-400 hover:border-red-900"
              data-testid="lnm-delete"
            >
              <Trash2 size={11} />Delete
            </button>
          </div>

          {/* Save → Activation Maps section (item 59) */}
          {onSaveActivation && (result?.files?.spec_net || result?.files?.thresh_cont) && (
            activationSaved ? (
              <div className="font-mono text-[10px] text-emerald-400 border border-border px-2 py-2" data-testid="lnm-saved-notice">
                Saved to Activation Maps — full threshold/colormap controls are there now.
              </div>
            ) : (
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={activationSaveName}
                  onChange={(e) => setActivationSaveName(e.target.value)}
                  placeholder={`name for saved network map… (default: ${deriveDefaultActivationName()})`}
                  className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
                  data-testid="lnm-save-name"
                />
                <button
                  onClick={saveActivation}
                  disabled={savingActivation}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50"
                  data-testid="lnm-save"
                >
                  <Save size={11} />{savingActivation ? "Saving…" : "Save"}
                </button>
              </div>
            )
          )}

          <div className="border border-border bg-panel p-2 space-y-2" data-testid="lnm-overlay-display">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">coupling sign</span>
              <select
                value={signMode}
                onChange={(e) => setSignMode(e.target.value)}
                className="w-32 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
                data-testid="lnm-sign-mode"
              >
                <option value="both">Both</option>
                <option value="pos">Positive only</option>
                <option value="neg">Negative only</option>
              </select>
            </div>
            {signMode !== "neg" && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">positive color</span>
                <select
                  value={posColor}
                  onChange={(e) => setPosColor(e.target.value)}
                  className="w-32 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
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
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">negative color</span>
                <select
                  value={negColor}
                  onChange={(e) => setNegColor(e.target.value)}
                  className="w-32 bg-panel border border-border text-[11px] text-foreground px-2 py-1"
                  data-testid="lnm-neg-color"
                >
                  {LNM_COLOR_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="border border-border bg-panel p-3 space-y-1" data-testid="lnm-stats">
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Lesion voxels</span>
              <span className="text-foreground">{result.n_lesion_voxels.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Degree r (before→after)</span>
              <span className="text-foreground">{result.degree_corr_before} → {result.degree_corr_after ?? "n/a"}</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Supra-threshold (+/−)</span>
              <span className="text-foreground">{result.n_pos_thr.toLocaleString()} / {result.n_neg_thr.toLocaleString()}</span>
            </div>
            {result.specificity?.run && (
              <div className="flex justify-between text-[11px]">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Survives specificity</span>
                <span className="text-foreground">
                  {result.specificity.n_sig_pos.toLocaleString()} / {result.specificity.n_sig_neg.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          {atlasErrors.length > 0 && (
            <div className="font-mono text-[10px] text-amber-500/80 border border-border px-2 py-2">
              {atlasErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {/* Network region tables */}
          {networkKeys.map((key) => (
            <div key={key} className="border border-border bg-panel p-2 space-y-1" data-testid={`lnm-net-${key}`}>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                {LNM_NETWORK_LABELS[key]}
              </div>
              <div className="max-h-40 overflow-y-auto">
                {(networks[key] || []).map((r, i) => (
                  <div key={i} className="flex justify-between text-[10px] text-muted-foreground">
                    <span className="truncate pr-2">{r.name}</span>
                    <span className="text-muted-foreground tabular-nums whitespace-nowrap">
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
                  className="flex items-center justify-center gap-1 py-1.5 text-[9px] uppercase tracking-[0.1em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground no-underline"
                  data-testid={`lnm-download-${k}`}>
                  <Download size={10} />{FILE_LABELS[k]}
                </a>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={handleOpenReport}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="lnm-open-report">
              <FileCode size={11} />Report
            </button>
            <button onClick={exportCsv}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="lnm-export-csv">
              <FileSpreadsheet size={11} />CSV
            </button>
          </div>
          <ReportDialog
            open={reportOpen}
            onOpenChange={setReportOpen}
            title="Lesion Network Mapping Report"
            subject={getFile()?.name}
            html={result ? buildReport("lnm", { result, lesionName: getFile()?.name, images: result.images }) : null}
            filename={`lnm_report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`}
          />
        </>
      )}

      {/* Bottom-left running box (item 57) — now a pollable job (SMALL-FIXES
          102), so it shows a real staged progress bar; the specificity phase
          fills from ~0→100%. */}
      <RunningIndicator
        title="Lesion Network Map"
        active={busy}
        message={job?.message}
        progress={job?.progress}
        onCancel={handleCancel}
        cancelling={cancelling}
        steps={buildStageSteps(STAGE_STEPS.filter((s) => s.key !== "specificity" || job?.spec), job)}
      />
    </div>
  );
};

export default DaLnMapperPanel;
