// One-click structured lesion report. Reuses computeAtlasOverlap (affine-aware
// lesion∩atlas) from volumeAnalysis.js. PDF/text rendering is done in the
// renderer (data is already in-memory; no backend round-trip).

import { computeAtlasOverlap, getDims } from "@/lib/volumeAnalysis";
import {
  computeVoxelCounts, affectedSet, mergeRanges, classifyHemifield, buildSummary,
} from "@/lib/retinotopyAnalysis";

// Regions covering less than this percent of the lesion are omitted from the
// prose summary as noise (the detailed TXT/PDF tables keep full precision).
const SIGNIF_PCT = 1;

// Shown whenever a population-template (white-matter) retinotopy finding is in
// the report — keeps the output anatomical/illustrative, never a clinical claim.
export const RETINOTOPY_ILLUSTRATIVE_NOTE =
  "Retinotopic involvement is anatomical/illustrative (population template), " +
  "not a validated clinical prediction.";

// Determinant of the 3x3 spatial block of a column-major voxel→mm mat4.
function affineDet3(M) {
  const m0 = M[0], m1 = M[1], m2 = M[2];
  const m4 = M[4], m5 = M[5], m6 = M[6];
  const m8 = M[8], m9 = M[9], m10 = M[10];
  return (
    m0 * (m5 * m10 - m9 * m6) -
    m4 * (m1 * m10 - m9 * m2) +
    m8 * (m1 * m6 - m5 * m2)
  );
}

/** Lesion volume in mm³ / cm³ from voxel count × |affine determinant|. */
export function computeLesionVolume(lesionVol) {
  if (!lesionVol?.img || !lesionVol.matRAS) return null;
  const dims = getDims(lesionVol);
  if (!dims) return null;
  const [nx, ny, nz] = dims;
  const img = lesionVol.img;
  let count = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (img[i + nx * (j + ny * k)] > 0) {
          count++; cx += i; cy += j; cz += k;
        }
      }
    }
  }
  const voxMM3 = Math.abs(affineDet3(lesionVol.matRAS));
  const mm3 = count * voxMM3;
  let centroidMM = null;
  if (count > 0) {
    const M = lesionVol.matRAS;
    const ci = cx / count, cj = cy / count, ck = cz / count;
    centroidMM = [
      M[0] * ci + M[4] * cj + M[8] * ck + M[12],
      M[1] * ci + M[5] * cj + M[9] * ck + M[13],
      M[2] * ci + M[6] * cj + M[10] * ck + M[14],
    ];
  }
  return { voxelCount: count, mm3, cm3: mm3 / 1000, centroidMM };
}

/**
 * One retinotopy finding line (cortical Benson or white-matter template).
 * `kind` is "polar" | "eccen"; `illustrative` flags population-template (WM)
 * maps so the disclaimer + attribution are emitted.
 */
function buildRetinotopyFinding(lesionVol, r) {
  const counts = computeVoxelCounts(lesionVol, r.vol);
  const set = affectedSet(counts, { mode: "any" });
  let summary;
  if (r.kind === "polar") {
    const ranges = mergeRanges(set, { wrap: true, maxDeg: 360 });
    const hemifield = classifyHemifield(counts);
    summary = buildSummary({ displayRanges: ranges.displayRanges, hemifield, kind: "polar" });
  } else {
    const ranges = mergeRanges(set, { wrap: false, maxDeg: 90 });
    summary = buildSummary({ displayRanges: ranges.displayRanges, kind: "eccen" });
  }
  return {
    name: r.name,
    kind: r.kind,
    summary,
    illustrative: !!r.illustrative,
    attribution: r.attribution || null,
  };
}

/**
 * Build the report model. `atlases` = [{ id, name, vol, labels }] already
 * loaded as NVImages. `retinotopy` = [{ id, name, vol, kind, illustrative,
 * attribution }] — optional polar/eccen maps (cortical Benson and/or the
 * white-matter template) the caller has ALREADY loaded.
 */
