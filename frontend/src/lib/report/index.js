// Item 103 — single entry point composing a full report document from a
// data model + kind, reusing lib/report/sections.js's builders (the same
// ones each individual panel uses) so every report type shares one
// implementation per section. See lib/report/render.js for the page shell.
//
// Order, in every report: the answer first (a one-paragraph lead), then the
// figure, then the numbers, then detail, and how it was made last.

import { renderReportHtml } from "@/lib/report/render";
import {
  buildLesionStatsSection, buildLesionAtlasSection, buildRetinotopySection,
  buildTractSections, buildLnmSections, buildImagesSection, buildFigureSection,
  buildLqtpyFragmentSections, lqtpyStylesheetCss, lesionMethodItems, escapeHtml, sideOf,
} from "@/lib/report/sections";

const mm = (v) => Math.round(v) || 0;
const pct = (v) => `${Math.round(v)}%`;

/** The lead, as plain text: a few short sentences — size and place, the main
 * regions, and (when they ran) the visual field, the tracts and the network.
 * The tables below carry the detail. Also the PDF export's opening paragraph
 * (LesionReportPanel). Null with nothing to say. */
export function glanceText(model, { retinotopyFindings, retino, tractModel, lnmResult } = {}) {
  const out = [];
  const v = model?.volume;
  if (v) {
    const side = sideOf(v.centroidMM);
    out.push(`A ${v.cm3.toFixed(2)} cm³ lesion${side && side !== "Midline" ? ` in the ${side.toLowerCase()} hemisphere` : side ? " at the midline" : ""}`
      + (v.centroidMM ? `, centred at ${v.centroidMM.map(mm).join(", ")} (MNI mm).` : "."));
  }
  const atlas = (model?.atlasBreakdowns || []).find((b) => b.rows.some((r) => r.percentOfLesion >= 1));
  if (atlas) {
    const top = atlas.rows.filter((r) => r.percentOfLesion >= 1).slice(0, 3)
      .map((r) => `${r.regionName} (${pct(r.percentOfLesion)})`);
    out.push(`Mostly in ${top.join(", ")} — ${atlas.atlasName.split(" · ")[0]}.`);
  }
  const fields = [...new Set((retinotopyFindings || [])
    .map((f) => (String(f.summary || "").match(/(left|right|both|bilateral)[^·.]*hemifield[^·.]*/i) || [])[0])
    .filter(Boolean))];
  if (fields.length) out.push(`Visual field: ${fields.join("; ")}.`);
  if (retino?.intersects && retino.rows?.length) {
    out.push(`It crosses the visual pathway (${retino.rows.map((r) => r.name).join(", ")}).`);
  }
  const tracts = (tractModel?.atlasBreakdowns || []).flatMap((b) => b.rows)
    .sort((a, b) => b.pctRegion - a.pctRegion).slice(0, 3);
  if (tracts.length) out.push(`Tracts most affected: ${tracts.map((r) => `${r.regionName} (${pct(r.pctRegion)})`).join(", ")}.`);
  if (lnmResult) {
    const spec = lnmResult.specificity;
    const pos = spec?.run ? spec.n_sig_pos : lnmResult.n_pos_thr;
    const neg = spec?.run ? spec.n_sig_neg : lnmResult.n_neg_thr;
    if (pos != null) out.push(`Network: ${(pos ?? 0).toLocaleString()} voxels coupled to the lesion, ${(neg ?? 0).toLocaleString()} anticorrelated.`);
  }
  return out.join(" ") || null;
}

function glanceHtml(model, extras) {
  const text = glanceText(model, extras);
  return text ? escapeHtml(text) : null;
}

/** Visual-field maps, only when a retinotopy map actually found something —
 * without one they are empty discs. One per source loaded (white-matter
 * template, cortical Benson), each computed for the report's own lesion. */
