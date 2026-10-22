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
import { getCapabilities, uploadLesion, fetchQc, fetchQcFix } from "@/lib/lesionMetrics";
import { currentDrawingAsFile } from "@/lib/lesions";

// A few seconds — long enough for a normal QC pass, short enough that a slow
// or hung backend can never make Save/Download feel stuck.
export const LESION_QC_TIMEOUT_MS = 4000;
// Extra allowance for what has to happen BEFORE the check can be asked for:
// the capabilities probe and the upload. Generous on purpose. The first check
// after the backend starts has to import lqtpy, which alone can take longer
// than the whole check does afterwards; a tight limit here was tried and made
// that first Save skip the check entirely. This only has to stop a HUNG
// backend from holding Save open for ever.
export const LESION_QC_SETUP_TIMEOUT_MS = 12000;

// Findings MRLatte never shows. `values` (lqtpy 0.6.0) reports a mask whose
// voxels aren't all 0/1 — but in MRLatte the pen value IS the pen colour, so a
// perfectly good drawing made with pen 2, or with two colours, would be
// reported on every save. lqtpy is also told so (`labels_are_colours` below)
// and then doesn't raise it at all; this filter is the belt to that braces.
const IGNORED_FLAG_IDS = new Set(["values"]);

/**
 * Whether a QC result should interrupt the user. Notes (`severity: "info"`)
 * are shown alongside real findings but never stop a Save or raise the idle
 * warning on their own: from lqtpy 0.6.0 a clean drawing can carry a Note, and
 * a prompt on every clean save teaches people to click through it.
 */
export const needsAttention = (flags) => (flags || []).some((f) => f.severity !== "info");

// Findings MRLatte will fix with one click: lqtpy's fix only REMOVES voxels it
// is sure don't belong for these. Its fixes that ADD voxels (gaps, holes,
// unfilled outlines) stay manual: they add lesion nobody drew.
// Mirrors QC_FIX_IDS in backend/lesion_metrics.py.
export const AUTO_FIX_IDS = new Set(["specks", "strokes", "edge_artifact", "outside_brain"]);
// lqtpy marks a finding it can repair with a `fix` hint (0.6.0+).
export const canAutoFix = (f) => AUTO_FIX_IDS.has(f?.id) && f?.fix != null;

/**
 * Apply lqtpy's fix for one finding to the CURRENT drawing, as one undoable
 * edit. `lesionId` is the upload the finding came from, so the removal mask is
 * on that drawing's grid. Unlike runLesionQc this does not fail open: the user
 * asked for it, so errors are thrown for the caller to show.
 * @returns {Promise<number>} voxels actually removed from the drawing
 */
export async function applyQcFix({ viewerRef, lesionId, findingId }) {
  const context = { labels_are_colours: true, ...(viewerRef?.current?.getDrawingContext?.() || {}) };
  const res = await fetchQcFix({ lesionId, findingIds: [findingId], context });
  if (!res.voxels_removed) return 0;
  const bytes = Uint8Array.from(atob(res.removed_mask), (c) => c.charCodeAt(0));
  const file = new File([bytes], "qc_fix_removed.nii.gz", { type: "application/gzip" });
  const removed = await viewerRef?.current?.removeVoxelsFromMask?.(file);
  if (removed == null) throw new Error("The drawing could not take the fix (has the base scan changed?).");
  return removed;
}

/**
 * @param {{viewerRef?: object, file?: File, mni: boolean, fileName?: string, timeoutMs?: number}} args
 *   Pass `file` when the caller already serialised the drawing (Save/Download
 *   already need `currentDrawingAsFile` for their own purposes — reuse it
 *   rather than re-encoding the bitmap a second time). Pass `viewerRef`
 *   instead when nothing else needed the file yet (the idle checker).
 * @returns {Promise<{flags: object[], needsAttention: boolean, verdict: string|null, score: number|null, provenance: object, lesionId: string}|null>}
 *   `verdict` / `score` are lqtpy 0.6.0's summary of the whole mask; null on older lqtpy.
 *   `null` means "fail open" — see module doc.
 */
export function runLesionQc(args = {}) {
  // An overall deadline, on top of the limit the check request has itself: the
  // capabilities probe and the upload come first and used to run with no limit
  // at all, so a hung backend could hold Save open for as long as the browser
  // cared to wait. Past the deadline the answer is null: fail open, like every
  // other way this can go wrong.
  const timeoutMs = (args.timeoutMs ?? LESION_QC_TIMEOUT_MS) + (args.setupTimeoutMs ?? LESION_QC_SETUP_TIMEOUT_MS);
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  return Promise.race([runLesionQcUnbounded(args), deadline]).finally(() => clearTimeout(timer));
}

async function runLesionQcUnbounded({
  viewerRef, file, mni, tier, fileName = "qc_drawing.nii.gz", timeoutMs = LESION_QC_TIMEOUT_MS,
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
      // What the drawing tool knows that the saved mask doesn't show (which
      // plane it was drawn on): lqtpy 0.6.0 uses it to tell a stray stroke
      // from the drawing plane itself. Absent when nothing was drawn by hand.
      // `labels_are_colours` always: every drawing MRLatte checks was made
      // with its pen, whose value is a colour. lqtpy then leaves the `values`
      // finding out of its verdict and score too, not just out of the list.
      const context = { labels_are_colours: true, ...(viewerRef?.current?.getDrawingContext?.() || {}) };
      const result = await fetchQc({ lesionId, mni, context, tier, signal: controller.signal });
      const flags = (result.flags || []).filter((f) => !IGNORED_FLAG_IDS.has(f.id));
      // lqtpy 0.6.0 says itself whether a result deserves an interruption;
      // older versions leave it to the rule above.
      const attention = typeof result.needs_attention === "boolean"
        ? result.needs_attention && needsAttention(flags)
        : needsAttention(flags);
      return { ...result, flags, needsAttention: attention, lesionId };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // lqtpy absent/older (503), a network failure, an abort (timeout), or
    // any other error — all fail open. See module doc.
    return null;
  }
}