export function buildLesionReportModel({ lesionName, lesionVol, atlases = [], retinotopy = [] }) {
  const vol = computeLesionVolume(lesionVol);
  const atlasBreakdowns = [];
  for (const a of atlases) {
    if (!a?.vol?.img) continue;
    const { rows } = computeAtlasOverlap(lesionVol, a.vol, a.labels);
    atlasBreakdowns.push({
      atlasId: a.id,
      atlasName: a.name,
      rows: rows.slice(0, 8), // top regions by voxel count
    });
  }
  const retinotopyFindings = [];
  for (const r of retinotopy) {
    if (!r?.vol?.img) continue;
    retinotopyFindings.push(buildRetinotopyFinding(lesionVol, r));
  }
  return {
    lesionName,
    generatedAt: new Date().toISOString(),
    volume: vol,
    atlasBreakdowns,
    retinotopyFindings,
  };
}

// "Region (38% of lesion, 22% of region)" — the percent-of-region clause is
// dropped when it would round to 0% rather than rendering a misleading "0%".
function formatRegionInvolvement(r) {
  const region = r.percentOfRegion >= 0.5
    ? `, ${r.percentOfRegion.toFixed(0)}% of region`
    : "";
  return `${r.regionName} (${r.percentOfLesion.toFixed(0)}% of lesion${region})`;
}

export function renderReportParagraph(model) {
  if (!model?.volume) return "No lesion data.";
  const v = model.volume;
  const c = v.centroidMM;
  const lines = [];
  lines.push(
    `Lesion volume ${v.cm3.toFixed(2)} cm³ (${v.voxelCount} voxels)` +
      (c ? `, centroid at MNI [${c[0].toFixed(1)}, ${c[1].toFixed(1)}, ${c[2].toFixed(1)}] mm` : "") +
      `.`
  );
  let reportedAtlas = false;
  for (const b of model.atlasBreakdowns) {
    const sig = b.rows.filter((r) => r.percentOfLesion >= SIGNIF_PCT);
    if (!sig.length) continue;
    const parts = sig.map(formatRegionInvolvement).join("; ");
    lines.push(`${b.atlasName}: ${parts}.`);
    reportedAtlas = true;
  }
  if (!reportedAtlas) {
    lines.push(
      model.atlasBreakdowns.length === 0
        ? `No atlas selected for overlap.`
        : `No atlas region covers ≥${SIGNIF_PCT}% of the lesion.`
    );
  }
  const ret = model.retinotopyFindings || [];
  for (const f of ret) lines.push(`${f.name}: ${f.summary}.`);
  if (ret.some((f) => f.illustrative)) lines.push(RETINOTOPY_ILLUSTRATIVE_NOTE);
  return lines.join(" ");
}

export function renderReportText(model) {
  const v = model.volume;
  const out = [];
  out.push(`NeuroVue Lesion Report`);
  out.push(`Generated: ${model.generatedAt}`);
  out.push(`Lesion: ${model.lesionName || "(unnamed)"}`);
  out.push(``);
  out.push(renderReportParagraph(model));
  out.push(``);
  for (const b of model.atlasBreakdowns) {
    out.push(`== ${b.atlasName} ==`);
    out.push(`region, % of lesion, % of region, voxels`);
    for (const r of b.rows) {
      out.push(
        `${r.regionName}, ${r.percentOfLesion.toFixed(1)}, ${r.percentOfRegion.toFixed(1)}, ${r.voxelCount}`
      );
    }
    out.push(``);
  }
  const ret = model.retinotopyFindings || [];
  if (ret.length) {
    out.push(`== Retinotopy ==`);
    for (const f of ret) out.push(`${f.name} (${f.kind}): ${f.summary}`);
    if (ret.some((f) => f.illustrative)) out.push(RETINOTOPY_ILLUSTRATIVE_NOTE);
    for (const a of [...new Set(ret.filter((f) => f.attribution).map((f) => f.attribution))]) {
      out.push(`Source: ${a}`);
    }
    out.push(``);
  }
  return out.join("\n");
}
