import { useCallback, useEffect, useRef, useState } from "react";
import { moduleJobStatus, normalizeJob } from "@/lib/modules";

// Poll state for module install / verify jobs, keyed by module id (one
// operation per module at a time; several modules may run concurrently).
//
// Deliberately NOT hooks/useJobPoll.js: that hook owns a single job, keys its
// effect on `job.jobId`, and requires the backend's `done` flag — while
// plans/phase-4.md's job payload ({stage, progress, bytes_done, bytes_total,
// error}) does not document one. normalizeJob() in lib/modules.js derives it.

const POLL_MS = 1000;

/**
 * @param {object} opts
 * @param {(moduleId: string, job: object) => void} [opts.onSettled] fired once
 *   per job when it reaches a terminal state (done, errored or cancelled).
 * @returns {{
 *   jobs: Record<string, object>,
 *   setJob: (id: string, patch: object) => void,
 *   clearJob: (id: string) => void,
 *   isBusy: (id: string) => boolean,
 * }}
 */
export function useModuleJobs({ onSettled } = {}) {
  const [jobs, setJobs] = useState({});
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);

  const setJob = useCallback((id, patch) => {
    setJobs((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, []);

  const clearJob = useCallback((id) => {
    setJobs((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // A stable key over the currently-pollable jobs, so the effect restarts only
  // when a job starts or finishes — not on every progress tick.
  const pollKey = Object.entries(jobs)
    .filter(([, j]) => j?.jobId && !j.done)
    .map(([id, j]) => `${id}|${j.jobId}`)
    .join(",");

  useEffect(() => {
    if (!pollKey) return undefined;
    const entries = pollKey.split(",").map((s) => s.split("|"));
    let stopped = false;

    const tick = async () => {
      for (const [mid, jobId] of entries) {
        const res = await moduleJobStatus(jobId);
        if (stopped) return;
        if (!res.ok) {
          // A real /api JSON 404 means the endpoint (or the job) is gone —
          // there is nothing left to poll. Anything else (a dropped connection,
          // a 500 on one tick) is transient: keep polling.
          if (res.missing) {
            const failed = {
              done: true,
              error: `job status unavailable — ${res.error}`,
              endpointMissing: true,
            };
            setJob(mid, failed);
            settledRef.current?.(mid, failed);
          }
          continue;
        }
        const s = normalizeJob(res.data);
        setJobs((prev) => {
          const cur = prev[mid];
          if (!cur || cur.jobId !== jobId || cur.done) return prev;
          return { ...prev, [mid]: { ...cur, ...s } };
        });
        if (s.done) settledRef.current?.(mid, s);
      }
    };

    const t = setInterval(tick, POLL_MS);
    tick();
    return () => { stopped = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey, setJob]);

  const isBusy = useCallback((id) => {
    const j = jobs[id];
    return !!j && !j.done;
  }, [jobs]);

  return { jobs, setJob, clearJob, isBusy };
}

export default useModuleJobs;
