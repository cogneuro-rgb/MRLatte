// Lesion-drawing quality check orchestration — the owner's idea-inbox
// request: before Save/Download (and, in the background, after idle time
// while drawing), upload the current drawing and ask lqtpy.qc for issues
// (sparse slices, flat/single-slice, hollow outline, tiny specks, outside-
// brain, header problems — see backend/lesion_metrics.py::run_qc).
//
// Fails OPEN on every axis: lqtpy absent, lqtpy present but predating the qc
// module (503 — see qc_available in GET /api/lesion/capabilities), the
// backend unreachable, a slow response past `timeoutMs`, or any other error
// all resolve to `null`. Callers MUST treat null as "QC has nothing to say
// right now" and proceed exactly as if this module didn't exist — QC must
// never be the reason a user can't save or download their work.
import { getCapabilities, uploadLesion, fetchQc } from "@/lib/lesionMetrics";
import { currentDrawingAsFile } from "@/lib/lesions";

// A few seconds — long enough for a normal QC pass, short enough that a slow
// or hung backend can never make Save/Download feel stuck.
export const LESION_QC_TIMEOUT_MS = 4000;

/**
 * @param {{viewerRef?: object, file?: File, mni: boolean, fileName?: string, timeoutMs?: number}} args
 *   Pass `file` when the caller already serialised the drawing (Save/Download
 *   already need `currentDrawingAsFile` for their own purposes — reuse it
 *   rather than re-encoding the bitmap a second time). Pass `viewerRef`
 *   instead when nothing else needed the file yet (the idle checker).
 * @returns {Promise<{flags: object[], provenance: object, lesionId: string}|null>}
 *   `null` means "fail open" — see module doc.
 */
export async function runLesionQc({
  viewerRef, file, mni, fileName = "qc_drawing.nii.gz", timeoutMs = LESION_QC_TIMEOUT_MS,
} = {}) {
  try {
    const caps = await getCapabilities();
    if (!caps?.available || !caps?.qc_available) return null;

    const drawingFile = file || await currentDrawingAsFile(viewerRef, fileName);
    if (!drawingFile) return null; // empty drawing — nothing to check

    // Content-hash deduped (see uploadLesion) — re-checking an unchanged
    // drawing never re-uploads.
    const lesionId = await uploadLesion(drawingFile);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetchQc({ lesionId, mni, signal: controller.signal });
      return { ...result, lesionId };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // lqtpy absent/older (503), a network failure, an abort (timeout), or
    // any other error — all fail open. See module doc.
    return null;
  }
}
