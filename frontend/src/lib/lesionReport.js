// One-click structured lesion report. Volume + atlas-overlap numbers come
// from the lqtpy backend by default (lib/lesionMetrics.js), with the original
// JS math (computeAtlasOverlap, affine-aware lesion∩atlas, from
// volumeAnalysis.js) kept as a dev-toggle / fail-soft fallback engine — see
// resolveLesionAtlasMetrics below. PDF/text rendering is done in the renderer
// (data is already in-memory; no backend round-trip for that part).

import { affineDet3, computeAtlasOverlap, getDims } from "@/lib/volumeAnalysis";
import {
  computeVoxelCounts, affectedSet, mergeRanges, classifyHemifield, buildSummary,
} from "@/lib/retinotopyAnalysis";
import {
  getCapabilities, uploadLesion, fetchMetrics, fetchReportFragments, LesionMetricsHttpError,
  getDevEngineOverride,
} from "@/lib/lesionMetrics";

// Regions covering less than this percent of the lesion are omitted from the
// prose summary as noise (the detailed TXT/PDF tables keep full precision).
const SIGNIF_PCT = 1;

// Shown whenever a population-template (white-matter) retinotopy finding is in
// the report — keeps the output anatomical/illustrative, never a clinical claim.
export const RETINOTOPY_ILLUSTRATIVE_NOTE =
  "Retinotopic involvement is anatomical/illustrative (population template), " +
  "not a validated clinical prediction.";

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

// Yield one macrotask to the event loop. Used to keep the main thread
// responsive during the synchronous voxel-loop work below (SMALL-FIXES 56) —
// no Web Worker, just cooperative yielding between the heaviest steps.
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

// --------------------------------------------------------------------------- #
// Engine selection: lqtpy (default) vs. the JS math above (dev toggle / fail-
// soft fallback). Shared by buildLesionReportModel below AND OverlapPanel,
// which does its own single-atlas overlap query — both are "lesion ∩ atlas(es)
// via whichever engine is active" and were duplicating this fallback dance
// before this module absorbed it.
// --------------------------------------------------------------------------- #

/** Provenance for a JS-engine result. `reason` is "dev" (explicit dev-toggle
 * override) or "fallback" (lqtpy unavailable/503, or no lesion File was
 * available to upload — see resolveLesionAtlasMetrics). Threshold/resampling
 * describe the JS engine's own (always `> 0`, lesion-grid) convention, which
 * predates lqtpy and is unrelated to `threshold`/`resampling` further below. */
function jsProvenance(reason, fallbackReason = null) {
  return {
    engine: "js",
    version: null,
    threshold: 0,
    resampling: "lesion-grid",
    fallback: reason === "fallback",
    fallbackReason,
  };
}

async function computeViaJsEngine({ lesionVol, atlases, reason, fallbackReason }) {
  const volume = lesionVol ? computeLesionVolume(lesionVol) : null;
  await yieldToMain();
  const atlasBreakdowns = [];
  for (const a of atlases) {
    if (!a?.vol?.img) {
      atlasBreakdowns.push({ atlasId: a.id, atlasName: a.name, rows: [], voxelGrid: "lesion" });
      continue;
    }
    const { rows } = computeAtlasOverlap(lesionVol, a.vol, a.labels);
    atlasBreakdowns.push({ atlasId: a.id, atlasName: a.name, rows, voxelGrid: "lesion" });
    await yieldToMain(); // keep the tab responsive between atlases (item 56)
  }
  return {
    volume, atlasBreakdowns, excludedAtlases: [],
    provenance: jsProvenance(reason, fallbackReason),
  };
}

/**
 * Resolve lesion volume + per-atlas overlap via the active engine. Default is
 * lqtpy (backend/lesion_metrics.py); falls back to the JS engine (above)
 * **visibly** — the returned `provenance.fallback`/`engine` always says which
 * engine actually produced the numbers, never silently swapped.
 *
 * @param {object} args
 * @param {File|Blob|null} [args.lesionFile]  lesion NIfTI to upload for lqtpy.
 *   Without one, lqtpy can't be reached at all — this resolves via the JS
 *   engine (marked as a fallback) whenever `lesionVol` is available. This is
 *   the path OneClickSummaryPanel's still-unmigrated call takes today (task
 *   note: One-Click Summary is migrated separately, so its call to
 *   buildLesionReportModel below doesn't pass a lesionFile).
 * @param {object|null} [args.lesionVol]  NiiVue NVImage, for the JS engine
 *   (dev toggle, fallback, or lqtpy's lesion-file-less callers) and always
 *   used to build lesion_stats' analogue when the JS engine runs.
 * @param {{id, name, vol, labels}[]} [args.atlases]  atlases to overlap
 *   against, already loaded for the JS path; only `id`/`name` are used on the
 *   lqtpy path (its atlas is bridged server-side under the same MRLatte id).
 * @param {number} [args.threshold]  lqtpy binarization threshold (default 0.5
 *   server-side, applied as `> threshold` — see backend/lesion_metrics.py).
 * @returns {Promise<{volume, atlasBreakdowns, excludedAtlases, provenance}>}
 *   `atlasBreakdowns[].rows` are the FULL, untruncated rows sorted descending
 *   by `voxelCount`; callers that want a top-N table (buildLesionReportModel)
 *   slice them, OverlapPanel shows them as-is.
 */
