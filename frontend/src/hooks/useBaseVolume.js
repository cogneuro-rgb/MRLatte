import { useCallback, useRef, useState } from "react";
import { dicomSourceOf } from "@/lib/dicomSource";
import { toast } from "sonner";
import { BASE_VOLUME } from "@/lib/atlasConfig";
import { convertDicom, fetchDicomSeriesFile } from "@/lib/dicom";

/**
 * Base volume upload / reset, DICOM import, and base-window/colormap/opacity
 * controls. Extracted from Dashboard.jsx; behaviour is unchanged — this is a
 * relocation, not a redesign. Call sites elsewhere in Dashboard keep the
 * exact same handler names via destructuring.
 *
 * @param {object} deps
 * @param {React.MutableRefObject} deps.viewerRef
 * @param {boolean} deps.baseVisible
 * @param {(v: string) => void} deps.setBaseLabel
 * @param {(v: boolean) => void} deps.setBaseVisible
 * @param {(v: number) => void} deps.setBaseOpacity
 * @param {(v: string) => void} deps.setBaseColormap
 * @param {(v: boolean) => void} deps.setBaseColorbarOn
 * @param {(updater: any) => void} deps.setBaseOverlayMeta
 * @param {(v: any) => void} deps.setDicomJob
 * @param {(v: any) => void} deps.setDicomProgress
 * @param {(v: any) => void} deps.setDicomDownload
 * @param {(v: any) => void} deps.setLoadedSeriesId
 * @param {(v: string|null) => void} deps.setBaseFullPath
 */
