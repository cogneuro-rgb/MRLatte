/**
 * Build the per-step {key, label, state} array RunningIndicator expects,
 * from a panel's own ordered stage-definition list and the current job.
 * Extracted from three near-identical copies of this computation
 * (TractDissectionPanel, DaLnMapperPanel, OneClickSummaryPanel); behaviour
 * is unchanged — this is a relocation, not a redesign.
 *
 * Callers that only show a SUBSET of stages (e.g. One-Click Summary hiding
 * disabled pipeline stages, LNM hiding "specificity" when that test is off)
 * filter `stageDefs` themselves before calling this — the stage INDEX used
 * for done/active/pending is still computed from the full filtered list, so
 * "done"/"pending" stays correct relative to what's actually shown.
 *
 * @param {{key: string, label: string}[]} stageDefs - ordered, already
 *   filtered to whatever subset this panel is displaying.
 * @param {{stage?: string, error?: any, done?: boolean}|null} job
 * @returns {{key: string, label: string, state: "error"|"done"|"active"|"pending"}[]|undefined}
 */
export function buildStageSteps(stageDefs, job) {
  if (!job) return undefined;
  const stageIndex = stageDefs.reduce((m, s, i) => ((m[s.key] = i), m), {});
  const cur = stageIndex[job.stage] ?? -1;
  return stageDefs.map((s) => {
    const idx = stageIndex[s.key];
    const state = job.error && idx >= cur ? "error"
      : idx < cur || job.done ? "done"
      : idx === cur ? "active" : "pending";
    return { key: s.key, label: s.label, state };
  });
}