export async function resolveLesionAtlasMetrics({ lesionFile, lesionVol, atlases = [], threshold } = {}) {
  if (getDevEngineOverride() === "js") {
    return computeViaJsEngine({ lesionVol, atlases, reason: "dev" });
  }

  if (!lesionFile) {
    if (!lesionVol) throw new Error("No lesion data available to compute metrics.");
    return computeViaJsEngine({
      lesionVol, atlases, reason: "fallback",
      fallbackReason: "no lesion file available for the lqtpy engine",
    });
  }

  let caps;
  try {
    caps = await getCapabilities();
  } catch (e) {
    if (!lesionVol) throw e;
    return computeViaJsEngine({ lesionVol, atlases, reason: "fallback", fallbackReason: e.message });
  }
  if (!caps?.available) {
    if (!lesionVol) throw new Error("lqtpy engine is unavailable and no local volume is loaded for the JS fallback.");
    return computeViaJsEngine({
      lesionVol, atlases, reason: "fallback",
      fallbackReason: caps?.reason || "lqtpy engine unavailable",
    });
  }

  const atlasIds = (caps.atlas_ids || []);
  const supported = atlases.filter((a) => atlasIds.includes(a.id));
  const excludedAtlases = atlases
    .filter((a) => !atlasIds.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name, reason: "not supported by the lqtpy engine (atlas kind can't be bridged)" }));

  let result;
  try {
    const lesionId = await uploadLesion(lesionFile);
    result = await fetchMetrics({ lesionId, atlasIds: supported.map((a) => a.id), threshold });
  } catch (e) {
    // 503 = lqtpy unavailable -> visible fallback. So is a raw network
    // failure (backend unreachable entirely, e.g. stopped) — that never
    // reaches our HTTP-status handling in lesionMetrics.js (fetch() itself
    // rejects before there's a Response), so it surfaces here as something
    // other than a LesionMetricsHttpError. A 4xx (empty lesion, unknown
    // atlas) or a non-503 5xx DOES come through as a LesionMetricsHttpError
    // with that real status and must NOT be papered over with JS numbers —
    // only those two are re-thrown for the caller to show as a real error.
    const unreachable = e instanceof LesionMetricsHttpError ? e.status === 503 : true;
    if (unreachable && lesionVol) {
      return computeViaJsEngine({ lesionVol, atlases, reason: "fallback", fallbackReason: e.message });
    }
    throw e;
  }
  // The mapping below stays OUTSIDE that try on purpose. The catch treats any
  // non-HTTP exception as "backend unreachable" and falls back to JS numbers;
  // if a mapping bug (e.g. a TypeError on an unexpected response shape) were
  // inside it, the bug would be silently masked as a fallback instead of
  // surfacing as an error.
  const stats = result.lesion_stats || {};
  const volume = {
    voxelCount: stats.n_voxels ?? 0,
    mm3: stats.volume_mm3 ?? 0,
    cm3: stats.volume_cc ?? (stats.volume_mm3 != null ? stats.volume_mm3 / 1000 : 0),
    centroidMM: stats.center_of_mass_mm || null,
  };
  const atlasBreakdowns = supported.map((a) => {
    const records = result.atlas_overlap?.[a.id] || [];
    // lqtpy's overlap records (backend/lesion_metrics.py -> lqtpy.overlap):
    // LabelID, RegionName, Group, RegionVoxels, LesionVoxels, PercentDamage,
    // PercentOfLesion. Mapped explicitly onto the existing row shape
    // (label/regionName/voxelCount/percentOfLesion/percentOfRegion) that
    // report/sections.js and OverlapPanel already render.
    //
    // IMPORTANT: `voxelCount` here is LesionVoxels counted on the ATLAS
    // grid (lqtpy resamples the lesion mask onto the atlas grid before
    // counting), not the lesion's own grid like the JS engine's
    // computeAtlasOverlap. `voxelGrid: "atlas"` records that so a renderer
    // can label the column honestly instead of implying it's the same unit
    // as a lesion-grid voxel count.
    // MIRRORED server-side by lesion_metrics.py's _row_from_record /
    // build_overlap_model (used by the One-Click Summary job in deps.py's
    // _run_summary_job) -- keep the two mappings in lockstep by hand; there
    // is no shared schema file. backend/tests/test_lesion_metrics.py pins
    // the Python side.
    const rows = records.map((r) => ({
      label: r.LabelID,
      regionName: r.RegionName,
      group: r.Group,
      voxelCount: r.LesionVoxels,
      regionVoxelCount: r.RegionVoxels,
      percentOfLesion: r.PercentOfLesion,
      percentOfRegion: r.PercentDamage,
    }));
    rows.sort((x, y) => y.voxelCount - x.voxelCount); // match the JS engine's ordering
    return { atlasId: a.id, atlasName: a.name, rows, voxelGrid: "atlas" };
  });
  return {
    volume, atlasBreakdowns, excludedAtlases,
    provenance: {
      engine: "lqtpy",
      version: result.provenance?.version ?? null,
      threshold: result.provenance?.threshold ?? (threshold ?? 0.5),
      resampling: "atlas-grid",
      fallback: false,
      fallbackReason: null,
    },
  };
}

