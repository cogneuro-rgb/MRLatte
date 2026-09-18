// Item 103 — single entry point composing a full report document from a
// data model + kind, reusing lib/report/sections.js's builders (the same
// ones each individual panel uses) so every report type shares one
// implementation per section. See lib/report/render.js for the page shell.

import { renderReportHtml } from "@/lib/report/render";
import {
  buildLesionStatsSection, buildLesionAtlasSection, buildRetinotopySection,
  buildTractSections, buildLnmSections, buildImagesSection,
  buildLqtpyFragmentSections, lqtpyStylesheetCss,
} from "@/lib/report/sections";

/**
 * @param {"lesion"|"tract"|"lnm"} kind
 * @param {object} data  kind-specific model (see each builder's JSDoc in
 *   sections.js) — for "lesion": the buildLesionReportModel() output, plus
 *   optional polarDiscDataUrl/vfMap2dDataUrl/wmPolarDiscDataUrl/
 *   wmVfMap2dDataUrl data-URLs (LesionReportPanel's own retinotopy disc
 *   exports) and optional `reportFragments` (lib/lesionReport.js::
 *   resolveReportFragments() output — lqtpy's morphometry-detail/network-
 *   rollup/disconnection sections, rendered after MRLatte's own); for
 *   "tract": the buildTractReportModel() output; for "lnm":
 *   { result, lesionName, images }.
 */
export function buildReport(kind, data) {
  if (kind === "lesion") {
    const images = [
      data.wmVfMap2dDataUrl && { label: "WM Retinotopy — 2D Map", dot: "#f59e0b", imgUrl: data.wmVfMap2dDataUrl },
      data.wmPolarDiscDataUrl && !data.wmVfMap2dDataUrl && { label: "WM Retinotopy — Polar Disc", dot: "#f59e0b", imgUrl: data.wmPolarDiscDataUrl },
      data.polarDiscDataUrl && { label: "Benson Polar Angle Disc", dot: "#6366f1", imgUrl: data.polarDiscDataUrl },
      data.vfMap2dDataUrl && { label: "Benson Visual Field 2D Map", dot: "#8b5cf6", imgUrl: data.vfMap2dDataUrl },
    ].filter(Boolean);
    const sections = [
      buildLesionStatsSection(data),
      images.length ? buildImagesSection("Retinotopic Connectivity Imagery", images) : null,
      buildLesionAtlasSection(data),
      buildRetinotopySection(data.retinotopyFindings),
      ...buildLqtpyFragmentSections(data.reportFragments),
    ].filter(Boolean);
    return renderReportHtml({
      title: "MRLatte Lesion Report",
      subject: data.lesionName || "(unnamed lesion)",
      badge: "Retinotopic + atlas analysis",
      generatedAt: data.generatedAt,
      extraStyle: lqtpyStylesheetCss(data.reportFragments),
    }, sections);
  }
  if (kind === "tract") {
    return renderReportHtml({
      title: "MRLatte Tract Disconnection Report",
      subject: data.lesionName || "(unnamed lesion)",
      badge: "Virtual dissection · S35 global tractogram · MNI152",
      generatedAt: data.generatedAt,
    }, buildTractSections(data));
  }
  if (kind === "lnm") {
    const { result, lesionName, images } = data;
    return renderReportHtml({
      title: "MRLatte Degree-Adjusted Lesion Network Mapping",
      subject: lesionName || "(unnamed lesion)",
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
 * OneClickSummaryPanel (which already holds the lesion overlap model
 * client-side and receives dissect/lnm info + asset URLs from the backend).
 * Any stage that didn't run (or wasn't requested) is simply omitted.
 *
 * @param {object} data
 * @param {string} data.lesionName
 * @param {object} [data.lesionModel]   buildLesionReportModel() output
 * @param {object} [data.reportFragments]  lib/lesionReport.js::
 *   resolveReportFragments() output for `data.lesionModel`'s lesion — same
 *   lqtpy sections the Lesion Report embeds, rendered right after the lesion
 *   stats/atlas-overlap sections below. Ignored if `data.lesionModel` is absent.
 * @param {object} [data.tractModel]    buildTractReportModel() output (built
 *   by the caller from dissect_info via lib/htmlReport.js)
 * @param {object} [data.lnmResult]     the LNM worker's JSON result (lnm_info)
 * @param {object} [data.lnmImages]     { primary, support } from the LNM run
 *   (One-Click Summary's dissect/lnm stages don't request make_html figures
 *   today, so this is typically absent — the section is skipped when so)
 * @param {{label,dot,imgUrl,iframeUrl}[]} [data.extraImages]  brainsprite /
 *   retinotopy-disc assets the summary worker rendered, embedded by URL
 * @param {object} [data.retino]  the summary worker's visual-pathway finding
 */
export function buildSummaryReport(data) {
  const sections = [];
  if (data.lesionModel) {
    sections.push(buildLesionStatsSection(data.lesionModel));
    sections.push(buildLesionAtlasSection(data.lesionModel));
    sections.push(...buildLqtpyFragmentSections(data.reportFragments));
  }
  if (data.extraImages?.length) {
    sections.push(buildImagesSection("Renderings", data.extraImages));
  }
  if (data.tractModel) {
    sections.push(...buildTractSections(data.tractModel));
  }
  if (data.lnmResult) {
    sections.push(...buildLnmSections(data.lnmResult, data.lnmImages));
  }
  if (data.retino) {
    sections.push({
      title: "Retinotopy",
      html: `<div class="finding">${data.retino.finding || ""}</div>`
        + (data.retino.rows?.length
          ? `<table class="data-table"><thead><tr><th>Visual-pathway tract</th><th class="num">Voxels hit</th><th class="num">% of tract</th><th class="num">% of lesion</th></tr></thead><tbody>${
              data.retino.rows.map((r) => `<tr><td>${r.name}</td><td class="num">${r.hit_voxels}</td><td class="num">${r.pct_region}%</td><td class="num">${r.pct_lesion}%</td></tr>`).join("")
            }</tbody></table>`
          : ""),
    });
  }
  return renderReportHtml({
    title: "MRLatte One-Click Summary",
    subject: data.lesionName || "(unnamed lesion)",
    badge: "Automated overall summary",
    generatedAt: new Date().toISOString(),
    extraStyle: lqtpyStylesheetCss(data.reportFragments),
  }, sections);
}
