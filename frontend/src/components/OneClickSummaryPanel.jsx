import React, { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, FileCode, Download } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { buildTractReportModel } from "@/lib/htmlReport";
import { resolveReportFragments } from "@/lib/lesionReport";
import { NVImage } from "@niivue/niivue";
import { buildSummaryReport } from "@/lib/report";
import { lesionFigure, mapsFigure } from "@/lib/report/figures";
import { ReportDialog } from "@/components/ReportDialog";
import { ArtifactPickerDialog } from "@/components/ArtifactPickerDialog";
import { saveBinaryFile } from "@/lib/workspace";
import { currentDrawingAsFile } from "@/lib/lesions";
import { useReportDialog } from "@/hooks/useReportDialog";
import { runSummary, summaryStatus, summaryResultUrl, cancelSummary } from "@/lib/summary";
import { RunningIndicator } from "@/components/RunningIndicator";
import { useJobPoll } from "@/hooks/useJobPoll";
import { activeToggleCls } from "@/lib/buttonVariants";
import { buildStageSteps } from "@/lib/jobStages";
import { toast } from "sonner";
import { getCapabilities } from "@/lib/lesionMetrics";
import { LqtpyCredit } from "@/components/LqtpyCredit";

// Yield one macrotask before the disc render (a canvas-heavy step) so the
// tab gets a chance to paint the "running" indicator first (item 56). Atlas
// overlap used to be computed here too (another heavy pre-submit step this
// macrotask separated) — it's now backend-side, see run() below.
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

const over = (t) => (v) => v > t;

/** Still figures for the summary report (lib/report/figures.js): the lesion,
 * the affected tracts and the positive/negative network, drawn over the base
 * scan from this run's own maps (loaded off-screen, never into the viewer).
 * Each is optional; one that can't be made is simply left out. */
async function buildSummaryFigures(result, lesionFile, base) {
  if (!base?.img) return {};
  const has = (rel) => (result.artifacts || []).some((a) => a.rel === rel);
  const load = async (rel) => {
    if (!has(rel)) return null;
    try {
      return await NVImage.loadFromUrl({
        url: summaryResultUrl(`/api/summary/result/${result.jobId}/${rel}`), name: rel.split("/").pop(),
      });
    } catch {
      return null;
    }
  };
  let lesion = null;
  try {
    if (lesionFile) lesion = await NVImage.loadFromFile({ file: lesionFile, name: lesionFile.name || "lesion.nii.gz" });
  } catch {
    lesion = null;
  }
  const [tracts, pos, neg] = await Promise.all([
    load("maps/affected_tracts.nii.gz"), load("maps/network_pos_bin.nii.gz"), load("maps/network_neg_bin.nii.gz"),
  ]);
  await yieldToMain();
  const figures = { lesion: lesion ? lesionFigure(base, lesion) : null };
  await yieldToMain();
  if (tracts) {
    figures.tracts = mapsFigure(base, [{ vol: tracts, test: over(0), color: "#f43f5e", alpha: 0.75 }], lesion,
      "Tracts with streamlines through the lesion (red); the lesion is outlined in white. Axial slices, neurological orientation (left is left).");
  }
  await yieldToMain();
  if (pos || neg) {
    figures.network = mapsFigure(base, [
      pos && { vol: pos, test: over(0.5), color: "#f97316", alpha: 0.75 },
      neg && { vol: neg, test: over(0.5), color: "#3b82f6", alpha: 0.75 },
    ].filter(Boolean), lesion,
    "The run's final network masks: voxels coupled to the lesion (orange) and anticorrelated with it (blue), after the specificity test when it ran; the lesion is outlined in white. Axial slices, neurological orientation (left is left).");
  }
  return figures;
}

// Ordered pipeline stages for the live indicator. Keys match the backend's
// status.json `stage` field.
const STAGE_STEPS = [
  { key: "prepare", label: "Preparing inputs" },
  { key: "dissect", label: "Tract dissection" },
  { key: "lnm", label: "Lesion network mapping" },
  { key: "render", label: "Rendering & packaging" },
  { key: "done", label: "Done" },
];
const DEFAULT_ATLASES = ["destrieux", "hcp1065"];

