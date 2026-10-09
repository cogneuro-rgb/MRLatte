import { useEffect, useRef, useState } from "react";
import { runLesionQc } from "@/lib/lesionQc";

// No draw changes for this long while paint mode is on -> run QC once in the
// background. Named per CLAUDE.md §2 rather than an inline magic number.
export const LESION_QC_IDLE_MS = 30000;

/**
 * Idle-drawing quality check (owner's idea-inbox request: "give a warning
 * during drawing after a certain time limit of no drawing"). While paint
 * mode is on and the drawing has content, run lqtpy QC in the background
 * after `LESION_QC_IDLE_MS` of no draw changes, and return any flags as
 * `idleWarning` — never a modal (a modal popping up mid-stroke would be
 * infuriating). Dashboard shows it as a persistent orange warning on the
 * viewer (not a toast, which vanished after a few seconds — owner's
 * follow-up request): it stays until the drawing changes again or paint
 * mode turns off, both of which clear it here.
 *
 * Draw-change signal: NiivueViewer exposes a SINGLE-SLOT draw-change
 * callback (`setDrawChangeCallback`, drawingApi.js), and Dashboard.jsx
 * already occupies that slot for retinotopy's `drawingHasContent`.
 * Registering a second callback here would silently replace Dashboard's and
 * break retinotopy — so this hook does NOT touch the viewer's callback slot
 * at all. Instead it returns `notifyDrawChange`, a STABLE function (never
 * changes identity across renders — safe to capture once in Dashboard's
 * existing, empty-deps draw-change effect without going stale, per the
 * "Stale closures" invariant in CLAUDE.md §6) that Dashboard calls from
 * INSIDE its existing handler, alongside what it already does.
 *
 * Don't-nag: runs at most once per distinct drawing state, keyed on the
 * upload's content hash (`lesionId`, sha256 of the drawing's NIfTI bytes —
 * see lib/lesionMetrics.js's uploadLesion). An unchanged drawing hashes to
 * the same id and is never re-surfaced; only a NEW draw-change resets the
 * idle timer that leads to a NEW check.
 *
 * @param {{viewerRef: object, active: boolean, mni: boolean}} args
 * @returns {{notifyDrawChange: () => void, idleWarning: {flags: object[], provenance: object, lesionId: string}|null}}
 */
export function useLesionQcIdle({ viewerRef, active, mni }) {
  // Live mirrors for the stable notifyDrawChange closure below — read
  // fresh every call instead of capturing a stale render's props.
  const activeRef = useRef(active);
  activeRef.current = active;
  const mniRef = useRef(mni);
  mniRef.current = mni;

  // The flagged QC result currently on show, or null. setIdleWarning is
  // stable, so the stable closures below can call it safely.
  const [idleWarning, setIdleWarning] = useState(null);

  const timerRef = useRef(null);
  // lesionId of the drawing state already surfaced (warning shown) or found
  // clean — never re-checked again until the content actually changes.
  const lastCheckedIdRef = useRef(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const runIdleCheck = async () => {
    if (!activeRef.current) return; // paint mode already off — don't bother
    const result = await runLesionQc({
      viewerRef, mni: mniRef.current, fileName: "qc_idle_drawing.nii.gz",
      // The background check only has to notice trouble, so it runs lqtpy
      // 0.6.0's quicker tier (it skips the slow plausibility checks). Save and
      // Download still run the full one. Older lqtpy ignores this.
      tier: "fast",
    });
    if (!result) return; // fail-open path (see lib/lesionQc.js) — nothing to show
    if (!activeRef.current) return; // turned off while the request was in flight
    if (lastCheckedIdRef.current === result.lesionId) return; // already surfaced this exact drawing
    lastCheckedIdRef.current = result.lesionId;
    if (!result.needsAttention) return; // clean, or Notes only — nothing to warn about
    setIdleWarning(result);
  };

  // Stable across renders (initialised once) — see the function doc above
  // for why this must never be recreated. Any drawing change retires the
  // warning on show: it described a drawing that no longer exists.
  const notifyDrawChangeRef = useRef(() => {
    clearTimer();
    setIdleWarning(null);
    if (!activeRef.current) return;
    timerRef.current = setTimeout(runIdleCheck, LESION_QC_IDLE_MS);
  });

  // Stop the pending check, and drop the warning, the moment paint mode
  // turns off.
  useEffect(() => {
    if (!active) {
      clearTimer();
      setIdleWarning(null);
    }
  }, [active]);

  useEffect(() => clearTimer, []);

  return { notifyDrawChange: notifyDrawChangeRef.current, idleWarning };
}
