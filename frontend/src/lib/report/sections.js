// Report section builders (item 103). Each function takes a data model
// already produced elsewhere in the app (buildLesionReportModel,
// buildTractReportModel, the LNM worker's JSON result, …) and returns a
// { title, html } section for lib/report/render.js's renderReportHtml. This
// is the single place report markup for each data shape is built — every
// report surface (Lesion Report, Tract Dissection, LNM, One-Click Summary)
// composes the SAME functions instead of each owning its own HTML.

import { statCardsHtml, pillRowHtml, dataTableHtml, imgPanelHtml } from "@/lib/report/render";
import { LNM_NETWORK_LABELS } from "@/lib/lnm";
import { engineProvenanceLabel } from "@/lib/lesionReport";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

// ── Lesion (atlas overlap + retinotopy) ──────────────────────────────────────
// Model shape: lib/lesionReport.js::buildLesionReportModel().

export function buildLesionStatsSection(model) {
  const v = model.volume;
  const c = v?.centroidMM;
  const totalAtlasRegions = model.atlasBreakdowns.reduce((n, b) => n + b.rows.length, 0);
  const cards = [
    { label: "Lesion Volume", value: v ? v.cm3.toFixed(2) : "—", sub: "cm³", accent: "#2563eb" },
    { label: "Voxel Count", value: v ? v.voxelCount.toLocaleString() : "—", sub: "voxels", accent: "#7c3aed" },
    { label: "MNI Centroid", value: c ? `[${c[0].toFixed(0)}, ${c[1].toFixed(0)}, ${c[2].toFixed(0)}]` : "—", sub: "mm (x, y, z)", accent: "#0891b2" },
    { label: "Atlas Regions", value: totalAtlasRegions, sub: `across ${model.atlasBreakdowns.length} atlas(es)`, accent: "#059669" },
  ];
  const pills = [{ label: "Lesion", value: escapeHtml(model.lesionName || "(unnamed)") },
    ...model.atlasBreakdowns.map((b) => ({ label: "Atlas", value: escapeHtml(b.atlasName) })),
    { label: "Retinotopy", value: model.retinotopyFindings?.length ? "Yes" : "None loaded" }];
  // Item (lqtpy migration): quiet provenance pill — which engine + convention
  // produced the numbers above. Reuses the existing .pill styling; appears in
  // both the on-screen preview (LesionReportPanel renders the same label
  // separately) and here, in the exported/saved report HTML.
  const engineLine = engineProvenanceLabel(model.provenance);
  if (engineLine) pills.push({ label: "Engine", value: escapeHtml(engineLine.replace(/^Engine:\s*/, "")) });
  return { title: "Key Statistics", html: `${statCardsHtml(cards)}${pillRowHtml(pills)}` };
}

export function buildLesionAtlasSection(model) {
  if (!model.atlasBreakdowns.length) {
    return { title: "Atlas Overlap", html: `<p style="color:#94a3b8;font-size:13px;">No atlas selected for this report.</p>` };
  }
  const html = model.atlasBreakdowns.map((b) => {
    const rows = b.rows.map((r) => ({
      regionName: escapeHtml(r.regionName),
      voxelCount: r.voxelCount,
      pctOfLesion: `${r.percentOfLesion.toFixed(1)}%`,
      pctOfRegion: `${r.percentOfRegion.toFixed(1)}%`,
    }));
    // lqtpy counts LesionVoxels on the ATLAS grid (resample-then-count), not
    // the lesion's own grid like the JS engine — see resolveLesionAtlasMetrics
    // in lib/lesionReport.js. The column header says which, so "Voxels" never
    // silently means two different units depending on which engine ran.
    const voxelsLabel = b.voxelGrid === "atlas" ? "Voxels (atlas grid)" : "Voxels";
    const table = dataTableHtml([
      { key: "regionName", label: "Region" },
      { key: "voxelCount", label: voxelsLabel, numeric: true },
      { key: "pctOfLesion", label: "% of Lesion", numeric: true },
      { key: "pctOfRegion", label: "% of Region", numeric: true },
    ], rows);
    return `<div class="section-title">${escapeHtml(b.atlasName)}</div>${table}`;
  }).join("\n");
  return { title: null, html };
}

export function buildRetinotopySection(findings) {
  if (!findings?.length) return null;
  const rows = findings.map((f) => ({
    name: escapeHtml(f.name),
    kind: f.kind,
    summary: escapeHtml(f.summary || "—"),
    type: f.illustrative ? "Population template" : "Cortical",
  }));
  const table = dataTableHtml([
    { key: "name", label: "Map" }, { key: "kind", label: "Kind" },
    { key: "summary", label: "Summary" }, { key: "type", label: "Type" },
  ], rows);
  return { title: "Retinotopy Findings", html: table };
}

