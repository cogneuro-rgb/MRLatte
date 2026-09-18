// One-Click Summary client. Kicks off a backend pipeline (tract dissection +
// DA-LNM + retinotopy check + brainsprite/glass rendering) that packages a ZIP
// report, then exposes status polling and result URLs. Mirrors lnm.js /
// tractDissection.js conventions.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

export async function summaryAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/summary/available`);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return await r.json(); // { ok, reason?, dissect?, lnm? }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Start a summary job.
 * @param {File} lesionFile  lesion NIfTI (.nii/.nii.gz)
 * @param {object} payload  { name, stages:{overlap,dissect,retino,lnm},
 *   atlas_ids:[id], discPngs:{polar,vfmap} }. Atlas overlap is computed
 *   backend-side (lqtpy, in-process) from `atlas_ids` — see
 *   backend/deps.py's _summary_overlap_stage. `overlapModel` is still
 *   accepted for one release as a fallback for when lqtpy is unavailable
 *   server-side (DEPRECATED — see routers/summary.py's summary_run
 *   docstring); don't send it from new code.
 * @returns {Promise<{ job_id: string }>}
 */
export async function runSummary(lesionFile, payload = {}) {
  const fd = new FormData();
  fd.append("file", lesionFile, lesionFile.name);
  fd.append("payload", JSON.stringify(payload));
  const r = await fetch(`${apiBase}/api/summary/run`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/**
 * Cancel a running summary job — kills the active worker subprocess and marks
 * the pipeline to stop between stages. Safe to call after the job is already
 * done (returns { ok: true, already_done: true }).
 */
export async function cancelSummary(jobId) {
  const r = await fetch(`${apiBase}/api/summary/cancel/${jobId}`, { method: "POST" });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/** Poll a job's status. Returns { stage, message, progress, done, error, files? }. */
export async function summaryStatus(jobId) {
  const r = await fetch(`${apiBase}/api/summary/status/${jobId}`);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

export function summaryResultUrl(relPath) {
  // relPath is an absolute API path like /api/summary/result/{id}/images/foo.png
  return `${apiBase}${relPath}`;
}

/**
 * List the downloadable artifacts for a finished summary job (task 0b, the
 * ArtifactPickerDialog contract): { job_id, artifacts: [{ rel, label, kind,
 * bytes, group, default }] }.
 */
export async function summaryArtifacts(jobId) {
  const r = await fetch(`${apiBase}/api/summary/artifacts/${jobId}`);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/**
 * Build the GET download URL for one or more artifact `rel` paths, one `p`
 * per file. One `p` streams that file directly; two or more come back as a
 * zip. A GET so a plain anchor works — see ArtifactPickerDialog.
 */
export function summaryDownloadUrl(jobId, rels) {
  const params = rels.map((rel) => `p=${encodeURIComponent(rel)}`).join("&");
  return `${apiBase}/api/summary/download/${jobId}?${params}`;
}