export function useBaseVolume({
  viewerRef,
  baseVisible,
  setBaseLabel,
  setBaseVisible,
  setBaseOpacity,
  setBaseColormap,
  setBaseColorbarOn,
  setBaseOverlayMeta,
  setDicomJob,
  setDicomProgress,
  setDicomDownload,
  setLoadedSeriesId,
  setBaseFullPath,
}) {
  // ===== Base volume upload / reset =====
  // A large 4D file (or any large volume) can take a visible moment to
  // decompress + parse — baseLoading drives an indeterminate spinner (no
  // real byte-progress is available from niivue's loader) so the canvas
  // doesn't just sit there looking stuck.
  const [baseLoading, setBaseLoading] = useState(false);
  // Where a DICOM-converted base came from ({ type: "folder"|"zip", path,
  // seriesId, description }), so a workspace saved with links can convert it
  // again instead of carrying the converted volume. Null for any other base.
  const [baseDicom, setBaseDicom] = useState(null);
  const dicomSourceRef = useRef(null);
  // opts.fullPath: where the file is on disk when the File itself can't say
  // (a file rebuilt from bytes — e.g. reopened from a workspace link).
  const handleBaseUpload = async (file, opts = {}) => {
    setBaseLoading(true);
    try {
      const ok = await viewerRef.current?.replaceBaseVolume(file);
      if (ok) {
        setBaseDicom(null);
        setBaseLabel(file.name);
        setBaseFullPath(opts.fullPath || window.mrlatte?.getPathForFile?.(file) || null);
        setDicomDownload(null);
        refreshBaseOverlayMeta();
      }
    } finally {
      setBaseLoading(false);
    }
  };

  // Same post-load bookkeeping as handleBaseUpload, for when the base volume
  // was already loaded some OTHER way (quick-open's initial NiivueViewer
  // mount passes the double-clicked file straight in as its first load, to
  // avoid fetching+rendering MNI152 first just to immediately replace it —
  // so there's nothing to call replaceBaseVolume with here).
  const markBaseLoadedExternally = (name, fullPath) => {
    setBaseDicom(null);
    setBaseLabel(name);
    setBaseFullPath(fullPath || null);
    setDicomDownload(null);
    refreshBaseOverlayMeta();
  };

  // opts.source: where these DICOM files came from, when the Files can't say
  // (reread from a workspace link); opts.seriesId: load that series straight
  // away (reopening a workspace) instead of offering the list.
  const handleDicomImport = async (fileArr, opts = {}) => {
    if (!fileArr?.length) return;
    dicomSourceRef.current = opts.source || dicomSourceOf(fileArr);
    setDicomJob(null);
    setDicomDownload(null);
    setDicomProgress({ stage: "upload", fraction: 0 });
    try {
      const res = await convertDicom(fileArr, (f) =>
        setDicomProgress({ stage: "upload", fraction: f }),
      );
      // Upload done — dcm2niix runs server-side (indeterminate).
      setDicomProgress({ stage: "convert", fraction: 1 });
      const series = res?.series || [];
      if (series.length === 0) {
        setDicomProgress(null);
        toast.error("No series produced from these DICOM files.");
        return;
      }
      setDicomProgress(null);
      const wanted = opts.seriesId != null ? series.find((x) => String(x.id) === String(opts.seriesId)) : null;
      if (wanted || series.length === 1) {
        // The series a workspace asked for, or the only one — load it now.
        await loadDicomSeries(res.job_id, wanted || series[0]);
      } else {
        setLoadedSeriesId(null);
        setDicomJob({ jobId: res.job_id, series });
        toast.info(`${series.length} series found`, { description: "Pick one to load." });
      }
    } catch (e) {
      setDicomProgress(null);
      toast.error("DICOM import failed", { description: e?.message });
    }
  };

  const loadDicomSeries = async (jobId, s) => {
    setDicomProgress({ stage: "load", fraction: 1 });
    try {
      const niftiFile = await fetchDicomSeriesFile(jobId, s.id);
      const ok = await viewerRef.current?.replaceBaseVolume(niftiFile);
      if (ok) {
        setBaseLabel(`DICOM · ${s.description || s.id}`);
        setBaseFullPath(null); // server-converted NIfTI, no local source path
        setBaseDicom(dicomSourceRef.current ? { ...dicomSourceRef.current, seriesId: s.id, description: s.description || null } : null);
        setLoadedSeriesId(s.id);
        setDicomDownload({ jobId, seriesId: s.id, name: s.description || s.id });
        refreshBaseOverlayMeta();
      }
      // Keep the series picker open so the user can load another series from the
      // same study (jobId stays valid server-side). The Cancel button dismisses it.
      toast.success("DICOM series loaded", { description: s.description || s.id });
    } catch (e) {
      toast.error("Failed to load series", { description: e?.message });
    } finally {
      setDicomProgress(null);
    }
  };

  const handleResetBase = async () => {
    const ok = await viewerRef.current?.resetToBase(BASE_VOLUME);
    if (ok) {
      setBaseDicom(null);
      setBaseLabel(BASE_VOLUME.name);
      setBaseFullPath(null);
      setBaseVisible(true);
      setDicomDownload(null);
      toast.success("MNI152 template restored");
    }
  };

  const handleBaseVisibilityToggle = () => {
    const next = !baseVisible;
    setBaseVisible(next);
    viewerRef.current?.setBaseVisible(next);
  };
  const handleBaseOpacity = (_, v) => {
    setBaseOpacity(v);
    viewerRef.current?.setBaseOpacity(v);
  };
  const handleBaseColormap = (_, cm) => {
    setBaseColormap(cm);
    viewerRef.current?.setBaseColormap(cm);
  };
  const handleBaseCalRange = (_, lo, hi) => {
    viewerRef.current?.setBaseWindow(lo, hi);
    setBaseOverlayMeta((p) => ({ ...p, cal_min: lo, cal_max: hi }));
  };
  const handleBaseColorbarToggle = (_, on) => {
    setBaseColorbarOn(on);
    viewerRef.current?.setBaseColorbarVisible(on);
  };
  const refreshBaseOverlayMeta = useCallback(() => {
    setTimeout(() => {
      const range = viewerRef.current?.getBaseRange();
      if (range) setBaseOverlayMeta(range);
    }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    handleBaseUpload,
    baseLoading,
    markBaseLoadedExternally,
    handleDicomImport,
    loadDicomSeries,
    handleResetBase,
    baseDicom,
    handleBaseVisibilityToggle,
    handleBaseOpacity,
    handleBaseColormap,
    handleBaseCalRange,
    handleBaseColorbarToggle,
    refreshBaseOverlayMeta,
  };
}
