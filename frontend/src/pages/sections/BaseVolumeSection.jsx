import React from "react";
import { Image as ImageIcon, Download, RotateCcw } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import FileUploader from "@/components/FileUploader";
import { Switch } from "@/components/ui/switch";
import { BASE_VOLUME, NO_BASE } from "@/lib/atlasConfig";
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
  baseLabel,
  baseVisible,
  baseOpacity,
  baseColormap,
  baseColormapInvert,
  baseFullPath,
  baseOverlayMeta,
  baseColorbarOn,
  histograms,
  requestHistogram,
  handleBaseVisibilityToggle,
  handleBaseOpacity,
  handleBaseColormap,
  handleBaseColormapInvert,
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
  templateMissing,
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
  // keeping the identity/primary-control layout item 119 established; the
  // colorbar toggle is the shared Switch.
  const baseVolumeControls = (
    <div className="space-y-2 px-0.5 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className="flex-1">Window</span>
        <button
          onClick={handleBaseFullWindow}
          className="btn-mini"
          data-testid="base-window-full"
          title="Full intensity range"
        >Full</button>
        <button
          onClick={handleBaseAutoWindow}
          className="btn-mini"
          data-testid="base-window-auto"
          title="Auto-contrast (robust 2–98% window)"
        >Auto</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1">Colour bar in the viewer</span>
        <Switch
          checked={!!baseColorbarOn}
          onCheckedChange={(v) => handleBaseColorbarToggle(null, v)}
          label="Colour bar in the viewer"
          testId="toggle-base-colorbar"
        />
      </div>
    </div>
  );

  return (
    <SidebarSection title="Base volume" icon={ImageIcon} testId="section-base" defaultOpen={true} summary={baseLabel}>
      <LayerControlAdvanced
        layer={{ id: "mni152", name: baseLabel, description: baseLabel === NO_BASE.name ? NO_BASE.description : BASE_VOLUME.description, fullPath: baseFullPath }}
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
        colormapInverted={baseColormapInvert}
        onColormapInvertChange={handleBaseColormapInvert}
        onCalRangeChange={handleBaseCalRange}
        thresholdLabel="Window"
        histogram={histograms.mni152}
        onRequestHistogram={requestHistogram}
        notes={layerNotes?.mni152}
        onNotesChange={onNotesChange}
      />
      {baseVolumeControls}
      <FileUploader
        label="Use a custom base image"
        description=".nii .nii.gz .mgz · replaces MNI152"
        testId="upload-base-button"
        onFile={handleBaseUpload}
      />
      <FileUploader
        label="Import a DICOM series"
        description="A folder of .dcm files, or a .zip · converted by dcm2niix"
        testId="upload-dicom-button"
        directory
        accept=".dcm,.ima,.zip"
        onFiles={handleDicomImport}
      />

      {/* DICOM staged progress bar */}
      {dicomProgress && (
        <div className="space-y-1" data-testid="dicom-progress">
          <div className="flex justify-between cap text-subtle">
            <span>
              {dicomProgress.stage === "upload" ? "Uploading" :
                dicomProgress.stage === "convert" ? "Converting (dcm2niix)" : "Loading series"}
            </span>
            {dicomProgress.stage === "upload" && (
              <span>{Math.round(dicomProgress.fraction * 100)}%</span>
            )}
          </div>
          <div className="h-1 w-full overflow-hidden rounded-sm bg-panel-active">
            <div
              className={`h-full bg-foreground transition-all ${dicomProgress.stage !== "upload" ? "animate-pulse" : ""}`}
              style={{ width: dicomProgress.stage === "upload" ? `${dicomProgress.fraction * 100}%` : "100%" }}
            />
          </div>
        </div>
      )}

      {/* DICOM series picker (multi-series studies) */}
      {dicomJob && (
        <div className="space-y-1.5 rounded-lg border border-border bg-card p-2.5" data-testid="dicom-series-picker">
          <div className="cap text-subtle">
            {dicomJob.series.length} series — pick one
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {dicomJob.series.map((s) => (
              <button
                key={s.id}
                onClick={() => loadDicomSeries(dicomJob.jobId, s)}
                className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-panel-hover ${
                  s.id === loadedSeriesId
                    ? "border-edge bg-panel-active text-foreground"
                    : "border-border bg-transparent text-foreground"
                }`}
                data-testid={`dicom-series-${s.id}`}
              >
                <div className="text-[12px] truncate">
                  {s.id === loadedSeriesId && <span className="text-ok">✓ </span>}
                  {s.description || s.id}
                </div>
                <div className="font-mono text-[10.5px] text-subtle">
                  {s.dims ? s.dims.join("×") : "?"} · {s.n_slices ?? "?"} slices · {(s.bytes / 1e6).toFixed(1)} MB
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={() => { setDicomJob(null); setLoadedSeriesId(null); }}
            className="btn-ghost w-full"
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
          className="btn flex w-full"
          data-testid="download-dicom-nifti"
        >
          <Download size={13} /> {dicomSaving ? "Preparing…" : "Download NIfTI"}
        </button>
      )}
      {/* Not offered without the template: reinstalling it loads it anyway. */}
      {baseLabel !== BASE_VOLUME.name && !templateMissing && (
        <button
          onClick={handleResetBase}
          className="btn flex w-full"
          data-testid="reset-base-button"
        >
          <RotateCcw size={12} />Reset to the MNI template
        </button>
      )}
    </SidebarSection>
  );
}

export default BaseVolumeSection;
