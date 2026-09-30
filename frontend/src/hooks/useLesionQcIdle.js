import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { runLesionQc } from "@/lib/lesionQc";

// No draw changes for this long while paint mode is on -> run QC once in the
// background. Named per CLAUDE.md §2 rather than an inline magic number.
export const LESION_QC_IDLE_MS = 30000;

/**
 * Idle-drawing quality check (owner's idea-inbox request: "give a warning
 * during drawing after a certain time limit of no drawing"). While paint
 * mode is on and the drawing has content, run lqtpy QC in the background
 * after `LESION_QC_IDLE_MS` of no draw changes, and surface any flags as a
 * non-blocking toast — never a modal (a modal popping up mid-stroke would be
 * infuriating).
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
 * the same id and is never re-surfaced; a dismissed toast (or one whose
 * "Details" was opened) doesn't reappear until the drawing actually
 * changes, because only a NEW draw-change resets the idle timer that leads
 * to a NEW check.
 *
 * @param {{viewerRef: object, active: boolean, mni: boolean, onDetails: (result: {flags: object[], provenance: object}) => void}} args
 * @returns {{notifyDrawChange: () => void}}
 */
export function useLesionQcIdle({ viewerRef, active, mni, onDetails }) {
  // Live mirrors for the stable notifyDrawChange closure below — read
  // fresh every call instead of capturing a stale render's props.
  const activeRef = useRef(active);
  activeRef.current = active;
  const mniRef = useRef(mni);
  mniRef.current = mni;
  const onDetailsRef = useRef(onDetails);
  onDetailsRef.current = onDetails;

  const timerRef = useRef(null);
  // lesionId of the drawing state already surfaced (toast shown) or found
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
    });
    if (!result) return; // fail-open path (see lib/lesionQc.js) — nothing to show
    if (!activeRef.current) return; // turned off while the request was in flight
    if (lastCheckedIdRef.current === result.lesionId) return; // already surfaced this exact drawing
    lastCheckedIdRef.current = result.lesionId;
    if (!result.flags?.length) return; // clean drawing — nothing to nag about

    const top = result.flags[0];
    const isNote = top.severity === "info";
    toast(isNote ? "Note on this drawing" : "Possible issues with this drawing", {
      description: top.message,
      action: { label: "Details", onClick: () => onDetailsRef.current?.(result) },
    });
  };

  // Stable across renders (initialised once) — see the function doc above
  // for why this must never be recreated.
  const notifyDrawChangeRef = useRef(() => {
    clearTimer();
    if (!activeRef.current) return;
    timerRef.current = setTimeout(runIdleCheck, LESION_QC_IDLE_MS);
  });

  // Stop the pending check the moment paint mode turns off.
  useEffect(() => {
    if (!active) clearTimer();
  }, [active]);

  useEffect(() => clearTimer, []);

  return { notifyDrawChange: notifyDrawChangeRef.current };
}