// ── Tract dissection ─────────────────────────────────────────────────────────
// Model shape: lib/htmlReport.js::buildTractReportModel() (kept there — its
// input, the dissection worker's JSON result, is unrelated to reports).

export function buildTractStatsSection(model) {
  const cards = [
    { label: "Selected Streamlines", value: model.nSelectedStreamlines.toLocaleString(),
      sub: `${model.pctSelected}% of ${model.nInputStreamlines.toLocaleString()} total`, accent: "#2563eb" },
    { label: "Tract Volume", value: model.tractVolumeCm3.toFixed(3), sub: "cm³", accent: "#7c3aed" },
    { label: "Affected Voxels", value: model.affectedVoxels.toLocaleString(), sub: "voxels", accent: "#0891b2" },
    { label: "Regions Hit", value: model.atlasBreakdowns.reduce((n, b) => n + b.rows.length, 0),
      sub: model.atlasBreakdowns.map((b) => b.atlasName).join(", ") || "atlas regions", accent: "#059669" },
  ];
  return { title: "Key Statistics", html: statCardsHtml(cards) };
}

export function buildTractAtlasSection(model) {
  if (!model.atlasBreakdowns.length) {
    return { title: "Atlas Disconnection", html: `<p style="color:#94a3b8;font-size:13px;">No atlas overlap found.</p>` };
  }
  const html = model.atlasBreakdowns.filter((b) => b.rows.length).map((b) => {
    const rows = b.rows.map((r) => ({
      regionName: escapeHtml(r.regionName),
      hitVoxels: r.hitVoxels.toLocaleString(),
      pctRegion: `${r.pctRegion.toFixed(1)}%`,
      density: (r.streamlineDensity ?? 0).toLocaleString(),
    }));
    const table = dataTableHtml([
      { key: "regionName", label: "Region" },
      { key: "hitVoxels", label: "Hit Voxels", numeric: true },
      { key: "pctRegion", label: "% of Region", numeric: true },
      { key: "density", label: "Streamline Density", numeric: true },
    ], rows);
    return `<div class="section-title">${escapeHtml(b.atlasName)}</div>${table}`;
  }).join("\n");
  return { title: null, html };
}

export function buildTractSections(model) {
  return [buildTractStatsSection(model), buildTractAtlasSection(model)];
}

// ── Lesion Network Mapping ───────────────────────────────────────────────────
// Model shape: the LNM worker's JSON result (see lib/lnm.js's JSDoc) — same
// object DaLnMapperPanel already holds as `result`.

export function buildLnmStatsSection(result) {
  const spec = result?.specificity;
  const cards = [
    { label: "Lesion Voxels", value: (result.n_lesion_voxels ?? 0).toLocaleString(), sub: "voxels", accent: "#2563eb" },
    { label: "Degree r (before→after)", value: `${result.degree_corr_before} → ${result.degree_corr_after ?? "n/a"}`, sub: "", accent: "#7c3aed" },
    { label: "Supra-threshold", value: `${(result.n_pos_thr ?? 0).toLocaleString()} / ${(result.n_neg_thr ?? 0).toLocaleString()}`, sub: "+/− voxels", accent: "#0891b2" },
    ...(spec?.run ? [{ label: "Survives Specificity", value: `${spec.n_sig_pos.toLocaleString()} / ${spec.n_sig_neg.toLocaleString()}`, sub: `${spec.nperm} permutations, α=${spec.alpha}${spec.fdr ? ", FDR" : ""}`, accent: "#059669" }] : []),
  ];
  return { title: "Key Statistics", html: statCardsHtml(cards) };
}

export function buildLnmNetworkSection(result) {
  const nets = result?.networks || {};
  const metric = result.metric || "t";
  const tables = Object.keys(LNM_NETWORK_LABELS)
    .filter((k) => (nets[k] || []).length > 0)
    .map((k) => {
      const rows = nets[k].map((r) => ({
        name: escapeHtml(r.name), voxels: r.voxels, pct: `${r.pct}%`, mean: r.mean_t,
      }));
      const table = dataTableHtml([
        { key: "name", label: "Region" }, { key: "voxels", label: "Voxels", numeric: true },
        { key: "pct", label: "%", numeric: true }, { key: "mean", label: `Mean ${escapeHtml(metric)}`, numeric: true },
      ], rows);
      return `<div class="section-title">${LNM_NETWORK_LABELS[k]}</div>${table}`;
    }).join("\n");
  const errs = [nets.ho_err && `Harvard-Oxford: ${escapeHtml(nets.ho_err)}`, nets.yeo_err && `Yeo-7: ${escapeHtml(nets.yeo_err)}`]
    .filter(Boolean).map((e) => `<p style="color:#b45309;font-size:12px;">${e}</p>`).join("");
  return { title: null, html: (tables || `<p style="color:#94a3b8;font-size:13px;">No suprathreshold network at this threshold.</p>`) + errs };
}

