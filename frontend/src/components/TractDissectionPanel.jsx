import React, { useState, useEffect, useRef } from "react";
import { GitBranch, Download, FileCode, SplitSquareHorizontal, Eye, EyeOff, Trash2, Save, Scissors } from "lucide-react";
import FileUploader from "@/components/FileUploader";
import { ToggleButton } from "@/components/ui/toggle-button";
import {
  dissectAvailable,
  startDissection,
  startBetween,
  dissectionStatus,
  cancelDissection,
  tractResultUrl,
} from "@/lib/tractDissection";
import { buildTractReportModel, ATLAS_KEY_NAMES } from "@/lib/htmlReport";
import { buildReport } from "@/lib/report";
import { ReportDialog } from "@/components/ReportDialog";
import { currentDrawingAsFile } from "@/lib/lesions";
import { RunningIndicator } from "@/components/RunningIndicator";
import { useVisibleAtlases } from "@/hooks/use-atlases";
import { useJobPoll } from "@/hooks/useJobPoll";
import { buildStageSteps } from "@/lib/jobStages";
import { toast } from "sonner";
import { MAX_DEFAULT_NAME_LEN, stripNiftiExt, truncateName } from "@/lib/nameUtils";
import { activeToggleCls, primaryBtnCls } from "@/lib/buttonVariants";
import { useModuleAvailable } from "@/hooks/useModuleAvailable";
import { useReportDialog } from "@/hooks/useReportDialog";

// Item 100: default tract name derivation. Auto-generated mask names come
// from DrawingPanel's derivedName() — "mask_<scan-slug>_HH-MM-SS" — anything
// else is a name the user typed themselves.
const AUTO_MASK_NAME_RE = /^mask_.+_\d{2}-\d{2}-\d{2}$/;


// The atlas driving the region-overlap breakdown comes from the registry now.
// It used to be three hardcoded values matching deps._ATLAS_PRESETS, which meant
// only those three could ever produce a breakdown and a user-imported atlas
// never could. deps._atlas_specs_for() resolves any installed atlas (by id or
// legacy alias), so the picker just lists what is installed.
//
// result.atlas_overlap stays keyed by the per-atlas spec key, which is the
// atlas's pre-revamp id where it has one — see lib/htmlReport.js.

