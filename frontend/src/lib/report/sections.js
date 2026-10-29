// Report section builders (item 103). Each function takes a data model
// already produced elsewhere in the app (buildLesionReportModel,
// buildTractReportModel, the LNM worker's JSON result, …) and returns a
// { title, html } section for lib/report/render.js's renderReportHtml. This
// is the single place report markup for each data shape is built — every
// report surface (Lesion Report, Tract Dissection, LNM, One-Click Summary)
// composes the SAME functions instead of each owning its own HTML.

import { statCardsHtml, dataTableHtml, imgPanelHtml, figureHtml, barHtml } from "@/lib/report/render";
import { LNM_NETWORK_LABELS } from "@/lib/lnm";
import { engineProvenanceLabel } from "@/lib/lesionReport";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

// ── Lesion (atlas overlap + retinotopy) ──────────────────────────────────────
// Model shape: lib/lesionReport.js::buildLesionReportModel().

/** Which side a centroid lies on (MNI x: + is right), for the stats and lead. */
export function sideOf(centroidMM) {
  const x = centroidMM?.[0];
  if (!Number.isFinite(x)) return null;
  return x > 4 ? "Right" : x < -4 ? "Left" : "Midline";
}

export function buildLesionStatsSection(model) {
  const v = model.volume;
  const c = v?.centroidMM;
  const side = sideOf(c);
  const cards = [
    { label: "Volume", value: v ? v.cm3.toFixed(2) : "—", sub: "cm³" },
    { label: "Voxels", value: v ? v.voxelCount.toLocaleString() : "—", sub: "in the lesion" },
    { label: "Centre", value: c ? c.map((v) => Math.round(v) || 0).join(", ") : "—", sub: "MNI mm (x, y, z)" },
    { label: "Side", value: side || "—", sub: side && side !== "Midline" ? `${side.toLowerCase()} hemisphere` : "by its centre" },
  ];
  return { title: "Measurements", html: statCardsHtml(cards) };
}

/** The lesion report's "Method" entries: what went in and which engine ran. */
export function lesionMethodItems(model) {
  return [
    { label: "Lesion", value: escapeHtml(model.lesionName || "(unnamed)") },
    { label: "Atlases", value: model.atlasBreakdowns.map((b) => escapeHtml(b.atlasName)).join(", ") || "none selected" },
    { label: "Retinotopy", value: model.retinotopyFindings?.length
      ? model.retinotopyFindings.map((f) => escapeHtml(f.name)).join(", ") : "no map loaded" },
    { label: "Engine", value: escapeHtml((engineProvenanceLabel(model.provenance) || "").replace(/^Engine:\s*/, "")) },
    // lqtpy counts LesionVoxels on the ATLAS grid (resample-then-count), not
    // the lesion's own grid like the JS engine — see resolveLesionAtlasMetrics
    // in lib/lesionReport.js. Said once here, so "Voxels" in the tables never
    // silently means two different units depending on which engine ran.
    model.atlasBreakdowns.some((b) => b.voxelGrid === "atlas")
      && { label: "Voxel counts", value: "on each atlas's own grid (the lesion is resampled to it)" },
  ];
}

// Tables show this many rows; the rest fold under "N more" (they still
// print when unfolded). Regions under SMALL_REGION_PCT of the lesion are
// always in the fold.
const TOP_ROWS = 5;
const SMALL_REGION_PCT = 1;

/** A table of the first `keep` rows, the rest folded under "N more …"
 * (`noun` singular: "region" → "1 more region", "3 more regions"). */
export function foldedTableHtml(columns, rows, keep = TOP_ROWS, noun = "row") {
  const shown = rows.slice(0, keep);
  const rest = rows.slice(keep);
  return (shown.length ? dataTableHtml(columns, shown) : "")
    + (rest.length ? `<details class="more"><summary>${rest.length} more ${noun}${rest.length === 1 ? "" : "s"}</summary>${dataTableHtml(columns, rest)}</details>` : "");
}

export function buildLesionAtlasSection(model) {
  if (!model.atlasBreakdowns.length) {
    return { title: "Atlas overlap", html: `<p class="quiet-note">No atlas was selected for this report.</p>` };
  }
  const columns = [
    { key: "regionName", label: "Region" },
    { key: "pctOfLesion", label: "% of lesion", numeric: true, render: (r) => barHtml(r.pctOfLesion) },
    { key: "pctOfRegion", label: "% of region", numeric: true },
    { key: "voxelCount", label: "Voxels", numeric: true },
  ];
  const html = model.atlasBreakdowns.map((b) => {
    const rows = b.rows.map((r) => ({
      regionName: escapeHtml(r.regionName),
      voxelCount: r.voxelCount.toLocaleString(),
      pctOfLesion: r.percentOfLesion,
      pctOfRegion: `${r.percentOfRegion.toFixed(1)}%`,
    }));
    const keep = Math.min(TOP_ROWS, rows.filter((r) => r.pctOfLesion >= SMALL_REGION_PCT).length);
    const none = !keep && rows.length ? `<p class="quiet-note">No region covers ${SMALL_REGION_PCT}% of the lesion or more.</p>` : "";
    return `<div class="section-title">${escapeHtml(b.atlasName)}</div>${none}${foldedTableHtml(columns, rows, keep, "region")}`;
  }).join("\n");
  return { title: null, html };
}

