import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { buildLesionReportModel } from "@/lib/lesionReport";
import { currentDrawingAsFile } from "@/lib/lesions";
import { runSummary, summaryStatus, summaryResultUrl } from "@/lib/summary";
import { toast } from "sonner";

// Ordered pipeline stages for the live indicator. Keys match the backend's
// status.json `stage` field.
const STAGE_STEPS = [
  { key: "prepare", label: "Preparing inputs" },
  { key: "dissect", label: "Tract dissection" },
  { key: "lnm", label: "Lesion network mapping" },
  { key: "render", label: "Rendering & packaging" },
  { key: "done", label: "Done" },
];
const STAGE_INDEX = STAGE_STEPS.reduce((m, s, i) => ((m[s.key] = i), m), {});

const DEFAULT_ATLASES = ["destrieux", "hcp1065"];

/**
 * OneClickSummaryPanel — a single button that runs the full lesion analysis
 * pipeline (atlas overlap + tract dissection + retinotopy check + DA-LNM) on the
 * backend and downloads a ZIP report (HTML w/ brainsprite, glass-brain PNGs, the
 * 2D retinotopy disc, and positive/negative/both network maps).
 *
 * Reuses the LesionReportPanel compute flow (buildLesionReportModel) for atlas
 * overlap values and the same disc data-URL callbacks for the 2D retinotopy disc.
 */