// Backend-rendered visual (nilearn interactive iframe or PNG). `images` =
// { primary: { iframe?, png?, err? }, support: {...} } — the shape
// lnm_worker.py now returns in its JSON result instead of feeding a
// server-composed report.html (item 103).
export function buildLnmImagesSection(images) {
  if (!images) return null;
  const panel = (title, dot, img) => {
    if (!img) return imgPanelHtml(title, dot, `<div class="no-img">Not available</div>`);
    if (img.iframe) return imgPanelHtml(title, dot, img.iframe);
    if (img.png) return imgPanelHtml(title, dot, `<img src="data:image/png;base64,${img.png}" alt="${title}">`);
    return imgPanelHtml(title, dot, `<div class="no-img">Figure unavailable${img.err ? `<br><small>${escapeHtml(img.err)}</small>` : ""}</div>`);
  };
  const html = `<div class="img-grid">
    ${panel("Primary Result", "#6366f1", images.primary)}
    ${panel("Supporting Map", "#8b5cf6", images.support)}
  </div>`;
  return { title: "Network Maps", html };
}

export function buildLnmSections(result, images) {
  return [buildLnmStatsSection(result), buildLnmImagesSection(images), buildLnmNetworkSection(result)]
    .filter(Boolean);
}

// ── Generic image/iframe grid (used by One-Click Summary — brainsprite
// viewers and the client-rendered retinotopy disc, all served as files by
// the backend, embedded here by URL rather than re-rendered). ──────────────

// ── lqtpy report fragments (morphometry detail / network rollup / streamline
// disconnection) — see lib/lesionReport.js::resolveReportFragments for the
// fetch + fail-soft composition and backend/lesion_metrics.py::
// build_report_fragments for the engine. Rendered AFTER MRLatte's own
// sections, in this fixed order. Each fragment is already complete,
// self-contained `.lqt-root`-wrapped HTML from lqtpy — this just decides
// what to show per section: the fragment, a quiet "not available" note, or
// (fetch itself failed) one quiet note for the whole group. ─────────────────

const LQT_SECTION_ORDER = ["morphometry", "network_rollup", "disconnection"];
const LQT_SECTION_LABELS = {
  morphometry: "Morphometry detail",
  network_rollup: "Functional network involvement",
  disconnection: "Streamline disconnection",
};

/** The CSS lqtpy's fragments need (`fragments.stylesheet()`), or "" if none
 * apply — pass to renderReportHtml's `extraStyle` so it's embedded exactly
 * ONCE per document regardless of how many fragment sections render. */
export function lqtpyStylesheetCss(reportFragments) {
  if (!reportFragments || reportFragments.failed) return "";
  return reportFragments.stylesheet || "";
}

/** `reportFragments` is lib/lesionReport.js::resolveReportFragments()'s
 * return value (or null/undefined if it was never attempted). */
export function buildLqtpyFragmentSections(reportFragments) {
  if (!reportFragments) return [];
  if (reportFragments.failed) {
    return [{
      title: null,
      html: `<p class="quiet-note">Additional analysis sections: not available — ${escapeHtml(reportFragments.reason || "unknown error")}.</p>`,
    }];
  }
  const sections = [];
  for (const kind of LQT_SECTION_ORDER) {
    const html = reportFragments.fragments?.[kind];
    const reason = reportFragments.unavailable?.[kind];
    if (html) {
      sections.push({ title: null, html });
    } else if (reason) {
      sections.push({
        title: null,
        html: `<p class="quiet-note">${escapeHtml(LQT_SECTION_LABELS[kind] || kind)}: not available — ${escapeHtml(reason)}</p>`,
      });
    }
  }
  return sections;
}

export function buildImagesSection(title, images) {
  if (!images?.length) return null;
  const panels = images.map((im) => {
    if (im.iframeUrl) return imgPanelHtml(im.label, im.dot || "#0891b2", `<iframe src="${im.iframeUrl}"></iframe>`);
    if (im.imgUrl) return imgPanelHtml(im.label, im.dot || "#0891b2", `<img src="${im.imgUrl}" alt="${escapeHtml(im.label)}">`);
    return imgPanelHtml(im.label, im.dot || "#0891b2", `<div class="no-img">Not available</div>`);
  }).join("");
  return { title, html: `<div class="img-grid">${panels}</div>` };
}
