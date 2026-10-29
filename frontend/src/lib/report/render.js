// Shared HTML shell + CSS for every MRLatte report (item 103). One renderer,
// reused by the lesion / tract / LNM / one-click-summary reports — extracted
// and generalized from the previous per-report generators in htmlReport.js
// (CSS, banner/body-card layout, stat-card grid) so all four reports read as
// one visual system instead of four independently-styled documents.
//
// A "section" is { title, html } — `html` is the section's own inner markup
// (built by lib/report/sections.js); this module only owns the page shell,
// the shared CSS, and the stat-card/pill/table primitives sections are built
// from.

import { reportFontCss } from "./fonts";

export const REPORT_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* A printed document, so always the light ("Oat") palette, whatever the app's
   theme. Ink, two text tiers (both >= 4.5:1 on white), hairlines, the Crema
   accent, and lesion red for overlap bars. */
:root {
  --ink: #1D1B18; --ink2: #57524A; --muted: #6F695F;
  --rule: #E3DED5; --rule2: #ECE8E0; --surface: #FAF8F4; --track: #F2EFE9;
  --accent: #8A4E15; --tint: #F6EADB; --bar: #C5432F;
  --sans: "Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
}

body {
  font-family: var(--sans);
  font-size: 13.5px;
  background: #F2EFE9;
  color: var(--ink);
  padding: 28px 16px 48px;
  line-height: 1.45;
}

.page {
  max-width: 1000px; margin: 0 auto; background: white;
  border-radius: 4px; box-shadow: 0 0 0 1px rgba(29,27,24,0.08), 0 12px 32px rgba(29,27,24,0.10);
  padding: 52px 64px 44px;
}
@media (max-width: 760px) { .page { padding: 32px 24px 32px; } }

/* Header: what this is, about whom, when. */
.head {
  display: flex; justify-content: space-between; gap: 24px; align-items: flex-start;
  padding-bottom: 20px; border-bottom: 2px solid var(--ink);
}
.head h1 { font-size: 30px; font-weight: 600; letter-spacing: -0.015em; line-height: 36px; }
.head .subtitle { font-size: 12px; color: var(--muted); margin-top: 4px; }
.head .subject { font-size: 13.5px; font-weight: 500; color: var(--ink); margin-top: 6px; word-break: break-all; }
.head .meta {
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  text-align: right; font-size: 12px; color: var(--ink2); white-space: nowrap;
}
.head .badge {
  display: inline-block; padding: 3px 9px; border-radius: 999px;
  background: var(--tint); color: var(--accent); font-size: 12px; font-weight: 600;
}

/* The answer first: one paragraph saying what was found. */
.glance {
  margin: 22px 0 8px; max-width: 800px;
  font-size: 16px; line-height: 25px; color: var(--ink);
}

h2.group {
  font-size: 18px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink);
  margin: 30px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
}
.section-title {
  font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted); margin: 22px 0 10px;
}