export const OneClickSummaryPanel = ({
  viewerRef, lesionLayers = [], standardAtlases = [],
  atlasLabelsRef, ensureAtlasLoaded, userFileCache,
  getPolarDiscDataUrl, getVfMap2dDataUrl,
}) => {
  const [open, setOpen] = useState(false);
  const [selLesionId, setSelLesionId] = useState("");
  const [stages, setStages] = useState({ overlap: true, dissect: true, retino: true, lnm: true });
  const [selAtlases, setSelAtlases] = useState(
    () => new Set(DEFAULT_ATLASES.filter((id) => standardAtlases.some((a) => a.id === id))));
  const [job, setJob] = useState(null); // { jobId, stage, message, progress, done, error }
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);

  const lesionId = selLesionId || lesionLayers[0]?.id;
  const lesionName = lesionLayers.find((l) => l.id === lesionId)?.name || lesionId || "lesion";

  const toggleStage = (k) => setStages((p) => ({ ...p, [k]: !p[k] }));
  const toggleAtlas = (id) => setSelAtlases((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  // Poll the job status while a job is running.
  useEffect(() => {
    if (!job?.jobId || job.done) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await summaryStatus(job.jobId);
        if (cancelled) return;
        setJob((prev) => (prev ? { ...prev, ...s } : prev));
        if (s.done) {
          clearInterval(pollRef.current);
          if (s.error) {
            toast.error("Summary failed", { description: s.error });
          } else if (s.files?.zip) {
            triggerDownload(summaryResultUrl(s.files.zip), `summary_${lesionName}.zip`);
            toast.success("Summary ready", { description: "ZIP downloaded." });
          }
        }
      } catch (e) {
        // transient poll error — keep trying until the interval is cleared
      }
    };
    pollRef.current = setInterval(tick, 1500);
    tick();
    return () => { cancelled = true; clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.done]);

  const triggerDownload = (url, filename) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const resolveLesionFile = async () => {
    const cached = userFileCache?.current?.[lesionId]?.file;
    if (cached) return cached;
    // Fall back to the in-memory drawing (drawn, not uploaded, lesions).
    return currentDrawingAsFile(viewerRef, `${lesionName}.nii.gz`);
  };

  // Build atlas-overlap values client-side (reuses computeAtlasOverlap via
  // buildLesionReportModel), matching LesionReportPanel.generate().
  const buildOverlapModel = async (lesionVol) => {
    const atlases = [];
    for (const a of standardAtlases) {
      if (!selAtlases.has(a.id)) continue;
      await ensureAtlasLoaded?.(a.id, { silent: true });
      const vol = viewerRef.current?.getVolume?.(a.id);
      const labels = atlasLabelsRef?.current?.[a.id];
      if (vol?.img && labels) atlases.push({ id: a.id, name: a.name, vol, labels });
    }
    return buildLesionReportModel({ lesionName, lesionVol, atlases, retinotopy: [] });
  };

  const run = async () => {
    if (!lesionId) return toast.error("No lesion layer");
    setStarting(true);
    try {
      const lesionFile = await resolveLesionFile();
      if (!lesionFile) {
        toast.error("Lesion file unavailable", { description: "Upload or draw a lesion first." });
        return;
      }

      let overlapModel = null;
      if (stages.overlap) {
        const lesionVol = viewerRef.current?.getVolume?.(lesionId);
        if (lesionVol?.img) {
          try { overlapModel = await buildOverlapModel(lesionVol); }
          catch (e) { toast.warning("Atlas overlap skipped", { description: e?.message }); }
        }
      }

      let discPngs = null;
      if (stages.retino) {
        try {
          const polar = getPolarDiscDataUrl?.() ?? null;
          // Pass the summary's selected lesion so the 2D map's deficit is computed
          // for THAT lesion, independent of the retinotopy panel's transient state.
          const vfmap = (await getVfMap2dDataUrl?.(lesionId)) ?? null;
          if (polar || vfmap) discPngs = { polar, vfmap };
        } catch { /* disc render is best-effort */ }
      }

      const payload = {
        name: lesionName,
        stages,
        atlases: [...selAtlases],
        overlapModel,
        discPngs,
      };
      const { job_id } = await runSummary(lesionFile, payload);
      setJob({ jobId: job_id, stage: "queued", message: "Queued…", progress: 0, done: false });
      setOpen(false); // reveal the bottom-left live indicator
      toast.info("One-Click Summary started", { description: lesionName });
    } catch (e) {
      toast.error("Could not start summary", { description: e?.message });
    } finally {
      setStarting(false);
    }
  };

  const currentIdx = job ? (STAGE_INDEX[job.stage] ?? -1) : -1;
  const active = job && !job.done;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={lesionLayers.length === 0 || active}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white border-transparent hover:opacity-90 disabled:opacity-50"
        data-testid="one-click-summary"
      >
        <Sparkles size={12} />{active ? "Summary running…" : "One-Click Summary"}
      </button>

      {/* === Configuration popup === */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[440px] bg-[#0a0a0a] border border-[#27272A] text-zinc-200">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
              <Sparkles size={14} className="text-fuchsia-400" /> One-Click Summary
            </DialogTitle>
            <DialogDescription className="text-[11px] text-zinc-500 font-mono truncate">
              {lesionName}
            </DialogDescription>
          </DialogHeader>

          {lesionLayers.length > 1 && (
            <select
              value={selLesionId}
              onChange={(e) => setSelLesionId(e.target.value)}
              className="w-full bg-[#111] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
              data-testid="summary-lesion-select"
            >
              <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
              {lesionLayers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}

          <div className="space-y-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">operations</div>
            {[
              ["overlap", "Atlas overlap"],
              ["dissect", "Tract dissection"],
              ["retino", "Retinotopy check"],
              ["lnm", "Lesion network mapping"],
            ].map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={stages[k]} onChange={() => toggleStage(k)}
                  className="accent-fuchsia-500" data-testid={`summary-stage-${k}`} />
                {label}
              </label>
            ))}
          </div>

          <div className="space-y-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">atlases in report</div>
            <div className="grid grid-cols-2 gap-1">
              {standardAtlases.map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggleAtlas(a.id)}
                  disabled={!stages.overlap}
                  className={`py-1 text-[10px] uppercase tracking-[0.08em] border transition-colors disabled:opacity-40 ${
                    selAtlases.has(a.id)
                      ? "bg-white text-black border-white"
                      : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                  }`}
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
            className="mt-1 w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white border-transparent hover:opacity-90 disabled:opacity-50"
            data-testid="summary-run"
          >
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {starting ? "Starting…" : "Run"}
          </button>
        </DialogContent>
      </Dialog>

      {/* === Live progress (bottom-left) === */}
      {job && (
        <div className="fixed bottom-4 left-4 z-50 w-72 border border-[#27272A] bg-[#0a0a0a]/95 backdrop-blur px-4 py-3 shadow-xl rounded-md" data-testid="summary-progress">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.15em] text-zinc-200">
              {job.error ? <XCircle size={13} className="text-red-400" />
                : job.done ? <CheckCircle2 size={13} className="text-emerald-400" />
                : <Loader2 size={13} className="animate-spin text-fuchsia-400" />}
              One-Click Summary
            </div>
            {(job.done || job.error) && (
              <button onClick={() => setJob(null)} className="text-zinc-500 hover:text-zinc-200 text-[11px]">✕</button>
            )}
          </div>
          <div className="space-y-1">
            {STAGE_STEPS.filter((s) => s.key === "prepare" || s.key === "render" || s.key === "done"
              || stages[s.key])
              .map((s) => {
                const idx = STAGE_INDEX[s.key];
                const state = job.error && idx >= currentIdx ? "error"
                  : idx < currentIdx || job.done ? "done"
                  : idx === currentIdx ? "active" : "pending";
                return (
                  <div key={s.key} className="flex items-center gap-2 text-[11px]">
                    {state === "done" ? <CheckCircle2 size={11} className="text-emerald-400" />
                      : state === "active" ? <Loader2 size={11} className="animate-spin text-fuchsia-400" />
                      : state === "error" ? <XCircle size={11} className="text-red-400" />
                      : <Circle size={11} className="text-zinc-600" />}
                    <span className={state === "pending" ? "text-zinc-600" : "text-zinc-300"}>{s.label}</span>
                  </div>
                );
              })}
          </div>
          {job.message && !job.done && (
            <div className="mt-2 text-[10px] text-zinc-500 truncate">{job.message}</div>
          )}
        </div>
      )}
    </>
  );
};

export default OneClickSummaryPanel;
