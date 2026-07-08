function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function statsCards(model) {
  const v = model.volume;
  const c = v?.centroidMM;
  const totalAtlasRegions = model.atlasBreakdowns.reduce((n, b) => n + b.rows.length, 0);
  const cards = [
    {
      label: "Lesion Volume",
      value: v ? v.cm3.toFixed(2) : "—",
      sub: "cm³",
      accent: "#2563eb",
    },
    {
      label: "Voxel Count",
      value: v ? v.voxelCount.toLocaleString() : "—",
      sub: "voxels",
      accent: "#7c3aed",
    },
    {
      label: "MNI Centroid",
      value: c ? `[${c[0].toFixed(0)}, ${c[1].toFixed(0)}, ${c[2].toFixed(0)}]` : "—",
      sub: "mm (x, y, z)",
      accent: "#0891b2",
    },
    {
      label: "Atlas Regions",
      value: totalAtlasRegions,
      sub: `across ${model.atlasBreakdowns.length} atlas(es)`,
      accent: "#059669",
    },
  ];
  return `
    <div class="stat-grid">
      ${cards.map(c => `
      <div class="stat-card" style="--accent:${c.accent}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`).join("")}
    </div>`;
}

function paramPills(model) {
  const pills = [];
  pills.push(`<span class="pill"><strong>Lesion:</strong> ${model.lesionName || "(unnamed)"}</span>`);
  for (const b of model.atlasBreakdowns) {
    pills.push(`<span class="pill"><strong>Atlas:</strong> ${b.atlasName}</span>`);
  }
  const hasRetino = model.retinotopyFindings?.length > 0;
  pills.push(`<span class="pill"><strong>Retinotopy:</strong> ${hasRetino ? "Yes" : "None loaded"}</span>`);
  return `<div class="param-row">${pills.join("")}</div>`;
}

function imgPanel(title, dotColor, imgTag) {
  return `
    <div class="img-panel">
      <div class="img-panel-header">
        <div class="dot" style="background:${dotColor};"></div>
        <h3>${title}</h3>
      </div>
      <div class="img-panel-body">${imgTag}</div>
    </div>`;
}

function atlasTable(breakdown) {
  const total = breakdown.rows.reduce((s, r) => s + r.voxelCount, 0);
  const rows = breakdown.rows.map(r => `
      <tr>
        <td>${r.regionName}</td>
        <td class="num">${r.voxelCount}</td>
        <td class="num">${r.percentOfLesion.toFixed(1)}%</td>
        <td class="num">${r.percentOfRegion.toFixed(1)}%</td>
      </tr>`).join("");
  const emptyRow = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;">No data</td></tr>`;
  return `
    <div class="section-title">${breakdown.atlasName}</div>
    <table class="atlas-table">
      <thead><tr>
        <th>Region</th>
        <th class="num">Voxels</th>
        <th class="num">% of Lesion</th>
        <th class="num">% of Region</th>
      </tr></thead>
      <tbody>${rows || emptyRow}</tbody>
    </table>`;
}