.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
@media (max-width: 760px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
.stat-card { border-radius: 8px; box-shadow: inset 0 0 0 1px var(--rule); padding: 12px 14px; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value {
  font-size: 22px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink);
  margin: 2px 0 1px; line-height: 1.2; font-variant-numeric: tabular-nums;
}
.stat-sub { font-size: 11.5px; color: var(--muted); }

/* Figures drawn from the volumes (lib/report/figures.js), embedded as PNG.
   Scan images keep a black well, as in the viewer. */
.report-figure { margin: 6px 0 4px; }
.report-figure img { display: block; width: 100%; border-radius: 6px; background: #000; }
.report-figure figcaption { font-size: 11.5px; color: var(--muted); margin-top: 6px; line-height: 1.5; }

.img-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 4px; }
@media (max-width: 760px) { .img-grid { grid-template-columns: 1fr; } }
.img-panel { border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; background: white; display: flex; flex-direction: column; }
.img-panel-header { padding: 8px 14px; border-bottom: 1px solid var(--rule); display: flex; align-items: center; gap: 8px; }
.img-panel-header .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.img-panel-header h3 { font-size: 12.5px; font-weight: 600; color: var(--ink); }
.img-panel-body { flex: 1; display: flex; align-items: center; justify-content: center; padding: 10px; min-height: 200px; }
.img-panel-body img { max-width: 100%; max-height: 380px; object-fit: contain; display: block; }
.img-panel-body iframe { width: 100%; height: 460px; border: 0; display: block; }
.no-img { color: var(--muted); font-size: 13px; text-align: center; padding: 20px; line-height: 1.8; }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px; }
.data-table th {
  color: var(--muted); padding: 0 10px 6px; text-align: left;
  font-weight: 500; font-size: 12px; border-bottom: 1px solid var(--rule);
}
.data-table td { padding: 8px 10px; border-bottom: 1px solid var(--rule2); vertical-align: middle; }
.data-table th:first-child, .data-table td:first-child { padding-left: 0; }
.data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.data-table td.num { font-family: var(--mono); font-size: 12.5px; color: var(--ink2); }
.data-table .empty-row td { text-align: center; color: var(--muted); }
.bar { display: flex; align-items: center; gap: 10px; justify-content: flex-end; font-variant-numeric: tabular-nums; }
.bar .track { width: 90px; height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
.bar .fill { display: block; height: 100%; background: var(--bar); border-radius: 3px; }

.finding {
  font-size: 14px; color: var(--ink); background: var(--surface);
  border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; padding: 12px 16px; margin: 8px 0;
}
.disclaimer {
  margin-top: 10px; font-size: 12px; color: #7A6000;
  background: #FBF4DC; border: 1px solid #EED98A; border-radius: 6px; padding: 8px 12px;
}
/* Quiet "not available" notes: expected states, not errors. */
.quiet-note { margin: 8px 0; font-size: 12px; color: var(--muted); }
.quiet-note details { display: inline; }
.quiet-note summary { display: inline; cursor: pointer; text-decoration: underline dotted; list-style: none; }
.quiet-note summary::-webkit-details-marker { display: none; }
.quiet-note .why { display: block; margin-top: 4px; }

details.more { margin-top: 8px; }
details.more > summary { cursor: pointer; font-size: 12.5px; color: var(--accent); padding: 4px 0; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "+ "; }
details.more[open] > summary::before { content: "\\2212  "; }

details.collapsible { margin-top: 16px; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
details.collapsible summary {
  cursor: pointer; padding: 9px 14px; background: var(--surface); font-size: 12px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.08em; list-style: none;
}
details.collapsible summary::-webkit-details-marker { display: none; }
details.collapsible .collapsible-inner { padding: 12px; }

/* How it was made: engine, atlases, inputs. Last, small. */
.method { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; color: var(--ink2); margin-top: 8px; }
.method dt { color: var(--muted); }
.method dd { color: var(--ink); }

.footer { margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--rule); text-align: center; font-size: 11.5px; color: var(--muted); line-height: 1.7; }

/* lqtpy's fragments theme themselves through --lqt-* on .lqt-root; this more
   specific rule gives them the report's neutrals (its severity colours stay). */
.page .lqt-root {
  --lqt-text: #1D1B18; --lqt-muted: #6F695F; --lqt-border: #E3DED5;
  --lqt-surface: #FAF8F4; --lqt-stripe: #F7F4EF;
}

@page { size: A4; margin: 12mm; }
@media print {
  body { background: white; padding: 0; }
  .page { max-width: none; box-shadow: none; border-radius: 0; padding: 0; }
  .report-figure, .stat-grid, .img-panel, .glance, tr { break-inside: avoid; }
  h2.group, .section-title { break-after: avoid; }
  details.more > summary, details.collapsible > summary { display: none; }
}`;

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/** Grid of stat cards. `cards` = [{ label, value, sub }]. */
export function statCardsHtml(cards) {
  return `
    <div class="stat-grid">
      ${cards.map((c) => `
      <div class="stat-card">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub || ""}</div>
      </div>`).join("")}
    </div>`;
}

/** Generic data table. `columns` = [{ key, label, numeric, render }] —
 * `render(row)`, if given, returns the cell's HTML; `rows` = [{...}]. */
export function dataTableHtml(columns, rows) {
  const head = columns.map((c) => `<th${c.numeric ? ' class="num"' : ""}>${c.label}</th>`).join("");
  const body = rows.length
    ? rows.map((r) => `<tr>${columns
        .map((c) => `<td${c.numeric ? ' class="num"' : ""}>${c.render ? c.render(r) : (r[c.key] ?? "")}</td>`)
        .join("")}</tr>`).join("")
    : `<tr class="empty-row"><td colspan="${columns.length}">No data</td></tr>`;
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Single image/iframe panel. `bodyHtml` is either an <img>/<iframe> tag or a .no-img fallback. */
export function imgPanelHtml(title, dotColor, bodyHtml) {
  return `
    <div class="img-panel">
      <div class="img-panel-header">
        <div class="dot" style="background:${dotColor};"></div>
        <h3>${title}</h3>
      </div>
      <div class="img-panel-body">${bodyHtml}</div>
    </div>`;
}

/** A figure from lib/report/figures.js: { src, caption }. */
export function figureHtml(fig) {
  if (!fig?.src) return "";
  return `<figure class="report-figure"><img src="${fig.src}" alt="">${
    fig.caption ? `<figcaption>${fig.caption}</figcaption>` : ""}</figure>`;
}

/** A percentage with a bar, for "% of lesion"-style columns. */
export function barHtml(pct) {
  const v = Number(pct) || 0;
  return `<div class="bar"><span>${v.toFixed(1)}%</span><span class="track"><span class="fill" style="width:${Math.max(0, Math.min(100, v))}%"></span></span></div>`;
}

/** The "how it was made" list: `items` = [{ label, value }], value as HTML. */
export function methodHtml(items) {
  const rows = (items || []).filter((i) => i && i.value != null && i.value !== "");
  if (!rows.length) return "";
  return `<dl class="method">${rows.map((i) => `<dt>${i.label}</dt><dd>${i.value}</dd>`).join("")}</dl>`;
}

/**
 * Compose the full standalone HTML document. `meta` = { title, subtitle,
 * subject, badge, generatedAt, footer, extraStyle, glance, method }:
 * `glance` is the one-paragraph answer shown first (HTML); `method` the
 * [{ label, value }] list shown last under "Method". `sections` =
 * [{ title, html, group }], rendered in order: a section with a `group` starts
 * a new analysis heading (h2) when it differs from the previous one; `title`
 * is the small heading above the section's own html (omit it to render bare,
 * e.g. an lqtpy fragment with its own heading). `extraStyle` (lqtpy's
 * fragment stylesheet) is embedded once.
 */
export function renderReportHtml({ title, subtitle, subject, badge, generatedAt, footer, extraStyle, glance, method }, sections) {
  let group = null;
  const body = sections.map((s) => {
    let out = "";
    if (s.group && s.group !== group) {
      group = s.group;
      out += `<h2 class="group">${s.group}</h2>\n`;
    }
    out += s.title ? `<div class="section-title">${s.title}</div>\n${s.html || ""}` : (s.html || "");
    return out;
  }).join("\n\n");
  const methodBlock = methodHtml(method);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}${subject ? ` — ${subject}` : ""}</title>
  ${reportFontCss() ? `<style>${reportFontCss()}</style>` : ""}
  <style>${REPORT_CSS}</style>
  ${extraStyle ? `<style>${extraStyle}</style>` : ""}
</head>
<body>
<div class="page">
  <div class="head">
    <div>
      <h1>${title}</h1>
      ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ""}
      ${subject ? `<div class="subject">${subject}</div>` : ""}
    </div>
    <div class="meta">
      <div>${fmtDate(generatedAt || new Date().toISOString())}</div>
      ${badge ? `<span class="badge">${badge}</span>` : ""}
    </div>
  </div>
  ${glance ? `<div class="glance">${glance}</div>` : ""}
  ${body}
  ${methodBlock ? `<h2 class="group">Method</h2>${methodBlock}` : ""}
  <div class="footer">
    ${footer || "MRLatte · automated analysis — for research and clinical review only. Not a standalone diagnostic."}
  </div>
</div>
</body>
</html>`;
}
