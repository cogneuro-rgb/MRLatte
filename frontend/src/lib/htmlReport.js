// Tract-dissection report DATA MODEL only (item 103) — HTML generation for
// every report type now lives in lib/report/ (render.js's shared shell,
// sections.js's builders, index.js's buildReport()). This file's job is
// purely transforming a dissection worker result into the shape
// lib/report/sections.js::buildTractSections expects; it has no HTML in it.

// Display names for `result.atlas_overlap`'s keys. The worker keys each table
// by the atlas's pre-revamp id where it has one (deps._atlas_specs_for), so
// these stay as they were; any atlas without an entry — a catalog install, a
// user import — falls back to its own id, which is already human-readable.
export const ATLAS_KEY_NAMES = {
  ho_cort: "Harvard-Oxford Cortical",
  ho_sub: "Harvard-Oxford Subcortical",
  hcp1065: "HCP1065 Named Tracts",
  hcp842: "HCP842 Named Tracts",
  iit: "IIT Named Tracts",
  jhu: "JHU White Matter",
  juelich: "Jülich",
  aal: "AAL",
  destrieux: "Destrieux",
  yeo7: "Yeo-7 Networks",
  visfatlas: "visfAtlas",
};

// Cap per-atlas rows in the report for readability.
export const MAX_REPORT_ROWS = 25;

export function buildTractReportModel(result, lesionName) {
  const overlap = result.atlas_overlap || {};
  const atlasBreakdowns = Object.keys(overlap)
    .map((key) => ({
      atlasName: ATLAS_KEY_NAMES[key] || key,
      rows: (overlap[key] || []).slice(0, MAX_REPORT_ROWS).map((r) => ({
        regionName: r.name,
        hitVoxels: r.hit_voxels,
        regionVoxels: r.region_voxels,
        pctRegion: r.pct_region,
        streamlineDensity: r.streamline_density,
      })),
    }))
    .filter((b) => b.rows.length > 0);

  return {
    lesionName: lesionName || "(unnamed)",
    generatedAt: new Date().toISOString(),
    nInputStreamlines: result.n_input_streamlines,
    nSelectedStreamlines: result.n_selected_streamlines,
    pctSelected: (100 * result.n_selected_streamlines / result.n_input_streamlines).toFixed(1),
    affectedVoxels: result.affected_voxels,
    tractVolumeCm3: result.tract_volume_cm3,
    densityMax: result.density_max,
    atlasBreakdowns,
  };
}
