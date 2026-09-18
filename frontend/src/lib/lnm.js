// DaLn mapper — Degree-Adjusted Lesion Network Mapping (DA-LNM v2.1) client.
// POSTs a lesion NIfTI to the backend, which runs the Connectome bundle in an
// isolated worker and returns stat-map/mask URLs, specificity results, and
// atlas-labelled networks (Harvard-Oxford + Yeo-7).

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

export async function lnmAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/lnm/available`);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return await r.json(); // { ok, reason?, bundle_present? }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Run degree-adjusted lesion network mapping.
 * @param {File} lesionFile  lesion NIfTI (.nii/.nii.gz)
 * @param {object} opts  {
 *   name, metric ("t"|"z"), threshold, zthr, pthr, degreeAdjust,
 *   runSpecificity, nperm, alpha, fdr, makeHtml
 * }
 * @returns {Promise<{
 *   id, metric, degree_adjust, threshold, thr_note,
 *   n_lesion_voxels, degree_corr_before, degree_corr_after,
 *   n_pos_thr, n_neg_thr,
 *   specificity: { run, nperm?, alpha?, fdr?, n_sig_pos?, n_sig_neg? },
 *   display: { cal_min, cal_max },
 *   files: { raw, da?, thresh_cont, pos_bin, neg_bin, spec_zscore?, spec_net?, html? },
 *   networks: { n_pos, n_neg, ho_pos?, ho_neg?, ho_err?, yeo_pos?, yeo_neg?, yeo_err? }
 * }>}
 */
export async function lnmCompute(lesionFile, {
  name = "",
  metric = "t",
  threshold = 11.0,
  zthr = 0.2,
  pthr = null,
  degreeAdjust = true,
  runSpecificity = true,
  nperm = 100,
  alpha = 0.05,
  fdr = false,
  makeHtml = true,
} = {}) {
  const fd = new FormData();
  fd.append("file", lesionFile, lesionFile.name);
  if (name) fd.append("name", name);
  fd.append("metric", metric);
  fd.append("threshold", String(threshold));
  fd.append("zthr", String(zthr));
  if (pthr !== null && pthr !== undefined && pthr !== "") fd.append("pthr", String(pthr));
  fd.append("degree_adjust", String(!!degreeAdjust));
  fd.append("run_specificity", String(!!runSpecificity));
  fd.append("nperm", String(nperm));
  fd.append("alpha", String(alpha));
  fd.append("fdr", String(!!fdr));
  fd.append("make_html", String(!!makeHtml));
  const r = await fetch(`${apiBase}/api/lnm/compute`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

export function lnmResultUrl(relPath) {
  return `${apiBase}${relPath}`;
}

// ── Pollable job variant (progress bar) ─────────────────────────────────────
// Same compute as lnmCompute, but kicked off as a background job that streams
// staged progress (including the specificity permutation %). Mirrors summary.js.

/** Start an LNM job. Opts match lnmCompute. @returns {Promise<{job_id}>} */
export async function startLnm(lesionFile, {
  name = "",
  metric = "t",
  threshold = 11.0,
  zthr = 0.2,
  pthr = null,
  degreeAdjust = true,
  runSpecificity = true,
  nperm = 100,
  alpha = 0.05,
  fdr = false,
  makeHtml = true,
} = {}) {
  const fd = new FormData();
  fd.append("file", lesionFile, lesionFile.name);
  if (name) fd.append("name", name);
  fd.append("metric", metric);
  fd.append("threshold", String(threshold));
  fd.append("zthr", String(zthr));
  if (pthr !== null && pthr !== undefined && pthr !== "") fd.append("pthr", String(pthr));
  fd.append("degree_adjust", String(!!degreeAdjust));
  fd.append("run_specificity", String(!!runSpecificity));
  fd.append("nperm", String(nperm));
  fd.append("alpha", String(alpha));
  fd.append("fdr", String(!!fdr));
  fd.append("make_html", String(!!makeHtml));
  const r = await fetch(`${apiBase}/api/lnm/start`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/** Poll an LNM job. Returns { stage, message, progress, done, error, result? }. */
export async function lnmStatus(jobId) {
  const r = await fetch(`${apiBase}/api/lnm/status/${jobId}`);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/** Cancel a running LNM job (kills the worker). Safe after done. */
export async function cancelLnm(jobId) {
  const r = await fetch(`${apiBase}/api/lnm/cancel/${jobId}`, { method: "POST" });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

// Human-readable labels for the network keys the worker returns.
export const LNM_NETWORK_LABELS = {
  ho_pos: "Harvard-Oxford · Coupled (+)",
  ho_neg: "Harvard-Oxford · Anticorrelated (−)",
  yeo_pos: "Yeo-7 Networks · Coupled (+)",
  yeo_neg: "Yeo-7 Networks · Anticorrelated (−)",
};

// ── Exports ────────────────────────────────────────────────────────────────

/** Flatten the network tables into CSV rows. */
export function lnmToCSV(result, lesionName = "") {
  const rows = [["network", "region", "voxels", "pct", "mean_stat"]];
  const nets = result?.networks || {};
  for (const key of Object.keys(LNM_NETWORK_LABELS)) {
    const label = LNM_NETWORK_LABELS[key];
    for (const r of nets[key] || []) {
      rows.push([label, r.name, r.voxels, r.pct, r.mean_t]);
    }
  }
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = `# Degree Adjusted Lesion Networking report — ${lesionName || "(unnamed)"}\n`;
  return header + rows.map((r) => r.map(esc).join(",")).join("\n");
}