function retinotopyTable(findings) {
  if (!findings?.length) return "";
  const rows = findings.map(f => `
      <tr>
        <td>${f.name}</td>
        <td>${f.kind}</td>
        <td>${f.summary || "—"}</td>
        <td>${f.illustrative ? "Population template" : "Cortical"}</td>
      </tr>`).join("");
  return `
    <div class="section-title">Retinotopy Findings</div>
    <table class="atlas-table">
      <thead><tr>
        <th>Map</th><th>Kind</th><th>Summary</th><th>Type</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const CSS = `
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
.no-img { color: #94a3b8; font-size: 13px; text-align: center; padding: 20px; line-height: 1.8; }

.atlas-table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: #f8fafc; border-radius: 10px; overflow: hidden;
  margin-top: 6px;
}
.atlas-table th {
  background: #1e293b; color: white; padding: 8px 12px;
  text-align: left; font-weight: 600; font-size: 12px;
}
.atlas-table td { padding: 6px 12px; border-bottom: 1px solid #e2e8f0; }
.atlas-table tr:last-child td { border-bottom: none; }
.atlas-table td.num { text-align: right; font-variant-numeric: tabular-nums; }

.disclaimer {
  margin-top: 10px; font-size: 11.5px; color: #b45309;
  background: #fffbeb; border: 1px solid #fde68a;
  border-radius: 6px; padding: 8px 12px;
}

.footer {
  margin-top: 32px; text-align: center; font-size: 12px;
  color: #94a3b8; line-height: 1.8;
}

details.benson-details {
  margin-top: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
}
details.benson-details summary {
  cursor: pointer;
  padding: 10px 16px;
  background: #f1f5f9;
  font-size: 12px; font-weight: 600; color: #475569;
  text-transform: uppercase; letter-spacing: 0.5px;
  list-style: none;
  display: flex; align-items: center; justify-content: space-between;
  user-select: none;
}
details.benson-details summary::-webkit-details-marker { display: none; }
details.benson-details summary::after {
  content: "▶";
  font-size: 10px; color: #94a3b8;
  transition: transform 0.2s;
}
details.benson-details[open] summary::after { transform: rotate(90deg); }
details.benson-details .benson-inner {
  padding: 12px;
  background: #f8fafc;
}

@media print {
  body { background: white; padding: 0; }
  .page { max-width: 100%; }
  .banner { border-radius: 0; }
  .body-card { border-radius: 0; box-shadow: none; }
  details.benson-details[open], details.benson-details { display: block; }
}`;

// ---------------------------------------------------------------------------
// Tract-dissection report helpers (private)
// ---------------------------------------------------------------------------

function tractAtlasTable(breakdown) {
  if (!breakdown.rows.length) return "";
  const rows = breakdown.rows.map(r => `
      <tr>
        <td>${r.regionName}</td>
        <td class="num">${r.hitVoxels.toLocaleString()}</td>
        <td class="num">${r.pctRegion.toFixed(1)}%</td>
        <td class="num">${(r.streamlineDensity ?? 0).toLocaleString()}</td>
      </tr>`).join("");
  return `
    <div class="section-title">${breakdown.atlasName}</div>
    <table class="atlas-table">
      <thead><tr>
        <th>Region</th>
        <th class="num">Hit Voxels</th>
        <th class="num">% of Region</th>
        <th class="num">Streamline Density</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Lesion report (original)
// ---------------------------------------------------------------------------

export function generateLesionReportHtml(model, {
  polarDiscDataUrl = null,
  vfMap2dDataUrl = null,
  wmPolarDiscDataUrl = null,
  wmVfMap2dDataUrl = null,
} = {}) {
  const subject = model.lesionName || "(unnamed lesion)";
  const generated = fmtDate(model.generatedAt);

  // WM primary image: prefer 2D map if captured, fall back to polar disc
  const wmImgTag = wmVfMap2dDataUrl
    ? `<img src="${wmVfMap2dDataUrl}" alt="WM retinotopy 2D map">`
    : wmPolarDiscDataUrl
      ? `<img src="${wmPolarDiscDataUrl}" alt="WM retinotopy polar disc">`
      : `<div class="no-img">WM template image not available<br><small>Ensure the brainlife WM retinotopy maps are loaded</small></div>`;

  // Benson collapsible images
  const bensonDiscTag = polarDiscDataUrl
    ? `<img src="${polarDiscDataUrl}" alt="Benson polar angle disc">`
    : `<div class="no-img">Polar disc not available<br><small>Load Benson retinotopy to include</small></div>`;

  const bensonVfTag = vfMap2dDataUrl
    ? `<img src="${vfMap2dDataUrl}" alt="Benson VF 2D map">`
    : `<div class="no-img">VF 2D map not available<br><small>Switch to 2D map view before exporting</small></div>`;

  const atlasTables = model.atlasBreakdowns.length
    ? model.atlasBreakdowns.map(atlasTable).join("\n")
    : `<p style="color:#94a3b8;font-size:13px;">No atlas selected for this report.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NeuroVue Report — ${subject}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="page">

  <div class="banner">
    <div>
      <h1>NeuroVue Lesion Report</h1>
      <div class="subject">${subject}</div>
    </div>
    <div class="meta">
      <div>Generated: ${generated}</div>
      <span class="badge">Retinotopic + atlas analysis</span>
    </div>
  </div>

  <div class="body-card">

    <div class="section-title">Key Statistics</div>
    ${statsCards(model)}

    <div class="section-title">Analysis Parameters</div>
    ${paramPills(model)}

    <div class="section-title">Retinotopic Connectivity Template (brainlife)</div>
    ${imgPanel("WM Retinotopy — Population Template", "#f59e0b", wmImgTag)}

    <details class="benson-details">
      <summary>Benson Cortical Retinotopy (Benson atlas)</summary>
      <div class="benson-inner">
        <div class="img-grid">
          ${imgPanel("Polar Angle Disc", "#6366f1", bensonDiscTag)}
          ${imgPanel("Visual Field 2D Map", "#8b5cf6", bensonVfTag)}
        </div>
      </div>
    </details>

    <div class="section-title">Atlas Overlap</div>
    ${atlasTables}

    ${retinotopyTable(model.retinotopyFindings)}

    <div class="footer">
      <div>NeuroVue · NiivueViewer · Benson retinotopy atlas · Wang / visfAtlas / Harvard‑Oxford</div>
      <div>⚠ Automated analysis — for research and clinical review only. Not a standalone diagnostic.</div>
    </div>

  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tract disconnection report
// ---------------------------------------------------------------------------

export function generateTractReportHtml(model) {
  const subject = model.lesionName || "(unnamed lesion)";
  const generated = fmtDate(model.generatedAt);

  const cards = [
    { label: "Selected Streamlines", value: model.nSelectedStreamlines.toLocaleString(),
      sub: `${model.pctSelected}% of ${model.nInputStreamlines.toLocaleString()} total`, accent: "#2563eb" },
    { label: "Tract Volume", value: model.tractVolumeCm3.toFixed(3), sub: "cm³", accent: "#7c3aed" },
    { label: "Affected Voxels", value: model.affectedVoxels.toLocaleString(), sub: "voxels", accent: "#0891b2" },
    { label: "Regions Hit", value: model.atlasBreakdowns.reduce((n, b) => n + b.rows.length, 0),
      sub: (model.atlasBreakdowns.map((b) => b.atlasName).join(", ") || "atlas regions"), accent: "#059669" },
  ];
  const statsHtml = `
    <div class="stat-grid">
      ${cards.map(c => `
      <div class="stat-card" style="--accent:${c.accent}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`).join("")}
    </div>`;

  const atlasTables = model.atlasBreakdowns.length
    ? model.atlasBreakdowns.map(tractAtlasTable).join("\n")
    : `<p style="color:#94a3b8;font-size:13px;">No atlas overlap found.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NeuroVue Tract Disconnection Report — ${subject}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="page">
  <div class="banner">
    <div>
      <h1>NeuroVue Tract Disconnection Report</h1>
      <div class="subject">${subject}</div>
    </div>
    <div class="meta">
      <div>Generated: ${generated}</div>
      <span class="badge">Virtual dissection · S35 global tractogram · MNI152</span>
    </div>
  </div>
  <div class="body-card">
    <div class="section-title">Key Statistics</div>
    ${statsHtml}
    <div class="section-title">Atlas Disconnection</div>
    ${atlasTables}
    <div class="footer">
      <div>NeuroVue · BCB Toolkit-style virtual dissection</div>
      <div>⚠ Automated analysis — for research and clinical review only. Not a standalone diagnostic.</div>
    </div>
  </div>
</div>
</body>
</html>`;
}