// Ordered stages for the live progress indicator. Keys match the worker's
// status.json `stage` field (dissect_worker.py / dissect_between_worker.py).
const STAGE_STEPS = [
  { key: "load", label: "Loading tractogram" },
  { key: "resample", label: "Resampling lesion" },
  { key: "filter", label: "Selecting streamlines" },
  { key: "rasterize", label: "Rasterizing tract" },
  { key: "atlas", label: "Atlas overlap" },
  { key: "done", label: "Done" },
];
// Module-level so it keeps a stable identity across parent re-renders
// (defining it inside the component would remount the FileUploader/select
// on every keystroke and steal focus). lesionLayers is threaded as a prop.
// `autoPicked` (optional): when nothing is explicitly selected the caller
// still uses this lesion, so name it in the placeholder rather than showing
// "— or pick loaded lesion —" next to an enabled Run button.
function LesionInput({ label, file, onFile, selId, onSelect, uploadTestId, selectTestId, lesionLayers = [], onUseDrawing, autoPicked = false }) {
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">{label}</div>
      )}
      <FileUploader
        label={label ? `Upload ${label.toLowerCase()}` : "Upload lesion mask"}
        description=".nii / .nii.gz"
        accept=".nii,.nii.gz"
        onFile={(f) => { onFile(f); onSelect(""); }}
        testId={uploadTestId}
      />
      {onUseDrawing && (
        <button
          type="button"
          onClick={onUseDrawing}
          className="w-full py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
          data-testid={`${uploadTestId}-use-drawing`}
        >
          Use current drawing
        </button>
      )}
      {file && (
        <div className="font-mono text-[10px] text-muted-foreground truncate">{file.name}</div>
      )}
      {lesionLayers.length > 0 && (
        <select
          value={selId}
          onChange={(e) => { onSelect(e.target.value); onFile(null); }}
          className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
          data-testid={selectTestId}
        >
          <option value="">
            {autoPicked && !file ? (lesionLayers[0]?.name ?? "— or pick loaded lesion —") : "— or pick loaded lesion —"}
          </option>
          {lesionLayers.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// Per-ROI streamline filter mode. "start"/"terminate" both test the endpoints
// (streamlines are undirected); "through" tests any point inside the ROI.
function ModeSelect({ value, onChange, testId }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
      data-testid={testId}
    >
      <option value="through">Passes through this ROI</option>
      <option value="start">Starts at this ROI</option>
      <option value="terminate">Terminates at this ROI</option>
    </select>
  );
}

// Atlas driving the region-overlap breakdown (WM atlases + Harvard-Oxford).
function AtlasSelect({ value, onChange, testId }) {
  const atlases = useVisibleAtlases();
  return (
    <div className="space-y-1">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle">
        Region atlas
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
        data-testid={testId}
      >
        {atlases.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </div>
  );
}

export const TractDissectionPanel = ({
  viewerRef,
  lesionLayers = [],
  userFileCache,
  // (meshName, displayName) => void — registers the already-loaded dissected
  // mesh into Dashboard's tractLayers so it appears under Tractography with
  // full remove/opacity controls (item 58).
  onSaveTract,
}) => {
  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState("single"); // "single" | "between"
  const [atlas, setAtlas] = useState("harvard_oxford_cort"); // region-breakdown atlas

  // ── Single-mode inputs ────────────────────────────────────────────────────
  const [lesionFile, setLesionFile] = useState(null);
  const [selLesionId, setSelLesionId] = useState("");

  // ── Between-mode inputs ───────────────────────────────────────────────────
  const [lesionFileA, setLesionFileA] = useState(null);
  const [selLesionIdA, setSelLesionIdA] = useState("");
  const [lesionFileB, setLesionFileB] = useState(null);
  const [selLesionIdB, setSelLesionIdB] = useState("");
  // Per-ROI filter mode: "through" | "start" | "terminate". Streamlines are
  // undirected, so start/terminate both resolve to an endpoint test on the
  // backend — the directionality comes from requiring different endpoints.
  const [modeA, setModeA] = useState("through");
  const [modeB, setModeB] = useState("through");

  // ── State ─────────────────────────────────────────────────────────────────
  // Pollable job (progress bar) — see useJobPoll() call below, placed after
  // _loadResults is defined since its onDone callback needs it in scope.
  // `result` holds the final worker info the same way it did before the
  // refactor, so all downstream UI is unchanged.
  const [result, setResult] = useState(null);
  // Item 103: uniform Open/Save report dialog state.
  const { reportOpen, setReportOpen, openReport } = useReportDialog();
  // Per-run base id; the TRK mesh name derives from it. Set fresh at the start
  // of each dissection so a previously-saved tract (now owned by Tractography)
  // is never clobbered by the next run's mesh.
  const overlayIdRef = useRef(null);
  const [trkLoaded, setTrkLoaded] = useState(false);
  const [trkVisible, setTrkVisible] = useState(true);
  // Unsaved-preview clip opt-out (SMALL-FIXES: clip off by default for
  // unsaved tract/network previews). mesh.__tractClip = false is set right
  // after every load in _loadResults, so this state is kept in lockstep there.
  const [trkClipOn, setTrkClipOn] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const available = useModuleAvailable(dissectAvailable);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getFile = (file, selId) =>
    file || (selId ? userFileCache?.current?.[selId]?.file : null);

  // Single-lesion mode falls back to the first loaded lesion when the user
  // hasn't picked one explicitly — same fix (and same reasoning) as
  // DaLnMapperPanel's effLesionId: otherwise "Run Dissection" stays greyed
  // out after loading a lesion until it is ALSO chosen from a dropdown that
  // defaults to a placeholder. Deliberately NOT applied to "between" mode,
  // where auto-picking one lesion for both A and B would be meaningless.
  const effLesionId = selLesionId || lesionLayers[0]?.id || "";

  // Item 100: default tract name — "Tracts affected by <mask name>" when the
  // input mask has a custom (user-typed) name, otherwise the old timestamp
  // fallback (restating an auto-generated "mask_scan_14-23-01" name would just
  // be noise). Both lesions must be custom-named in "between" mode, since a
  // half-auto half-custom pair has no single clean sentence.
  const deriveDefaultTractName = () => {
    const fallback = `Tract Dissection · ${new Date().toLocaleTimeString()}`;
    if (mode === "between") {
      const a = stripNiftiExt(getFile(lesionFileA, selLesionIdA)?.name);
      const b = stripNiftiExt(getFile(lesionFileB, selLesionIdB)?.name);
      if (a && b && !AUTO_MASK_NAME_RE.test(a) && !AUTO_MASK_NAME_RE.test(b)) {
        return truncateName(`Tracts between ${a} and ${b}`);
      }
      return fallback;
    }
    const name = stripNiftiExt(getFile(lesionFile, effLesionId)?.name);
    if (name && !AUTO_MASK_NAME_RE.test(name)) {
      return truncateName(`Tracts affected by ${name}`);
    }
    return fallback;
  };

  // Pull the current in-memory drawing (scratch lesion) into an input without a
  // disk save first.
  const pickDrawing = async (setFile, clearSel) => {
    const f = await currentDrawingAsFile(viewerRef, "drawing_lesion.nii.gz");
    if (!f) {
      toast.error("Nothing drawn yet — draw a lesion first.");
      return;
    }
    setFile(f);
    clearSel("");
  };

  // addMeshFromUrl is idempotent on name (returns the cached mesh if the name
  // is already loaded), so the old mesh MUST be removed before re-running.
  const _clearPreviousTract = () => {
    const prevName = result?.meshName;
    if (trkLoaded && prevName) {
      viewerRef.current?.removeMesh?.(prevName);
      setTrkLoaded(false);
      setTrkClipOn(false);
    }
  };

  // Per-preview 3D-clip-plane toggle for the unsaved dissected-tract mesh
  // (SMALL-FIXES). setTractClip's `enabled` polarity matches mesh.__tractClip
  // directly (enabled=true → clip on), so `next` passes straight through.
  const toggleTrkClip = () => {
    const next = !trkClipOn;
    viewerRef.current?.setTractClip?.(result?.meshName, next);
    setTrkClipOn(next);
  };

  // Toggle the dissected-tract mesh visibility in the 3D view (opacity 0/1);
  // keeps the result card + downloads intact.
  const toggleTrkVisible = () => {
    const next = !trkVisible;
    viewerRef.current?.setMeshOpacity?.(result?.meshName, next ? 1.0 : 0);
    setTrkVisible(next);
  };

  // Remove the tract mesh from the viewer AND dismiss the result card.
  const deleteResult = () => {
    _clearPreviousTract();
    setTrkVisible(true);
    setResult(null);
    setSaved(false);
  };

  // Register the already-loaded dissected mesh into Dashboard's tractLayers
  // (item 58) — reuses the SAME mesh name (result.meshName) so the
  // Tractography section's remove/opacity controls act on the mesh already
  // in the viewer, instead of loading a duplicate copy. Clears our own card
  // (without removing the mesh) so the tract "moves" to Tractography with no
  // reload/flicker.
  const saveTract = () => {
    if (!trkLoaded || !onSaveTract || !result?.meshName) return;
    const name = saveName.trim() || deriveDefaultTractName();
    const lesionName =
      mode === "between"
        ? getFile(lesionFileA, selLesionIdA)?.name
        : getFile(lesionFile, effLesionId)?.name;
    // Same mesh id → Tractography adopts the mesh already in the viewer (no reload).
    onSaveTract(result.meshName, name, { result, lesionName });
    // Clear our own card so it disappears from Tract Dissection; do NOT removeMesh.
    setTrkLoaded(false);
    setResult(null);
    setSaved(false);
    setSaveName("");
    toast.success("Saved to Tractography", { description: name });
  };

  const _loadResults = async (info) => {
    if (!info.files) return null;
    // Load the dissected .trk as colorful direction-encoded (DTI RGB)
    // streamlines — the dissected subset then looks like the colorful global
    // tractogram. The red "hot" density NIfTI is NOT shown in the viewer; it
    // stays available only as a download link below.
    const meshName = `${overlayIdRef.current}_trk`;
    const trkUrl = tractResultUrl(info.files.trk);
    const mesh = await viewerRef.current?.addMeshFromUrl?.(trkUrl, {
      colorByDirection: true,   // DTI RGB: each segment colored by its direction vector
      name: meshName,
      opacity: 1.0,
    });
    if (mesh) {
      // SMALL-FIXES: unsaved tract previews default to clip OFF (matches the
      // rest of the app's overlays-default-to-clip-off convention) —
      // tractRenderer.js reads this field directly off the mesh object;
      // unset/undefined means clip ON, so it must be explicitly set here.
      mesh.__tractClip = false;
      setTrkLoaded(true);
      setTrkVisible(true);
      setTrkClipOn(false);
    }
    return meshName;
  };

  // ── Poll the running dissection job (hooks/useJobPoll.js) ──────────────────
  // Mirrors OneClickSummaryPanel's poll loop. The heavy compute is unchanged —
  // it just runs as a background job now, so we poll status.json for a progress
  // bar, then consume the final worker result (status.result) exactly as the
  // old single-await did (load the .trk mesh, show the result card, toasts).
  const { job, setJob, busy, cancelling, cancel: handleCancel } = useJobPoll({
    statusFn: dissectionStatus,
    cancelFn: cancelDissection,
    onCancelled: () => toast.info("Dissection cancelled"),
    onError: (s, curJob) => toast.error(
      curJob.mode === "between" ? "Between-dissection failed" : "Dissection failed",
      { description: s.error },
    ),
    onDone: async (s, curJob) => {
      const info = s.result;
      if (!info) return;
      if (info.n_selected_streamlines === 0) {
        setResult(info);
        toast.info("No streamlines", {
          description: info.message || "No streamlines satisfy the selection criteria.",
        });
      } else {
        let meshName = null;
        try { meshName = await _loadResults(info); } catch (_e) { /* best-effort viewer load */ }
        setResult({ ...info, meshName });
        toast.success(
          curJob.mode === "between" ? "Connecting tracts found" : "Tract dissection complete",
          { description: `${info.n_selected_streamlines.toLocaleString()} / ${info.n_input_streamlines.toLocaleString()} streamlines` },
        );
      }
    },
  });

  // ── Run dissection ────────────────────────────────────────────────────────
  const runDissection = async () => {
    // Validate before starting so early returns don't leave the button stuck.
    let fileA, fileB, fileToSend;
    if (mode === "between") {
      fileA = getFile(lesionFileA, selLesionIdA);
      fileB = getFile(lesionFileB, selLesionIdB);
      if (!fileA || !fileB) {
        toast.error("Select or upload both lesion masks.");
        return;
      }
    } else {
      fileToSend = getFile(lesionFile, effLesionId);
      if (!fileToSend) {
        toast.error("Select or upload a lesion mask first.");
        return;
      }
    }

    _clearPreviousTract();
    setResult(null);
    setSaved(false);
    setSaveName("");
    overlayIdRef.current = `tract-dissect-${Date.now()}`;
    // Show the indicator immediately (before the /start round-trip returns).
    setJob({ jobId: null, stage: "queued", message: "Queued…", progress: 0, done: false, mode });
    try {
      let job_id;
      if (mode === "between") {
        ({ job_id } = await startBetween(fileA, fileB, {
          nameA: fileA.name, nameB: fileB.name, modeA, modeB, atlas,
        }));
      } else {
        ({ job_id } = await startDissection(fileToSend, { name: fileToSend.name, atlas }));
      }
      setJob({ jobId: job_id, stage: "queued", message: "Queued…", progress: 0, done: false, mode });
    } catch (e) {
      toast.error(mode === "between" ? "Between-dissection failed" : "Dissection failed", {
        description: e?.message,
      });
      setJob(null);
    }
  };

  // Item 103: shared report model + renderer (lib/report/) — the same
  // buildReport("tract", …) call the Tractography card uses for saved tracts
  // (useTracts.js::handleTractReport).
  const reportLesionName = () => (
    mode === "between"
      ? getFile(lesionFileA, selLesionIdA)?.name
      : getFile(lesionFile, effLesionId)?.name
  );
  const reportModel = result ? buildTractReportModel(result, reportLesionName()) : null;
  const handleOpenReport = () => {
    if (!result) return;
    openReport();
  };

  const hasResult = result && result.n_selected_streamlines > 0;
  // Generic per-atlas region counts for the results summary.
  const overlapEntries = Object.entries(result?.atlas_overlap || {})
    .map(([key, rows]) => ({
      key,
      name: ATLAS_KEY_NAMES[key] || key,
      count: rows?.length ?? 0,
    }))
    .filter((e) => e.count > 0);

  const runDisabled =
    busy ||
    available !== true ||
    (mode === "single" && !lesionFile && !effLesionId) ||
    (mode === "between" &&
      ((!lesionFileA && !selLesionIdA) || (!lesionFileB && !selLesionIdB)));

  return (
    <div className="space-y-3" data-testid="tract-dissection-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
        <GitBranch size={11} /> virtual dissection (BCB/TrackVis)
      </div>

      {/* ── Availability notice ── */}
      {available !== null && available !== true && (
        <div className="font-mono text-[10px] text-muted-foreground border border-border px-2 py-2">
          {available?.reason?.toLowerCase().includes("fetch")
            ? "Backend server unavailable — start the backend and reload."
            : available?.tract_file_present === false
              ? "Global tract file not configured on server."
              : (available?.reason || "Tract dissection unavailable.")}
        </div>
      )}

      {(available === null || available === true) && (
        <>
          {/* ── Mode toggle ── */}
          <div className="flex gap-1">
            <button
              onClick={() => { setMode("single"); setResult(null); }}
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] border transition-colors ${activeToggleCls(mode === "single")}`}
              data-testid="tract-mode-single"
            >
              Single Lesion
            </button>
            <button
              onClick={() => { setMode("between"); setResult(null); }}
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] border transition-colors ${activeToggleCls(mode === "between")}`}
              data-testid="tract-mode-between"
            >
              <SplitSquareHorizontal size={10} className="inline mr-1" />
              Between 2
            </button>
          </div>

          {/* ── Single-lesion inputs ── */}
          {mode === "single" && (
            <LesionInput
              file={lesionFile}
              onFile={setLesionFile}
              selId={selLesionId}
              onSelect={setSelLesionId}
              uploadTestId="tract-lesion-upload"
              selectTestId="tract-lesion-select"
              lesionLayers={lesionLayers}
              autoPicked
              onUseDrawing={() => pickDrawing(setLesionFile, setSelLesionId)}
            />
          )}

          {/* ── Between-lesion inputs ── */}
          {mode === "between" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <LesionInput
                  label="Lesion A"
                  file={lesionFileA}
                  onFile={setLesionFileA}
                  selId={selLesionIdA}
                  onSelect={setSelLesionIdA}
                  uploadTestId="tract-lesion-a-upload"
                  selectTestId="tract-lesion-a-select"
                  lesionLayers={lesionLayers}
                  onUseDrawing={() => pickDrawing(setLesionFileA, setSelLesionIdA)}
                />
                <ModeSelect value={modeA} onChange={setModeA} testId="tract-mode-a" />
              </div>
              <div className="space-y-1.5">
                <LesionInput
                  label="Lesion B"
                  file={lesionFileB}
                  onFile={setLesionFileB}
                  selId={selLesionIdB}
                  onSelect={setSelLesionIdB}
                  uploadTestId="tract-lesion-b-upload"
                  selectTestId="tract-lesion-b-select"
                  lesionLayers={lesionLayers}
                  onUseDrawing={() => pickDrawing(setLesionFileB, setSelLesionIdB)}
                />
                <ModeSelect value={modeB} onChange={setModeB} testId="tract-mode-b" />
              </div>
            </div>
          )}

          <AtlasSelect value={atlas} onChange={setAtlas} testId="tract-atlas-select" />

          <button
            onClick={runDissection}
            disabled={runDisabled}
            className={primaryBtnCls}
            data-testid="tract-run-button"
          >
            <GitBranch size={12} />
            {busy
              ? "Running…"
              : mode === "between"
                ? "Find Connecting Tracts"
                : "Run Dissection"}
          </button>
        </>
      )}

      {/* ── Layer controls: hide/show the streamlines, or delete/dismiss this
          result. Gated on `result` alone (not on a nonzero streamline count)
          to match DaLnMapperPanel's parity: LNM always shows its Delete
          button once a compute finishes, even when nothing significant
          survived. Previously this whole row (including Delete) required
          `n_selected_streamlines > 0`, so a real dissection that legitimately
          found zero connecting/passing streamlines (e.g. Between-2 mode with
          two lesions that share no streamlines — reproduced live) left the
          user with no Delete/Save/Hide at all and no way to dismiss the
          "No streamlines" card, which reads as "the buttons are missing".
          Hide only renders when a mesh actually loaded (trkLoaded); Delete
          relabels to "Dismiss" when there's no mesh to remove, since it then
          only clears the result card. Hidden once saved — the Tractography
          section now owns the mesh, so this panel's own control must not
          fight over it. */}
      {result && !saved && (
        <div className="flex items-center justify-end gap-1.5">
          {trkLoaded && (
            <button
              onClick={toggleTrkVisible}
              title={trkVisible ? "Hide tract in 3D view" : "Show tract in 3D view"}
              className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
              data-testid="tract-toggle-visible"
            >
              {trkVisible ? <Eye size={11} /> : <EyeOff size={11} />}
              {trkVisible ? "Hide" : "Show"}
            </button>
          )}
          {trkLoaded && (
            <ToggleButton
              pressed={trkClipOn}
              onPressedChange={toggleTrkClip}
              icon={Scissors}
              label="Clip"
              title="Clip this preview tract to the 3D clip plane (off by default)"
              testId="tract-preview-clip"
            />
          )}
          <button
            onClick={deleteResult}
            title={trkLoaded ? "Remove tract from viewer and clear this result" : "Dismiss this result"}
            className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-red-400 hover:border-red-900"
            data-testid="tract-delete"
          >
            <Trash2 size={11} />{trkLoaded ? "Delete" : "Dismiss"}
          </button>
        </div>
      )}

      {/* ── No-result message ── */}
      {result && result.n_selected_streamlines === 0 && (
        <div className="font-mono text-[10px] text-muted-foreground border border-border px-2 py-2">
          {result.message || "No streamlines satisfy the selection criteria."}
        </div>
      )}

      {/* ── Results ── */}
      {hasResult && (
        <>
          {/* Save Tract → Tractography section (item 58) */}
          {trkLoaded && onSaveTract && (
            <div className="space-y-1.5">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={`name for saved tract… (default: ${deriveDefaultTractName()})`}
                className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
                data-testid="tract-save-name"
              />
              <button
                onClick={saveTract}
                className={primaryBtnCls}
                data-testid="tract-save"
              >
                <Save size={11} />Save Tract
              </button>
            </div>
          )}

          <div className="border border-border bg-panel p-3 space-y-1" data-testid="tract-stats">
            {mode === "between" && (
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground pb-1">
                Connecting streamlines
              </div>
            )}
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Selected streamlines</span>
              <span className="text-foreground">
                {result.n_selected_streamlines.toLocaleString()} / {result.n_input_streamlines.toLocaleString()}
                {" "}
                <span className="text-muted-foreground">
                  ({(100 * result.n_selected_streamlines / result.n_input_streamlines).toFixed(1)}%)
                </span>
              </span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Affected-tract volume</span>
              <span className="text-foreground">{result.tract_volume_cm3.toFixed(3)} cm³</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Affected voxels</span>
              <span className="text-foreground">{result.affected_voxels.toLocaleString()}</span>
            </div>
            {overlapEntries.length > 0 && (
              <div className="pt-1 space-y-0.5" data-testid="tract-atlas-breakdown">
                {overlapEntries.map((e) => (
                  <div key={e.key} className="flex justify-between text-[11px]">
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">{e.name}</span>
                    <span className="text-foreground">{e.count} regions</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {result.files && (
            <div className="grid grid-cols-2 gap-1.5">
              <a
                href={tractResultUrl(result.files.nifti)}
                download
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground no-underline"
                data-testid="tract-download-nifti"
              >
                <Download size={11} />NIfTI
              </a>
              <a
                href={tractResultUrl(result.files.trk)}
                download
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground no-underline"
                data-testid="tract-download-trk"
              >
                <Download size={11} />.trk
              </a>
            </div>
          )}

          <button
            onClick={handleOpenReport}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
            data-testid="tract-export-html"
          >
            <FileCode size={11} />Report
          </button>
          <ReportDialog
            open={reportOpen}
            onOpenChange={setReportOpen}
            title="Tract Disconnection Report"
            subject={reportModel?.lesionName}
            html={reportModel ? buildReport("tract", reportModel) : null}
            filename={`tract_report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`}
          />
        </>
      )}

      {/* Bottom-left running box (item 57) — now a pollable job (SMALL-FIXES
          101), so it shows a real staged progress bar. */}
      <RunningIndicator
        title="Tract Dissection"
        active={busy}
        message={job?.message}
        progress={job?.progress}
        onCancel={handleCancel}
        cancelling={cancelling}
        steps={buildStageSteps(STAGE_STEPS, job)}
      />
    </div>
  );
};

export default TractDissectionPanel;
