import React from "react";
import { Image as ImageIcon, Download, RotateCcw } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import FileUploader from "@/components/FileUploader";
import { ToggleButton } from "@/components/ui/toggle-button";
import { BASE_VOLUME } from "@/lib/atlasConfig";
import { dicomSeriesDownloadUrl } from "@/lib/dicom";
import { saveBinaryFile } from "@/lib/workspace";
import { toast } from "sonner";

/**
 * Base Volume sidebar section: the base scan's layer controls (visibility,
 * opacity, colormap, window), custom base image upload, DICOM series import
 * with staged progress + series picker, NIfTI download, and reset-to-template.
 *
 * Extracted from Dashboard.jsx; behaviour and markup are unchanged — this is
 * a relocation, not a redesign.
 */
export function BaseVolumeSection({
  viewerReady,
  baseLabel,
  baseVisible,
  baseOpacity,
  baseColormap,
  baseFullPath,
  baseOverlayMeta,
  baseColorbarOn,
  histograms,
  requestHistogram,
  handleBaseVisibilityToggle,
  handleBaseOpacity,
  handleBaseColormap,
  handleBaseCalRange,
  handleBaseFullWindow,
  handleBaseAutoWindow,
  handleBaseColorbarToggle,
  handleBaseUpload,
  handleDicomImport,
  dicomProgress,
  dicomJob,
  setDicomJob,
  loadedSeriesId,
  setLoadedSeriesId,
  loadDicomSeries,
  dicomDownload,
  handleResetBase,
  layerNotes,
  onNotesChange,
}) {
  // Fetch-then-save, rather than the plain <a download> this used to be. Every
  // other .nii.gz the app writes out goes through saveBinaryFile, which opens a
  // native Save-As dialog on the desktop build; the anchor silently dropped the
  // file into the OS Downloads folder instead, so this one export behaved
  // unlike all the others and gave no chance to name it or pick a location.
  const [dicomSaving, setDicomSaving] = React.useState(false);
  const handleDicomNiftiDownload = async () => {
    if (!dicomDownload || dicomSaving) return;
    setDicomSaving(true);
    try {
      const url = dicomSeriesDownloadUrl(dicomDownload.jobId, dicomDownload.seriesId);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const r = await saveBinaryFile(`${dicomDownload.seriesId}.nii.gz`, "application/gzip", buf);
      if (!r.canceled) toast.success("NIfTI saved", { description: r.filePath });
    } catch (e) {
      toast.error("Download failed", { description: e?.message });
    } finally {
      setDicomSaving(false);
    }
  };

  // Base-volume-specific primary controls (window presets, colorbar). These
  // used to always be visible below the card; item 119 briefly moved them
  // into LayerControlAdvanced's collapsible `extra` slot, which hid them
  // behind the expand chevron. Restored to always-visible here, rendered as
  // a sibling block right under the card rather than inside `extra`, while
  // keeping the identity/primary-control layout item 119 established and the
  // shared ToggleButton component for the colorbar toggle.
  const baseVolumeControls = (
    <div className="border border-t-0 border-border bg-panel px-3 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">window</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleBaseFullWindow}
            className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1.5 py-0.5 transition-colors"
            data-testid="base-window-full"
            title="Full intensity range"
          >full</button>
          <button
            onClick={handleBaseAutoWindow}
            className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1.5 py-0.5 transition-colors"
            data-testid="base-window-auto"
            title="Auto-contrast (robust 2–98% window)"
          >auto</button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">colorbar</span>
        <ToggleButton
          pressed={baseColorbarOn}
          onPressedChange={(v) => handleBaseColorbarToggle(null, v)}
          label={baseColorbarOn ? "on" : "off"}
          testId="toggle-base-colorbar"
        />
      </div>
    </div>
  );

  return (
    <SidebarSection title="Base Volume" icon={ImageIcon} testId="section-base" defaultOpen={true}>
      <div className="flex items-center justify-end px-1 pb-1">
        <div className={`h-1.5 w-1.5 rounded-full ${viewerReady ? "bg-emerald-500" : "bg-amber-500"}`} title={viewerReady ? "WebGL ready" : "Loading"} />
      </div>
      <LayerControlAdvanced
        layer={{ id: "mni152", name: baseLabel, description: BASE_VOLUME.description, fullPath: baseFullPath }}
        visible={baseVisible}
        opacity={baseOpacity}
        colormap={baseColormap}
        globalMin={baseOverlayMeta.global_min}
        globalMax={baseOverlayMeta.global_max}
        calMin={baseOverlayMeta.cal_min}
        calMax={baseOverlayMeta.cal_max}
        hasZeroVoxels={false}
        showColormap
        onToggle={handleBaseVisibilityToggle}
        onOpacityChange={handleBaseOpacity}
        onColormapChange={handleBaseColormap}
        onCalRangeChange={handleBaseCalRange}
        histogram={histograms.mni152}
        onRequestHistogram={requestHistogram}
        notes={layerNotes?.mni152}
        onNotesChange={onNotesChange}
      />
      {baseVolumeControls}
      <FileUploader
        label="Use Custom Base Image"
        description=".nii / .nii.gz / .mgz — replaces MNI152"
        testId="upload-base-button"
        onFile={handleBaseUpload}
      />
      <FileUploader
        label="Import DICOM Series"
        description="select a folder of .dcm files (or a .zip) — server-side dcm2niix"
        testId="upload-dicom-button"
        directory
        accept=".dcm,.ima,.zip"
        onFiles={handleDicomImport}
      />

      {/* DICOM staged progress bar */}
      {dicomProgress && (
        <div className="space-y-1" data-testid="dicom-progress">
          <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            <span>
              {dicomProgress.stage === "upload" ? "Uploading" :
                dicomProgress.stage === "convert" ? "Converting (dcm2niix)" : "Loading series"}
            </span>
            {dicomProgress.stage === "upload" && (
              <span>{Math.round(dicomProgress.fraction * 100)}%</span>
            )}
          </div>
          <div className="h-1 w-full bg-border overflow-hidden">
            <div
              className={`h-full bg-foreground transition-all ${dicomProgress.stage !== "upload" ? "animate-pulse" : ""}`}
              style={{ width: dicomProgress.stage === "upload" ? `${dicomProgress.fraction * 100}%` : "100%" }}
            />
          </div>
        </div>
      )}

      {/* DICOM series picker (multi-series studies) */}
      {dicomJob && (
        <div className="space-y-1.5 border border-border p-2" data-testid="dicom-series-picker">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            {dicomJob.series.length} series — pick one
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {dicomJob.series.map((s) => (
              <button
                key={s.id}
                onClick={() => loadDicomSeries(dicomJob.jobId, s)}
                className={`w-full text-left px-2 py-1.5 border hover:border-muted-foreground hover:text-foreground ${
                  s.id === loadedSeriesId
                    ? "bg-emerald-500/10 border-emerald-700 text-foreground"
                    : "bg-transparent border-border text-foreground"
                }`}
                data-testid={`dicom-series-${s.id}`}
              >
                <div className="text-[11px] truncate">
                  {s.id === loadedSeriesId && <span className="text-emerald-500">✓ </span>}
                  {s.description || s.id}
                </div>
                <div className="font-mono text-[9px] text-subtle">
                  {s.dims ? s.dims.join("×") : "?"} · {s.n_slices ?? "?"} slices · {(s.bytes / 1e6).toFixed(1)} MB
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={() => { setDicomJob(null); setLoadedSeriesId(null); }}
            className="w-full py-1 text-[9px] uppercase tracking-[0.15em] border bg-transparent text-muted-foreground border-border hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Download the currently-loaded DICOM series as NIfTI */}
      {dicomDownload && (
        <button
          type="button"
          onClick={handleDicomNiftiDownload}
          disabled={dicomSaving}
          title={`Download “${dicomDownload.name}” as NIfTI (.nii.gz)`}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 mt-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground disabled:opacity-50"
          data-testid="download-dicom-nifti"
        >
          <Download size={13} /> {dicomSaving ? "Preparing…" : "Download NIfTI"}
        </button>
      )}
      {baseLabel !== BASE_VOLUME.name && (
        <button
          onClick={handleResetBase}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 mt-1.5 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
          data-testid="reset-base-button"
        >
          <RotateCcw size={12} />Reset to MNI Template
        </button>
      )}
    </SidebarSection>
  );
}

export default BaseVolumeSection;