function retinotopyImages(data) {
  if (!data.retinotopyFindings?.length) return [];
  return [
    data.wmVfMap2dDataUrl && { label: "Visual field — white-matter template", dot: "#f59e0b", imgUrl: data.wmVfMap2dDataUrl },
    data.vfMap2dDataUrl && { label: "Visual field — cortical (Benson)", dot: "#6366f1", imgUrl: data.vfMap2dDataUrl },
  ].filter(Boolean);
}

/**
 * @param {"lesion"|"tract"|"lnm"} kind
 * @param {object} data  kind-specific model (see each builder's JSDoc in
 *   sections.js) — for "lesion": the buildLesionReportModel() output, plus
 *   optional `lesionFigure` (lib/report/figures.js::lesionFigure output),
 *   vfMap2dDataUrl/wmVfMap2dDataUrl data-URLs (the 2D visual-field maps
 *   computed for this lesion — LesionMasksSection's vfMapFor) and optional
 *   `reportFragments` (lib/lesionReport.js::resolveReportFragments() output —
 *   lqtpy's morphometry-detail/network-rollup/disconnection sections, rendered
 *   after MRLatte's own); for "tract": the buildTractReportModel() output; for
 *   "lnm": { result, lesionName, images }.
 */
export function buildReport(kind, data) {
  if (kind === "lesion") {
    const images = retinotopyImages(data);
    const fragments = buildLqtpyFragmentSections(data.reportFragments);
    const sections = [
      buildFigureSection(null, data.lesionFigure),
      buildLesionStatsSection(data),
      { ...buildLesionAtlasSection(data), group: "Atlas overlap" },
      ...(data.retinotopyFindings?.length ? [
        { ...buildRetinotopySection(data.retinotopyFindings), title: null, group: "Visual field" },
        images.length ? { ...buildImagesSection(null, images), group: "Visual field" } : null,
      ] : []),
      ...fragments.map((s) => ({ ...s, group: "Detailed measures" })),
    ].filter(Boolean);
    return renderReportHtml({
      title: "Lesion report",
      subject: escapeHtml(data.lesionName || "(unnamed lesion)"),
      badge: "Atlas overlap" + (data.retinotopyFindings?.length ? " · visual field" : ""),
      generatedAt: data.generatedAt,
      extraStyle: lqtpyStylesheetCss(data.reportFragments),
      glance: glanceHtml(data, { retinotopyFindings: data.retinotopyFindings }),
      method: lesionMethodItems(data),
    }, sections);
  }
  if (kind === "tract") {
    return renderReportHtml({
      title: "Tract disconnection report",
      subject: escapeHtml(data.lesionName || "(unnamed lesion)"),
      badge: "Virtual dissection · S35 global tractogram · MNI152",
      generatedAt: data.generatedAt,
    }, buildTractSections(data));
  }
  if (kind === "lnm") {
    const { result, lesionName, images } = data;
    return renderReportHtml({
      title: "Lesion network mapping",
      subject: escapeHtml(lesionName || "(unnamed lesion)"),
      badge: "Degree-adjusted · HCP S1200 connectome",
      generatedAt: new Date().toISOString(),
    }, buildLnmSections(result, images));
  }
  throw new Error(`buildReport: unknown kind "${kind}"`);
}

/**
 * Compose the One-Click Summary report from whatever sub-results a run
 * produced (item 103: "an overall report with submodules used elsewhere") —
 * a thin orchestrator around the SAME section builders, driven by
 * OneClickSummaryPanel (which receives dissect/lnm info + asset URLs from the
 * backend). Any stage that didn't run (or wasn't requested) is simply omitted.
 *
 * @param {object} data
 * @param {string} data.lesionName
 * @param {object} [data.lesionModel]   buildLesionReportModel() output
 * @param {object} [data.reportFragments]  lib/lesionReport.js::
 *   resolveReportFragments() output for `data.lesionModel`'s lesion — same
 *   lqtpy sections the Lesion Report embeds. Ignored if `data.lesionModel` is absent.
 * @param {object} [data.tractModel]    buildTractReportModel() output (built
 *   by the caller from dissect_info via lib/htmlReport.js)
 * @param {object} [data.lnmResult]     the LNM worker's JSON result (lnm_info)
 * @param {object} [data.figures]  lib/report/figures.js output, embedded as
 *   PNG: { lesion, tracts, network } (each { src, caption } or absent), so a
 *   saved report is complete on its own
 * @param {{label,dot,imgUrl}[]} [data.extraImages]  the visual-field map, as
 *   a data URL
 * @param {object} [data.retino]  the summary worker's visual-pathway finding
 */
