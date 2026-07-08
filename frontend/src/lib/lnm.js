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

/** Build a self-contained HTML report for the LNM result (client-side summary;
 * the backend also produces a fuller report at result.files.html). */
export function lnmToHTML(result, lesionName = "") {
  const nets = result?.networks || {};
  const table = (key) => {
    const rows = nets[key] || [];
    if (!rows.length) return "";
    const body = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${r.voxels}</td><td>${r.pct}%</td><td>${r.mean_t}</td></tr>`,
      )
      .join("");
    return `<h3>${esc(LNM_NETWORK_LABELS[key] || key)}</h3>
      <table><thead><tr><th>Region</th><th>Voxels</th><th>%</th><th>Mean ${esc(result.metric || "t")}</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  };
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  const tables = Object.keys(LNM_NETWORK_LABELS).map(table).join("\n") ||
    "<p>No suprathreshold network at this threshold.</p>";
  const spec = result?.specificity;
  const specCard = spec?.run
    ? `<div class="card"><div class="k">Survives specificity</div><div class="v">${spec.n_sig_pos} / ${spec.n_sig_neg}</div></div>`
    : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>NeuroVue Degree Adjusted Lesion Networking Report</title>
<style>
  body{font-family:system-ui,Segoe UI,sans-serif;margin:32px;color:#0f172a;}
  h1{font-size:20px;} h3{margin-top:24px;font-size:14px;color:#334155;}
  .stats{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;}
  .card{border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;min-width:140px;}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;}
  .card .v{font-size:18px;font-weight:600;}
  table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px;}
  th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left;}
  th{background:#f8fafc;} .foot{margin-top:24px;font-size:11px;color:#94a3b8;}
</style></head><body>
<h1>NeuroVue — Degree Adjusted Lesion Networking Report</h1>
<div>Lesion: <strong>${esc(lesionName || "(unnamed)")}</strong> · Generated: ${new Date().toLocaleString()}</div>
<div class="stats">
  <div class="card"><div class="k">Lesion voxels</div><div class="v">${result.n_lesion_voxels?.toLocaleString?.() ?? result.n_lesion_voxels}</div></div>
  <div class="card"><div class="k">Degree r (before→after)</div><div class="v">${result.degree_corr_before} → ${result.degree_corr_after ?? "n/a"}</div></div>
  <div class="card"><div class="k">Threshold |${esc(result.metric || "t")}|</div><div class="v">${result.threshold}</div></div>
  <div class="card"><div class="k">Supra-threshold (+/−)</div><div class="v">${result.n_pos_thr} / ${result.n_neg_thr}</div></div>
  ${specCard}
</div>
${tables}
<div class="foot">⚠ Automated analysis — for research and clinical review only. Degree Adjusted Lesion Networking · MNI152.</div>
</body></html>`;
}
