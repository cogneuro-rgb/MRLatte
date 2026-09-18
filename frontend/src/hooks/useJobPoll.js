import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";

/**
 * Owns the poll lifecycle shared by every background-job panel (Tract
 * Dissection, Lesion Network Mapping, One-Click Summary): a `job` object
 * driving a RunningIndicator, a 1.5s status poll while it's running, and a
 * cancel action. Extracted from three near-identical copies of this effect;
 * behaviour is unchanged — this is a relocation, not a redesign.
 *
 * All wording (success/cancelled/error toasts) stays with the caller via
 * `onDone`/`onCancelled`/`onError`, since each panel's messages differ (and
 * TractDissectionPanel's error message even depends on `job.mode`) — the
 * hook only owns the mechanical polling, not what a status means to the user.
 *
 * @param {object} opts
 * @param {(jobId: string) => Promise<object>} opts.statusFn
 * @param {(jobId: string) => Promise<any>} opts.cancelFn
 * @param {number} [opts.intervalMs]
 * @param {(status: object, job: object) => void} [opts.onCancelled] - status.stage === "cancelled"
 * @param {(status: object, job: object) => void} [opts.onError] - status.error is set
 * @param {(status: object, job: object) => (void | Promise<void>)} [opts.onDone] - success path
 * @param {boolean} [opts.keepDoneState] - opt-in; default false. When false (today's
 *   behaviour, relied on by Tract Dissection and LNM), the job is nulled out right after
 *   onDone runs, so a "done" job state never lives in `job` and RunningIndicator's `done`
 *   branch never renders. Pass true to keep the finished job (already merged with the last
 *   status, so `job.done`/`job.error` reflect it) in state until the caller nulls it itself
 *   (e.g. RunningIndicator's onDismiss) — e.g. One-Click Summary, which shows the completed
 *   state and lets a Report/Download action stay reachable after the job finishes.
 * @returns {{ job: object|null, setJob: Function, busy: boolean, cancelling: boolean, cancel: () => Promise<void> }}
 */
export function useJobPoll({ statusFn, cancelFn, intervalMs = 1500, onCancelled, onError, onDone, keepDoneState = false }) {
  const [job, setJob] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!job?.jobId || job.done) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await statusFn(job.jobId);
        if (cancelled) return;
        setJob((prev) => (prev ? { ...prev, ...s } : prev));
        if (!s.done) return;
        clearInterval(pollRef.current);
        if (s.stage === "cancelled") {
          onCancelled?.(s, job);
          setJob(null);
          return;
        }
        if (s.error) {
          onError?.(s, job);
          setJob(null);
          return;
        }
        try {
          await onDone?.(s, job);
        } finally {
          if (!keepDoneState) setJob(null);
        }
      } catch (_e) {
        // transient poll error — keep trying until the interval is cleared
      }
    };
    pollRef.current = setInterval(tick, intervalMs);
    tick();
    return () => { cancelled = true; clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.done]);

  // Cancel the running job: kills the backend worker subprocess, returns to
  // idle immediately rather than waiting for one more status poll.
  const cancel = async () => {
    if (!job?.jobId) return;
    setCancelling(true);
    try {
      await cancelFn(job.jobId);
      onCancelled?.(null, job);
    } catch (e) {
      toast.error("Failed to cancel", { description: e?.message });
    } finally {
      clearInterval(pollRef.current);
      setCancelling(false);
      setJob(null);
    }
  };

  return { job, setJob, busy: !!job && !job.done, cancelling, cancel };
}