export function buildSummaryReport(data) {
  const figures = data.figures || {};
  const sections = [];
  if (data.lesionModel || figures.lesion) {
    sections.push({ ...buildFigureSection(null, figures.lesion), group: "Lesion" });
  }
  if (data.lesionModel) {
    sections.push({ ...buildLesionStatsSection(data.lesionModel), group: "Lesion" });
    sections.push({ ...buildLesionAtlasSection(data.lesionModel), group: "Atlas overlap" });
  }
  if (data.tractModel) {
    sections.push({ ...buildFigureSection(null, figures.tracts), group: "Tract disconnection" });
    sections.push(...buildTractSections(data.tractModel).map((s) => ({ ...s, group: "Tract disconnection" })));
  }
  if (data.lnmResult) {
    sections.push({ ...buildFigureSection(null, figures.network), group: "Network mapping" });
    // The worker's own images are interactive viewers served by the running
    // app; the figure above replaces them in the saved report.
    sections.push(...buildLnmSections(data.lnmResult, null).map((s) => ({ ...s, group: "Network mapping" })));
  }
  if (data.retino) {
    sections.push({
      group: "Visual pathway",
      html: `<div class="finding">${escapeHtml(data.retino.finding || "")}</div>`
        + (data.retino.rows?.length
          ? `<table class="data-table"><thead><tr><th>Visual-pathway tract</th><th class="num">Voxels hit</th><th class="num">% of tract</th><th class="num">% of lesion</th></tr></thead><tbody>${
              data.retino.rows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.hit_voxels}</td><td class="num">${r.pct_region}%</td><td class="num">${r.pct_lesion}%</td></tr>`).join("")
            }</tbody></table>`
          : ""),
    });
    if (data.extraImages?.length) sections.push({ ...buildImagesSection(null, data.extraImages), group: "Visual pathway" });
  }
  if (data.lesionModel) {
    sections.push(...buildLqtpyFragmentSections(data.reportFragments).map((s) => ({ ...s, group: "Detailed measures" })));
  }
  const ran = [data.lesionModel && "atlas overlap", data.tractModel && "tract disconnection",
    data.lnmResult && "network mapping", data.retino && "visual pathway"].filter(Boolean);
  return renderReportHtml({
    title: "Lesion analysis",
    // Credit, not branding: the feature is "LQTpy Analysis" in the app, but
    // the report keeps a plain heading and names it here, with the lqtpy
    // version when the overlap numbers actually came from lqtpy.
    subtitle: data.lesionModel?.provenance?.engine === "lqtpy"
      ? `Generated with LQTpy Analysis · lqtpy ${data.lesionModel.provenance.version || ""}`.trim()
      : "Generated with LQTpy Analysis",
    subject: escapeHtml(data.lesionName || "(unnamed lesion)"),
    badge: "Automated overall summary",
    generatedAt: new Date().toISOString(),
    extraStyle: lqtpyStylesheetCss(data.reportFragments),
    glance: glanceHtml(data.lesionModel, { retino: data.retino, tractModel: data.tractModel, lnmResult: data.lnmResult }),
    method: [
      // The backend's overlap model carries neither the run's lesion name nor
      // retinotopy findings (the visual pathway section covers that here).
      ...(data.lesionModel
        ? lesionMethodItems({ ...data.lesionModel, lesionName: data.lesionName || data.lesionModel.lesionName })
          .filter((i) => i && i.label !== "Retinotopy")
        : [{ label: "Lesion", value: escapeHtml(data.lesionName || "") }]),
      { label: "Analyses", value: ran.join(", ") || "none" },
    ],
  }, sections.filter((s) => s && (s.html || s.title)));
}
