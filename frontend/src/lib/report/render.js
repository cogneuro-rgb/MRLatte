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

export const REPORT_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  background: #eef2f7;
  color: #1a2035;
  min-height: 100vh;
  padding: 32px 20px 48px;
}

.page { max-width: 1180px; margin: 0 auto; }

.banner {
  background: linear-gradient(120deg, #0f172a 0%, #1e3a5f 55%, #1e4d8c 100%);
  color: white;
  border-radius: 16px 16px 0 0;
  padding: 28px 36px 22px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.banner h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; line-height: 1.2; }
.banner .subject { font-size: 13.5px; color: #94b8e0; margin-top: 6px; word-break: break-all; }
.banner .meta { text-align: right; font-size: 12.5px; color: #7aa3cc; white-space: nowrap; }
.banner .badge {
  display: inline-block; background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.22); border-radius: 20px;
  padding: 3px 12px; font-size: 11.5px; margin-top: 6px;
}

.body-card {
  background: white;
  border-radius: 0 0 16px 16px;
  padding: 28px 36px 36px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.08);
}

.section-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1px; color: #64748b;
  margin: 28px 0 12px; padding-bottom: 6px;
  border-bottom: 1px solid #e8edf5;
}
.section-title:first-child { margin-top: 0; }

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 900px) { .stat-grid { grid-template-columns: repeat(2,1fr); } }
.stat-card {
  border-left: 4px solid var(--accent, #2563eb);
  background: #f8fafc;
  border-radius: 0 10px 10px 0;
  padding: 14px 16px;
}
.stat-label { font-size: 11.5px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
.stat-value { font-size: 22px; font-weight: 700; color: #0f172a; margin: 4px 0 2px; line-height: 1.1; }
.stat-sub { font-size: 11px; color: #94a3b8; }

.param-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.pill {
  background: #f1f5f9; border: 1px solid #e2e8f0;
  border-radius: 20px; padding: 4px 12px; font-size: 12px; color: #475569;
}
.pill strong { color: #1e293b; }

.img-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 4px;
}
@media (max-width: 860px) { .img-grid { grid-template-columns: 1fr; } }

.img-panel {
  border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;
  background: #f8fafc; display: flex; flex-direction: column;
}
.img-panel-header {
  padding: 10px 16px; background: #f1f5f9; border-bottom: 1px solid #e2e8f0;
  display: flex; align-items: center; gap: 8px;
}
.img-panel-header .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.img-panel-header h3 { font-size: 13px; font-weight: 600; color: #334155; }
.img-panel-body {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 12px; min-height: 220px;
}
.img-panel-body img {
  max-width: 100%; max-height: 400px; object-fit: contain; display: block; border-radius: 6px;
}
.img-panel-body iframe {
  width: 100%; height: 480px; border: 0; display: block; border-radius: 6px;
}
.no-img { color: #94a3b8; font-size: 13px; text-align: center; padding: 20px; line-height: 1.8; }

.data-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: #f8fafc; border-radius: 10px; overflow: hidden;
  margin-top: 6px;
}
.data-table th {
  background: #1e293b; color: white; padding: 8px 12px;
  text-align: left; font-weight: 600; font-size: 12px;
}
.data-table td { padding: 6px 12px; border-bottom: 1px solid #e2e8f0; }
.data-table tr:last-child td { border-bottom: none; }
.data-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.data-table .empty-row td { text-align: center; color: #94a3b8; }

.finding {
  font-size: 14px; color: #334155; background: #eef4fb;
  border-left: 3px solid #2563a8; border-radius: 0 8px 8px 0;
  padding: 13px 18px; margin: 8px 0;
}

.disclaimer {
  margin-top: 10px; font-size: 11.5px; color: #b45309;
  background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 6px; padding: 8px 12px;
}

/* Quiet "not available" notes — e.g. an lqtpy report-fragment section that
   couldn't be computed (see lib/report/sections.js::buildLqtpyFragmentSections).
   Deliberately understated (not .disclaimer's amber warning treatment):
   these are expected, unremarkable states (an index not built locally, an
   atlas with no network grouping), not something gone wrong. */
.quiet-note {
  margin: 10px 0; font-size: 12px; color: #94a3b8;
  background: #f8fafc; border: 1px dashed #e2e8f0;
  border-radius: 8px; padding: 8px 12px;
}

.footer {
  margin-top: 32px; text-align: center; font-size: 12px;
  color: #94a3b8; line-height: 1.8;
}

details.collapsible {
  margin-top: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
}
details.collapsible summary {
  cursor: pointer;
  padding: 10px 16px;
  background: #f1f5f9;
  font-size: 12px; font-weight: 600; color: #475569;
  text-transform: uppercase; letter-spacing: 0.5px;
  list-style: none;
  display: flex; align-items: center; justify-content: space-between;
  user-select: none;
}
details.collapsible summary::-webkit-details-marker { display: none; }
details.collapsible summary::after {
  content: "\\25B6";
  font-size: 10px; color: #94a3b8;
  transition: transform 0.2s;
}
details.collapsible[open] summary::after { transform: rotate(90deg); }
details.collapsible .collapsible-inner { padding: 12px; background: #f8fafc; }

@media print {
  body { background: white; padding: 0; }
  .page { max-width: 100%; }
  .banner { border-radius: 0; }
  .body-card { border-radius: 0; box-shadow: none; }
  details.collapsible[open], details.collapsible { display: block; }
}`;

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/** Grid of stat cards. `cards` = [{ label, value, sub, accent }]. */
export function statCardsHtml(cards) {
  return `
    <div class="stat-grid">
      ${cards.map((c) => `
      <div class="stat-card" style="--accent:${c.accent || "#2563eb"}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub || ""}</div>
      </div>`).join("")}
    </div>`;
}

/** Row of labeled pills. `pills` = [{ label, value }]. */
export function pillRowHtml(pills) {
  return `<div class="param-row">${pills
    .map((p) => `<span class="pill"><strong>${p.label}:</strong> ${p.value}</span>`)
    .join("")}</div>`;
}

/** Generic data table. `columns` = [{ key, label, numeric }], `rows` = [{...}]. */
export function dataTableHtml(columns, rows) {
  const head = columns.map((c) => `<th${c.numeric ? ' class="num"' : ""}>${c.label}</th>`).join("");
  const body = rows.length
    ? rows.map((r) => `<tr>${columns
        .map((c) => `<td${c.numeric ? ' class="num"' : ""}>${r[c.key] ?? ""}</td>`)
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

/**
 * Compose the full standalone HTML document. `meta` = { title, subject,
 * badge, extraStyle }. `sections` = [{ title, html }] — rendered in order,
 * each under its own .section-title heading (omit `title` to render bare,
 * e.g. for a section that already emits its own heading, like image-grid
 * subsections or an embedded lqtpy fragment). `extraStyle`, if given, is raw
 * CSS embedded in its own <style> tag ONCE (e.g. lqtpy's
 * `fragments.stylesheet()` — see lib/report/sections.js::lqtpyStylesheetCss)
 * — pass it once per document regardless of how many fragment sections use it.
 */
export function renderReportHtml({ title, subject, badge, generatedAt, footer, extraStyle }, sections) {
  const body = sections
    .map((s) => (s.title ? `<div class="section-title">${s.title}</div>\n${s.html}` : s.html))
    .join("\n\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}${subject ? ` — ${subject}` : ""}</title>
  <style>${REPORT_CSS}</style>
  ${extraStyle ? `<style>${extraStyle}</style>` : ""}
</head>
<body>
<div class="page">

  <div class="banner">
    <div>
      <h1>${title}</h1>
      ${subject ? `<div class="subject">${subject}</div>` : ""}
    </div>
    <div class="meta">
      <div>Generated: ${fmtDate(generatedAt || new Date().toISOString())}</div>
      ${badge ? `<span class="badge">${badge}</span>` : ""}
    </div>
  </div>

  <div class="body-card">
    ${body}
    <div class="footer">
      ${footer || `<div>MRLatte · automated analysis — for research and clinical review only. Not a standalone diagnostic.</div>`}
    </div>
  </div>
</div>
</body>
</html>`;
}