// --------------------------------------------------------------------------- #
// Report fragments: lqtpy's embeddable HTML sections for parts of the report
// MRLatte doesn't render itself. Design decision (see task notes): of
// lqtpy's five fragment kinds, only these three are ever requested by
// MRLatte's report composer —
//   - "parcel_damage" is excluded: it duplicates the Atlas Overlap table
//     already built above from these same lqtpy numbers (every column
//     parcel_damage_fragment would add — region/%%damage/voxels — MRLatte
//     already shows; its one extra column, Group, is empty for every
//     MRLatte-bridged atlas today, so it adds nothing).
//   - "tract_proxy" is excluded: it's a voxel-overlap PROXY, not real
//     disconnection, and lqtpy's own docs warn against presenting one as the
//     other — MRLatte's report never embeds it at all rather than risk that
//     confusion.
//   - "morphometry" IS included: beyond the volume/voxel-count MRLatte
//     already shows, it adds component count, laterality index, bounding
//     box and voxel-grid detail MRLatte's own volume cards don't.
//   - "network_rollup" IS requested (server-side availability varies per
//     atlas — see backend/lesion_metrics.py::network_rollup_eligible; as of
//     writing no MRLatte-bridged atlas is eligible, so this typically
//     renders as a quiet "not available" note, not a fragment).
//   - "disconnection" IS requested — real, per-tract streamline
//     disconnection, gated on disconnection_index_available() server-side.
// --------------------------------------------------------------------------- #
const REPORT_FRAGMENT_SECTIONS = ["morphometry", "network_rollup", "disconnection"];

/**
 * Fetch lqtpy's embeddable report-fragment sections for one lesion. Fails
 * soft: any error (lqtpy unavailable, network failure, backend 4xx/5xx, ...)
 * resolves to `{ failed: true, reason }` instead of throwing, so a caller's
 * report always finishes rendering — at worst with one quiet note — instead
 * of failing outright. Returns `null` when there's no lesion file to work
 * with at all (nothing to try, e.g. the JS-engine-only path).
 *
 * @param {{lesionFile: File|Blob|null, atlasIds?: string[], threshold?: number}} args
 *   `atlasIds` should be the SAME bridged ids already used for atlas overlap
 *   (e.g. `model.atlasBreakdowns.map(b => b.atlasId)`) — network_rollup
 *   needs them to check per-atlas eligibility; morphometry/disconnection
 *   ignore them.
 * @returns {Promise<null | {failed: boolean, reason?: string, stylesheet?: string, fragments?: object, unavailable?: object, provenance?: object}>}
 */
export async function resolveReportFragments({ lesionFile, atlasIds = [], threshold } = {}) {
  if (!lesionFile) return null;
  try {
    const caps = await getCapabilities();
    if (!caps?.available) {
      return { failed: true, reason: caps?.reason || "lqtpy engine unavailable" };
    }
    const lesionId = await uploadLesion(lesionFile); // reuses the content-hash dedup cache
    const result = await fetchReportFragments({
      lesionId, atlasIds, sections: REPORT_FRAGMENT_SECTIONS, threshold,
    });
    return { failed: false, ...result };
  } catch (e) {
    return { failed: true, reason: e?.message || "could not load additional report sections" };
  }
}