/**
 * OneClickSummaryPanel — a single button that runs the full lesion analysis
 * pipeline (atlas overlap + tract dissection + retinotopy check + DA-LNM) on
 * the backend. On completion it opens the composed report directly — the
 * run's one figure output, with its figures drawn here from the run's maps
 * (lib/report/figures.js) and embedded, so a saved copy is complete. Nothing
 * is downloaded automatically; "Download" opens ArtifactPickerDialog for the
 * run's DATA (maps, overlap table).
 *
 * Atlas overlap is computed backend-side (lqtpy, in-process — see
 * deps.py's _run_summary_job / _summary_overlap_stage) from the `atlas_ids`
 * this panel sends. The 2D visual-field map is computed here, for the run's
 * own lesion (getVfMap2dDataUrl), and embedded in the report.
 */
export const OneClickSummaryPanel = ({
  viewerRef, lesionLayers = [], standardAtlases = [],
  userFileCache,
  getVfMap2dDataUrl,
}) => {
  const [open, setOpen] = useState(false);
  // The running lqtpy's version, credited in the setup dialog (inbox 29 Oct).
  const [engineVersion, setEngineVersion] = useState(null);
  useEffect(() => {
    if (!open) return;
    getCapabilities().then((c) => setEngineVersion(c?.version || null)).catch(() => {});
  }, [open]);
  const [selLesionId, setSelLesionId] = useState("");
  const [stages, setStages] = useState({ overlap: true, dissect: true, retino: true, lnm: true });
  const [selAtlases, setSelAtlases] = useState(
    () => new Set(DEFAULT_ATLASES.filter((id) => standardAtlases.some((a) => a.id === id))));
  const [starting, setStarting] = useState(false);
  // Named save for the report (item 75) — defaults to the lesion name.
  const [summaryName, setSummaryName] = useState("");
  // Item 103: the completed job's data (dissect/lnm/overlap info + asset
  // URLs — see deps.py's _run_summary_job final status write), kept around
  // so Report/Download can compose from and reference the same run's assets.
  const [summaryResult, setSummaryResult] = useState(null);
  // Item 0b: the report HTML is built eagerly in onDone (not lazily behind a
  // "Report" click) so ReportDialog can open itself the moment the job
  // finishes — mirrors LesionReportPanel's reportHtml pattern.
  const [reportHtml, setReportHtml] = useState(null);
  // lqtpy's embeddable report-fragment sections for the CURRENT summaryResult
  // (see lib/lesionReport.js::resolveReportFragments) — fetched in the
  // background after the report first opens (see onDone below), so the
  // report still opens the instant the job finishes; once it lands, the
  // dialog's html is rebuilt to include it. null until fetched (or if no
  // overlap stage ran / no lesion file was available).
  const [reportFragments, setReportFragments] = useState(null);
  const [artifactPickerOpen, setArtifactPickerOpen] = useState(false);
  const { reportOpen, setReportOpen, openReport } = useReportDialog();
  // The lesion File resolved for the run currently in flight (or just
  // finished) — kept around so the background report-fragments fetch below
  // doesn't need to re-resolve it (drawn lesions have no stable path to
  // re-resolve from anyway).
  const lesionFileRef = useRef(null);
  // What arrives after the report first opens — lqtpy's sections and the
  // figures — for the run on screen; the report is rebuilt as each lands.
  const extrasRef = useRef({ frags: null, figures: null });
  // The run's 2D visual-field map (a PNG data URL), embedded in its report.
  const vfMapRef = useRef(null);

  const lesionId = selLesionId || lesionLayers[0]?.id;
  const lesionName = lesionLayers.find((l) => l.id === lesionId)?.name || lesionId || "lesion";

  const toggleStage = (k) => setStages((p) => ({ ...p, [k]: !p[k] }));
  const toggleAtlas = (id) => setSelAtlases((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  // Poll the job status while a job is running (hooks/useJobPoll.js).
  // keepDoneState: true — the finished job stays in `job` (done:true) so
  // RunningIndicator shows its "done" checkmark instead of vanishing; the
  // user (or a fresh run's setJob) clears it, not the hook.
  const { job, setJob, busy: active, cancelling, cancel: handleCancel } = useJobPoll({
    statusFn: summaryStatus,
    cancelFn: cancelSummary,
    keepDoneState: true,
    onCancelled: () => toast.info("Summary cancelled"),
    onError: (s) => toast.error("Summary failed", { description: s.error }),
    onDone: (s, curJob) => {
      // Item 103/0b: keep the job's data around so Report/Download (shown
      // once done) can compose from it — including `overlap_model` (and its
      // `provenance`), computed backend-side and returned via s.files. `name`
      // is the name captured on the job at start time (item 75) — NOT the
      // live `lesionName`/`summaryName` closures, so a rename typed after
      // starting doesn't retroactively relabel the finished run.
      const result = {
        ...(s.files || {}),
        jobId: curJob.jobId,
        name: curJob.name,
      };
      setSummaryResult(result);
      // Task 0b: the report now opens automatically on completion instead of
      // silently dropping a ZIP in Downloads — built eagerly here (not in a
      // useEffect watching the result, which would re-fire on unrelated
      // renders) so ReportDialog has html the instant it opens.
      extrasRef.current = { frags: null, figures: null };
      const rebuild = () => setReportHtml(buildOneClickReportHtml(result, extrasRef.current.frags, extrasRef.current.figures));
      const html = buildOneClickReportHtml(result, null, null);
      setReportHtml(html);
      if (html) {
        openReport();
        toast.success("Summary ready", { description: "Report opened." });
      }
      // lqtpy's embeddable report-fragment sections, fetched in the
      // background (not awaited above) so the report opens immediately —
      // once this lands, the dialog's html is rebuilt to include it. Only
      // attempted when the overlap stage actually ran (there's a lesion
      // model to attach fragments to) and a lesion file is still available.
      if (result.overlap_model && lesionFileRef.current) {
        const atlasIds = (result.overlap_model.atlasBreakdowns || []).map((b) => b.atlasId);
        const threshold = result.overlap_model.provenance?.threshold;
        resolveReportFragments({ lesionFile: lesionFileRef.current, atlasIds, threshold })
          .then((frags) => {
            extrasRef.current.frags = frags;
            setReportFragments(frags);
            rebuild();
          });
      }
      buildSummaryFigures(result, lesionFileRef.current, viewerRef.current?.getBaseVolume?.())
        .catch(() => ({}))
        .then((figures) => {
          extrasRef.current.figures = figures;
          rebuild();
        });
    },
  });

  const resolveLesionFile = async () => {
    const cached = userFileCache?.current?.[lesionId]?.file;
    if (cached) return cached;
    // Fall back to the in-memory drawing (drawn, not uploaded, lesions).
    return currentDrawingAsFile(viewerRef, `${lesionName}.nii.gz`);
  };

  const run = async () => {
    if (!lesionId) return toast.error("No lesion layer");
    const name = summaryName.trim() || lesionName;
    setStarting(true);
    setSummaryResult(null); // clear the previous run's report data
    setReportHtml(null);
    setReportFragments(null);
    // Item 56/57: surface the running indicator BEFORE the async work below
    // starts, not after runSummary() returns — otherwise the tab looks
    // frozen with nothing visible while the lesion file resolves and the
    // disc renders. Closing the dialog now also reveals the bottom-left box
    // immediately.
    setJob({ jobId: null, stage: "prepare", message: "Preparing inputs…", progress: 0, done: false, name });
    setOpen(false);
    try {
      const lesionFile = await resolveLesionFile();
      if (!lesionFile) {
        toast.error("Lesion file unavailable", { description: "Upload or draw a lesion first." });
        setJob(null);
        return;
      }
      lesionFileRef.current = lesionFile;

      // Atlas overlap is no longer computed here — the backend computes it
      // in-process via lqtpy from `atlas_ids` below, before dispatching any
      // worker (see deps.py's _summary_overlap_stage). This used to be a
      // multi-second client-side voxel-loop compute (buildOverlapModel ->
      // buildLesionReportModel) blocking the submit; removing it is most of
      // the submit-to-job-accepted speedup (see task notes for measurements).
      await yieldToMain();

      vfMapRef.current = null;
      if (stages.retino) {
        try {
          // For the summary's selected lesion, independent of the Retinotopy
          // panel's transient state.
          vfMapRef.current = (await getVfMap2dDataUrl?.(lesionId)) ?? null;
        } catch { /* the map is best-effort */ }
      }

      const payload = {
        name,
        stages,
        atlas_ids: stages.overlap ? [...selAtlases] : [],
      };
      const { job_id } = await runSummary(lesionFile, payload);
      setJob({ jobId: job_id, stage: "queued", message: "Queued…", progress: 0, done: false, name });
      toast.info("LQTpy Analysis started", { description: name });
    } catch (e) {
      toast.error("Could not start LQTpy Analysis", { description: e?.message });
      setJob(null);
    } finally {
      setStarting(false);
    }
  };

  // Item 103: compose the overall summary report from whichever sub-results
  // this run produced — the SAME section builders (buildTractSections,
  // buildLnmSections, buildLesionAtlasSection…) Tract Dissection and LNM use
  // for their own reports, matching "an overall report with submodules used
  // elsewhere." Takes the result explicitly (defaulting to state) so onDone
  // can build it eagerly from the just-computed result, before the
  // setSummaryResult() above has actually landed in state (item 0b).
  const buildOneClickReportHtml = (r = summaryResult, frags = reportFragments, figures = extrasRef.current.figures) => {
    if (!r) return null;
    // Embedded as a data URL (not a link to the running app), so a saved
    // report still shows it.
    const extraImages = [
      vfMapRef.current && { label: "Visual-field map", dot: "#7c3aed", imgUrl: vfMapRef.current },
    ].filter(Boolean);
    return buildSummaryReport({
      // r.name is the job-start-captured name (item 75) — preferred over the
      // live `lesionName` closure, which may have been retyped mid-run.
      lesionName: r.lesion_name || r.name || lesionName,
      // Backend-computed (lqtpy, in-process) or, when lqtpy was unavailable,
      // a fallback carrying visible JS/fallback provenance — either way this
      // is exactly the model buildLesionStatsSection/buildLesionAtlasSection
      // expect, same as the Lesion Report's own model (see
      // engineProvenanceLabel in lib/lesionReport.js for the pill text).
      lesionModel: r.overlap_model || null,
      reportFragments: frags,
      tractModel: r.dissect_info ? buildTractReportModel(r.dissect_info, r.lesion_name) : null,
      lnmResult: r.lnm_info || null,
      extraImages,
      figures: figures || {},
      retino: r.retino || null,
    });
  };
  const handleOpenReport = () => {
    if (!summaryResult) return;
    setReportHtml(buildOneClickReportHtml(summaryResult, reportFragments));
    openReport();
  };

  return (
    <>
      {/* One row (sidebar declutter): what used to be the line under the
          button is its tooltip now. */}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] text-muted-foreground">LQTpy analysis</span>
        <button
          onClick={() => setOpen(true)}
          disabled={lesionLayers.length === 0 || active}
          className="btn-primary flex min-h-[26px] gap-1.5 px-2.5 text-[12px]"
          title="Opens the run setup: name, operations, atlases. Progress shows at the bottom left, with Cancel."
          data-testid="one-click-summary"
        >
          <Sparkles size={12} />{active ? "Running…" : "Set up…"}
        </button>
      </div>

      {/* === Configuration popup === */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[440px] bg-panel border border-edge text-foreground">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles size={14} /> LQTpy analysis
            </DialogTitle>
            <DialogDescription className="text-[12px] text-muted-foreground font-mono truncate">
              {lesionName}
            </DialogDescription>
            <LqtpyCredit version={engineVersion} prefix="Runs on " />
          </DialogHeader>

          {lesionLayers.length > 1 && (
            <select
              value={selLesionId}
              onChange={(e) => setSelLesionId(e.target.value)}
              className="field w-full"
              data-testid="summary-lesion-select"
            >
              <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
              {lesionLayers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}

          {/* Named save for the report (item 75) — falls back to the
              lesion name if left blank. */}
          <input
            type="text"
            value={summaryName}
            onChange={(e) => setSummaryName(e.target.value)}
            placeholder={`name for report… (default: ${lesionName})`}
            className="field w-full"
            data-testid="summary-name"
          />

          <div className="space-y-2">
            <div className="cap text-subtle">Operations</div>
            {[
              ["overlap", "Atlas overlap"],
              ["dissect", "Tract dissection"],
              ["retino", "Retinotopy check"],
              ["lnm", "Lesion network mapping"],
            ].map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
                <input type="checkbox" checked={stages[k]} onChange={() => toggleStage(k)}
                  className="accent-crema" data-testid={`summary-stage-${k}`} />
                {label}
              </label>
            ))}
          </div>

          <div className="space-y-2">
            <div className="cap text-subtle">Atlases in the report</div>
            <div className="flex flex-wrap gap-1.5">
              {standardAtlases.map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggleAtlas(a.id)}
                  disabled={!stages.overlap}
                  aria-pressed={selAtlases.has(a.id)}
                  className={`h-[26px] rounded-[5px] border px-2.5 text-[12px] transition-colors disabled:opacity-40 ${activeToggleCls(selAtlases.has(a.id))}`}
                  data-testid={`summary-atlas-${a.id}`}
                  title={a.name}
                >
                  {a.short || a.id}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={run}
            disabled={starting}
            className="btn-primary mt-1 flex w-full gap-2 px-3 py-2"
            data-testid="summary-run"
          >
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {starting ? "Starting…" : "Run"}
          </button>
        </DialogContent>
      </Dialog>

      {/* === Live progress (bottom-left) — shared RunningIndicator (item 57) === */}
      <RunningIndicator
        title="LQTpy analysis"
        active={!!job}
        done={!!job?.done}
        error={job?.error}
        message={job?.message}
        onCancel={handleCancel}
        cancelling={cancelling}
        onDismiss={() => setJob(null)}
        // Item 105: One-Click Summary now has a real progress bar like Tract
        // Dissection and LNM. The backend mirrors each sub-worker's own 0..1
        // progress channel into status.json's `progress`, rescaled into that
        // stage's band (deps.py's run_stage) — so the bar advances THROUGH the
        // long dissection/LNM stages instead of only at stage boundaries.
        progress={job?.progress}
        steps={buildStageSteps(
          STAGE_STEPS.filter((s) => s.key === "prepare" || s.key === "render" || s.key === "done" || stages[s.key]),
          job,
        )}
      />

      {/* Item 103/0b: once a run completes the report has already opened
          itself (onDone above); "Report" just reopens it, and "Download"
          opens the selective artifact picker in place of the old
          download-everything ZIP. Not gated on `!job` any more — with
          keepDoneState the finished job stays around (for RunningIndicator's
          done checkmark) instead of vanishing. */}
      {summaryResult && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={handleOpenReport}
            className="btn"
            data-testid="summary-open-report"
          >
            <FileCode size={12} />Report
          </button>
          <button
            onClick={() => setArtifactPickerOpen(true)}
            disabled={!summaryResult.jobId}
            className="btn"
            data-testid="summary-open-download"
          >
            <Download size={12} />Download…
          </button>
        </div>
      )}
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title="Analysis report"
        subject={summaryResult?.lesion_name || summaryResult?.name || lesionName}
        html={reportHtml}
        filename={`analysis_report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`}
      />
      <ArtifactPickerDialog
        open={artifactPickerOpen}
        onOpenChange={setArtifactPickerOpen}
        jobId={summaryResult?.jobId}
      />
    </>
  );
};

export default OneClickSummaryPanel;
