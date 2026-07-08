import React, { useState, useEffect } from "react";
import { GitBranch, Download, FileCode, SplitSquareHorizontal, Eye, EyeOff, Trash2 } from "lucide-react";
import FileUploader from "@/components/FileUploader";
import {
  dissectAvailable,
  dissectTract,
  dissectBetween,
  tractResultUrl,
} from "@/lib/tractDissection";
import { generateTractReportHtml } from "@/lib/htmlReport";
import { downloadText } from "@/lib/volumeAnalysis";
import { currentDrawingAsFile } from "@/lib/lesions";
import { toast } from "sonner";

// Atlas driving the region-overlap breakdown. Values match the backend
// _ATLAS_PRESETS keys; result.atlas_overlap is keyed by the per-atlas spec key.
const ATLAS_OPTIONS = [
  { value: "harvard_oxford", label: "Harvard-Oxford (default)" },
  { value: "hcp1065", label: "HCP1065 Named Tracts (87)" },
  { value: "juelich", label: "Jülich (Cortex + WM)" },
];

const ATLAS_KEY_NAMES = {
  ho_cort: "Harvard-Oxford Cortical",
  hcp1065: "HCP1065 Named Tracts",
  juelich: "Jülich",
};

// Cap per-atlas rows in the report for readability.
const MAX_REPORT_ROWS = 25;

function buildTractReportModel(result, lesionName) {
  const overlap = result.atlas_overlap || {};
  const atlasBreakdowns = Object.keys(overlap)
    .map((key) => ({
      atlasName: ATLAS_KEY_NAMES[key] || key,
      rows: (overlap[key] || []).slice(0, MAX_REPORT_ROWS).map((r) => ({
        regionName: r.name,
        hitVoxels: r.hit_voxels,
        regionVoxels: r.region_voxels,
        pctRegion: r.pct_region,
        streamlineDensity: r.streamline_density,
      })),
    }))
    .filter((b) => b.rows.length > 0);

  return {
    lesionName: lesionName || "(unnamed)",
    generatedAt: new Date().toISOString(),
    nInputStreamlines: result.n_input_streamlines,
    nSelectedStreamlines: result.n_selected_streamlines,
    pctSelected: (100 * result.n_selected_streamlines / result.n_input_streamlines).toFixed(1),
    affectedVoxels: result.affected_voxels,
    tractVolumeCm3: result.tract_volume_cm3,
    densityMax: result.density_max,
    atlasBreakdowns,
  };
}