/** A figure section from lib/report/figures.js output, or null without one. */
export function buildFigureSection(title, fig) {
  return fig?.src ? { title, html: figureHtml(fig) } : null;
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
    { label: "Streamlines through the lesion", value: model.nSelectedStreamlines.toLocaleString(),
      sub: `${model.pctSelected}% of ${model.nInputStreamlines.toLocaleString()}` },
    { label: "Tract volume", value: model.tractVolumeCm3.toFixed(3), sub: "cm³" },
    { label: "Affected voxels", value: model.affectedVoxels.toLocaleString(), sub: "voxels" },
    { label: "Regions reached", value: model.atlasBreakdowns.reduce((n, b) => n + b.rows.length, 0),
      sub: model.atlasBreakdowns.map((b) => b.atlasName).join(", ") || "atlas regions" },
  ];
  return { title: "Measurements", html: statCardsHtml(cards) };
}

export function buildTractAtlasSection(model) {
  if (!model.atlasBreakdowns.length) {
    return { title: "Regions reached", html: `<p class="quiet-note">No atlas region is reached.</p>` };
  }
  const html = model.atlasBreakdowns.filter((b) => b.rows.length).map((b) => {
    const rows = b.rows.map((r) => ({
      regionName: escapeHtml(r.regionName),
      hitVoxels: r.hitVoxels.toLocaleString(),
      pctRegion: r.pctRegion,
      density: (r.streamlineDensity ?? 0).toLocaleString(),
    }));
    const table = foldedTableHtml([
      { key: "regionName", label: "Region" },
      { key: "hitVoxels", label: "Voxels reached", numeric: true },
      { key: "pctRegion", label: "% of region", numeric: true, render: (r) => barHtml(r.pctRegion) },
      { key: "density", label: "Streamline density", numeric: true },
    ], rows, TOP_ROWS, "tract");
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
    { label: "Lesion voxels", value: (result.n_lesion_voxels ?? 0).toLocaleString(), sub: "seed" },
    { label: "Degree r (before → after)", value: `${result.degree_corr_before} → ${result.degree_corr_after ?? "n/a"}`, sub: "degree adjustment" },
    { label: "Above threshold", value: `${(result.n_pos_thr ?? 0).toLocaleString()} / ${(result.n_neg_thr ?? 0).toLocaleString()}`, sub: "voxels, positive / negative" },
    ...(spec?.run ? [{ label: "Survive specificity", value: `${spec.n_sig_pos.toLocaleString()} / ${spec.n_sig_neg.toLocaleString()}`, sub: `${spec.nperm} permutations, α=${spec.alpha}${spec.fdr ? ", FDR" : ""}` }] : []),
  ];
  return { title: "Measurements", html: statCardsHtml(cards) };
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
      const table = foldedTableHtml([
        { key: "name", label: "Region" }, { key: "voxels", label: "Voxels", numeric: true },
        { key: "pct", label: "%", numeric: true }, { key: "mean", label: `Mean ${escapeHtml(metric)}`, numeric: true },
      ], rows, TOP_ROWS, "region");
      return `<div class="section-title">${LNM_NETWORK_LABELS[k]}</div>${table}`;
    }).join("\n");
  const errs = [nets.ho_err && `Harvard-Oxford: ${escapeHtml(nets.ho_err)}`, nets.yeo_err && `Yeo-7: ${escapeHtml(nets.yeo_err)}`]
    .filter(Boolean).map((e) => `<p style="color:#b45309;font-size:12px;">${e}</p>`).join("");
  return { title: null, html: (tables || `<p class="quiet-note">No network above the threshold.</p>`) + errs };
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
  // A section that couldn't be computed is one short line; the reason (often
  // long and repeated per atlas) is folded under "why".
  const note = (label, reason) => `<div class="quiet-note">${escapeHtml(label)}: not available.${
    reason ? ` <details><summary>Why</summary><span class="why">${escapeHtml(reason)}</span></details>` : ""}</div>`;
  if (reportFragments.failed) {
    return [{ title: null, html: note("Detailed measures", reportFragments.reason || "unknown error") }];
  }
  const parts = [];
  const names = [];
  for (const kind of LQT_SECTION_ORDER) {
    const html = reportFragments.fragments?.[kind];
    const reason = reportFragments.unavailable?.[kind];
    if (html) {
      parts.push(html);
      names.push((LQT_SECTION_LABELS[kind] || kind).toLowerCase());
    } else if (reason) {
      parts.push(note(LQT_SECTION_LABELS[kind] || kind, reason));
    }
  }
  if (!parts.length) return [];
  // Folded: the main report already gives the size, place and regions; this
  // is the long-form detail for whoever wants it.
  return [{
    title: null,
    html: `<details class="collapsible"><summary>Show ${names.length ? names.join(", ") : "notes"}</summary><div class="collapsible-inner">${parts.join("\n")}</div></details>`,
  }];
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