/**
 * Build the report model. `atlases` = [{ id, name, vol, labels }] already
 * loaded as NVImages (used by the JS engine and for atlas display names on
 * the lqtpy path). `retinotopy` = [{ id, name, vol, kind, illustrative,
 * attribution }] — optional polar/eccen maps (cortical Benson and/or the
 * white-matter template) the caller has ALREADY loaded. `lesionFile` is the
 * lesion NIfTI to upload for the lqtpy engine (see resolveLesionAtlasMetrics);
 * omit it to force the JS-engine fallback path (OneClickSummaryPanel's call
 * below does this today — its migration to lqtpy is a separate task).
 *
 * Async: lqtpy is a network round trip, and the JS-engine fallback still runs
 * the same triple-nested voxel loops as before — yielding a macrotask between
 * the heaviest steps keeps the UI (and the caller's "running" indicator)
 * responsive throughout. Callers must `await` this (see
 * LesionReportPanel.generate() and OneClickSummaryPanel.buildOverlapModel()).
 *
 * Retinotopy is untouched by the engine migration: it stays entirely local
 * JS (buildRetinotopyFinding), computed here exactly as before.
 */
export async function buildLesionReportModel({ lesionName, lesionVol, lesionFile = null, atlases = [], retinotopy = [] }) {
  const { volume, atlasBreakdowns: fullBreakdowns, excludedAtlases, provenance } =
    await resolveLesionAtlasMetrics({ lesionFile, lesionVol, atlases });
  // Top regions by voxel count, same truncation the JS engine always applied
  // here (OverlapPanel, which wants the full list, uses resolveLesionAtlasMetrics
  // directly instead of going through this report-specific adapter).
  const atlasBreakdowns = fullBreakdowns.map((b) => ({ ...b, rows: b.rows.slice(0, 8) }));
  await yieldToMain();
  const retinotopyFindings = [];
  for (const r of retinotopy) {
    if (!r?.vol?.img) continue;
    retinotopyFindings.push(buildRetinotopyFinding(lesionVol, r));
    await yieldToMain();
  }
  return {
    lesionName,
    generatedAt: new Date().toISOString(),
    volume,
    atlasBreakdowns,
    excludedAtlases,
    retinotopyFindings,
    provenance,
  };
}

// "Region (38% of lesion, 22% of region)" — the percent-of-region clause is
// dropped when it would round to 0% rather than rendering a misleading "0%".
//
// The 0.5 cutoff was tuned while the JS engine's percentOfRegion was inflated
// by the voxel-volume unit bug described in lib/__parity__/README.md (since
// fixed — see computeAtlasOverlap's voxVolRatio). It has not been re-tuned
// against post-fix JS values or lqtpy's PercentDamage, so it may no longer be
// the right cutoff for either engine; left as-is deliberately — that's a
// product decision, not something to change as part of the engine swap.
function formatRegionInvolvement(r) {
  const region = r.percentOfRegion >= 0.5
    ? `, ${r.percentOfRegion.toFixed(0)}% of region`
    : "";
  return `${r.regionName} (${r.percentOfLesion.toFixed(0)}% of lesion${region})`;
}

/**
 * "Engine: lqtpy 0.3.0 · threshold > 0.5 · atlas-grid resampling" (or, when
 * the JS engine produced the result — dev toggle or fail-soft fallback —
 * "Engine: MRLatte JS (fallback) · threshold > 0 · lesion-grid"). Shared text
 * for the on-screen report preview, OverlapPanel, and the exported/saved
 * report HTML (report/sections.js's buildLesionStatsSection), so the wording
 * can't drift between the three surfaces.
 */
export function engineProvenanceLabel(provenance) {
  if (!provenance) return null;
  if (provenance.engine === "lqtpy") {
    return `Engine: lqtpy ${provenance.version || "?"} · threshold > ${provenance.threshold ?? 0.5} · atlas-grid resampling`;
  }
  const reason = provenance.fallback ? "fallback" : "dev";
  return `Engine: MRLatte JS (${reason}) · threshold > 0 · lesion-grid`;
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
  out.push(`MRLatte Lesion Report`);
  out.push(`Generated: ${model.generatedAt}`);
  out.push(`Lesion: ${model.lesionName || "(unnamed)"}`);
  const engineLine = engineProvenanceLabel(model.provenance);
  if (engineLine) out.push(engineLine);
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