// Module-level so it keeps a stable identity across parent re-renders
// (defining it inside the component would remount the FileUploader/select
// on every keystroke and steal focus). lesionLayers is threaded as a prop.
function LesionInput({ label, file, onFile, selId, onSelect, uploadTestId, selectTestId, lesionLayers = [], onUseDrawing }) {
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">{label}</div>
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
          className="w-full py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
          data-testid={`${uploadTestId}-use-drawing`}
        >
          Use current drawing
        </button>
      )}
      {file && (
        <div className="font-mono text-[10px] text-zinc-400 truncate">{file.name}</div>
      )}
      {lesionLayers.length > 0 && (
        <select
          value={selId}
          onChange={(e) => { onSelect(e.target.value); onFile(null); }}
          className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
          data-testid={selectTestId}
        >
          <option value="">— or pick loaded lesion —</option>
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
      className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
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
  return (
    <div className="space-y-1">
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">
        Region atlas
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
        data-testid={testId}
      >
        {ATLAS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

export const TractDissectionPanel = ({
  viewerRef,
  lesionLayers = [],
  userFileCache,
}) => {
  // ── Mode ─────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState("single"); // "single" | "between"
  const [atlas, setAtlas] = useState("harvard_oxford"); // region-breakdown atlas

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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  // Stable base id for this panel mount; the TRK mesh name derives from it.
  const [overlayId] = useState(() => `tract-dissect-${Date.now()}`);
  const [trkLoaded, setTrkLoaded] = useState(false);
  const [trkVisible, setTrkVisible] = useState(true);
  const [available, setAvailable] = useState(null);

  useEffect(() => {
    dissectAvailable().then((info) => setAvailable(info?.ok ? true : (info || false)));
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getFile = (file, selId) =>
    file || (selId ? userFileCache?.current?.[selId]?.file : null);

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

  const trkMeshName = `${overlayId}_trk`;

  // addMeshFromUrl is idempotent on name (returns the cached mesh if the name
  // is already loaded), so the old mesh MUST be removed before re-running.
  const _clearPreviousTract = () => {
    if (trkLoaded) {
      viewerRef.current?.removeMesh?.(trkMeshName);
      setTrkLoaded(false);
    }
  };

  // Toggle the dissected-tract mesh visibility in the 3D view (opacity 0/1);
  // keeps the result card + downloads intact.
  const toggleTrkVisible = () => {
    const next = !trkVisible;
    viewerRef.current?.setMeshOpacity?.(trkMeshName, next ? 1.0 : 0);
    setTrkVisible(next);
  };

  // Remove the tract mesh from the viewer AND dismiss the result card.
  const deleteResult = () => {
    _clearPreviousTract();
    setTrkVisible(true);
    setResult(null);
  };

  const _loadResults = async (info) => {
    if (!info.files) return;
    // Load the dissected .trk as colorful direction-encoded (DTI RGB)
    // streamlines — the dissected subset then looks like the colorful global
    // tractogram. The red "hot" density NIfTI is NOT shown in the viewer; it
    // stays available only as a download link below.
    const trkUrl = tractResultUrl(info.files.trk);
    const mesh = await viewerRef.current?.addMeshFromUrl?.(trkUrl, {
      colorByDirection: true,   // DTI RGB: each segment colored by its direction vector
      name: trkMeshName,
      opacity: 1.0,
    });
    if (mesh) {
      setTrkLoaded(true);
      setTrkVisible(true);
    }
  };

  // ── Run dissection ────────────────────────────────────────────────────────
  const runDissection = async () => {
    // Validate before setBusy so early returns don't leave the button stuck.
    let fileA, fileB, fileToSend;
    if (mode === "between") {
      fileA = getFile(lesionFileA, selLesionIdA);
      fileB = getFile(lesionFileB, selLesionIdB);
      if (!fileA || !fileB) {
        toast.error("Select or upload both lesion masks.");
        return;
      }
    } else {
      fileToSend = getFile(lesionFile, selLesionId);
      if (!fileToSend) {
        toast.error("Select or upload a lesion mask first.");
        return;
      }
    }

    _clearPreviousTract();
    setBusy(true);
    setResult(null);
    try {
      let info;
      if (mode === "between") {
        info = await dissectBetween(fileA, fileB, {
          nameA: fileA.name,
          nameB: fileB.name,
          modeA,
          modeB,
          atlas,
        });
      } else {
        info = await dissectTract(fileToSend, { name: fileToSend.name, atlas });
      }

      setResult(info);

      if (info.n_selected_streamlines === 0) {
        toast.info("No streamlines", {
          description: info.message || "No streamlines satisfy the selection criteria.",
        });
        return;
      }

      await _loadResults(info);
      toast.success(
        mode === "between" ? "Connecting tracts found" : "Tract dissection complete",
        {
          description: `${info.n_selected_streamlines.toLocaleString()} / ${info.n_input_streamlines.toLocaleString()} streamlines`,
        }
      );
    } catch (e) {
      toast.error(mode === "between" ? "Between-dissection failed" : "Dissection failed", {
        description: e?.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const exportHtml = () => {
    if (!result) return;
    const file =
      mode === "between"
        ? getFile(lesionFileA, selLesionIdA)
        : getFile(lesionFile, selLesionId);
    const model = buildTractReportModel(result, file?.name);
    const html = generateTractReportHtml(model);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`tract_report_${ts}.html`, html, "text/html");
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
    (mode === "single" && !lesionFile && !selLesionId) ||
    (mode === "between" &&
      ((!lesionFileA && !selLesionIdA) || (!lesionFileB && !selLesionIdB)));

  return (
    <div className="space-y-3" data-testid="tract-dissection-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
        <GitBranch size={11} /> virtual dissection (BCB/TrackVis)
      </div>

      {/* ── Availability notice ── */}
      {available !== null && available !== true && (
        <div className="font-mono text-[10px] text-zinc-500 border border-[#27272A] px-2 py-2">
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
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] border transition-colors ${
                mode === "single"
                  ? "bg-white text-black border-white"
                  : "bg-transparent text-zinc-400 border-[#27272A] hover:text-zinc-200"
              }`}
              data-testid="tract-mode-single"
            >
              Single Lesion
            </button>
            <button
              onClick={() => { setMode("between"); setResult(null); }}
              className={`flex-1 py-1.5 text-[10px] uppercase tracking-[0.15em] border transition-colors ${
                mode === "between"
                  ? "bg-white text-black border-white"
                  : "bg-transparent text-zinc-400 border-[#27272A] hover:text-zinc-200"
              }`}
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
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
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

      {/* ── No-result message ── */}
      {result && result.n_selected_streamlines === 0 && (
        <div className="font-mono text-[10px] text-zinc-500 border border-[#27272A] px-2 py-2">
          {result.message || "No streamlines satisfy the selection criteria."}
        </div>
      )}

      {/* ── Results ── */}
      {hasResult && (
        <>
          {/* Layer controls: hide/show the streamlines, or delete this result */}
          <div className="flex items-center justify-end gap-1.5">
            {trkLoaded && (
              <button
                onClick={toggleTrkVisible}
                title={trkVisible ? "Hide tract in 3D view" : "Show tract in 3D view"}
                className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="tract-toggle-visible"
              >
                {trkVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                {trkVisible ? "Hide" : "Show"}
              </button>
            )}
            <button
              onClick={deleteResult}
              title="Remove tract from viewer and clear this result"
              className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-zinc-400 border-[#27272A] hover:text-red-400 hover:border-red-900"
              data-testid="tract-delete"
            >
              <Trash2 size={11} />Delete
            </button>
          </div>
          <div className="border border-[#27272A] bg-[#0a0a0a] p-3 space-y-1" data-testid="tract-stats">
            {mode === "between" && (
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500 pb-1">
                Connecting streamlines
              </div>
            )}
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Selected streamlines</span>
              <span className="text-zinc-200">
                {result.n_selected_streamlines.toLocaleString()} / {result.n_input_streamlines.toLocaleString()}
                {" "}
                <span className="text-zinc-500">
                  ({(100 * result.n_selected_streamlines / result.n_input_streamlines).toFixed(1)}%)
                </span>
              </span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Affected-tract volume</span>
              <span className="text-zinc-200">{result.tract_volume_cm3.toFixed(3)} cm³</span>
            </div>
            <div className="flex justify-between text-[11px]">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">Affected voxels</span>
              <span className="text-zinc-200">{result.affected_voxels.toLocaleString()}</span>
            </div>
            {overlapEntries.length > 0 && (
              <div className="pt-1 space-y-0.5" data-testid="tract-atlas-breakdown">
                {overlapEntries.map((e) => (
                  <div key={e.key} className="flex justify-between text-[11px]">
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">{e.name}</span>
                    <span className="text-zinc-200">{e.count} regions</span>
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
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500 no-underline"
                data-testid="tract-download-nifti"
              >
                <Download size={11} />NIfTI
              </a>
              <a
                href={tractResultUrl(result.files.trk)}
                download
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500 no-underline"
                data-testid="tract-download-trk"
              >
                <Download size={11} />.trk
              </a>
            </div>
          )}

          <button
            onClick={exportHtml}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
            data-testid="tract-export-html"
          >
            <FileCode size={11} />HTML Report
          </button>
        </>
      )}
    </div>
  );
};

export default TractDissectionPanel;
