// Client-side atlas label helpers.
//
// The backend now writes ONE canonical label shape
// ({schemaVersion, regions: [{value, name, hemi, color, centroidMM}]}), but the
// two legacy shapes are still accepted here because a user may point ATLAS_DIR
// at a directory this build has never migrated, and because an atlas.labels.json
// is a plain file someone can hand-edit.
//
// This replaces the inline dual-shape branch that lived in
// Dashboard.loadAtlasLabels.

/** Normalise any accepted label payload to `[{value, name, color, centroidMM}]`. */
export function normalizeRegions(data) {
  if (!data) return [];

  // canonical
  if (Array.isArray(data.regions)) {
    return data.regions
      .filter((r) => r && r.value != null && Number(r.value) !== 0)
      .map((r) => ({
        value: Number(r.value),
        name: String(r.name ?? `Region ${r.value}`),
        hemi: r.hemi ?? null,
        color: Array.isArray(r.color) ? r.color : null,
        centroidMM: Array.isArray(r.centroidMM) ? r.centroidMM : null,
      }));
  }

  // legacy list: [{index, name}]
  if (Array.isArray(data)) {
    return data
      .filter((e) => e && e.index != null && Number(e.index) !== 0)
      .map((e) => ({
        value: Number(e.index),
        name: String(e.name ?? `Region ${e.index}`),
        hemi: null, color: null, centroidMM: null,
      }));
  }

  // legacy map: {"1": "V1v"}
  if (typeof data === "object") {
    return Object.entries(data)
      .map(([k, v]) => ({ value: parseInt(k, 10), v }))
      .filter(({ value }) => Number.isFinite(value) && value !== 0)
      .map(({ value, v }) => ({
        value,
        name: typeof v === "string" ? v : String(v?.name ?? `Region ${value}`),
        hemi: null, color: null, centroidMM: null,
      }));
  }

  return [];
}

/** `{value: name}` — the shape the crosshair readout and overlap maths use. */
export function toNameMap(regions) {
  const out = {};
  for (const r of regions || []) out[r.value] = r.name;
  return out;
}

/** `{value: [r,g,b]}` for the regions carrying an explicit colour. */
export function toColorMap(regions) {
  const out = {};
  for (const r of regions || []) if (r.color) out[r.value] = r.color;
  return out;
}

/**
 * Fetch and normalise an atlas's labels.
 *
 * `labelsUrl` is the static path from the registry descriptor
 * (/atlases/<id>/<id>.labels.json), served by the /atlases mount.
 */
export async function loadRegions(labelsUrl) {
  if (!labelsUrl) return [];
  try {
    const res = await fetch(labelsUrl);
    if (!res.ok) return [];
    return normalizeRegions(await res.json());
  } catch (e) {
    console.warn("atlas labels fetch failed:", labelsUrl, e);
    return [];
  }
}

/**
 * Case-insensitive substring match over region names.
 * Shared by AtlasLabelList's filter box and the global region search.
 */
export function matchRegions(regions, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return regions || [];
  return (regions || []).filter((r) => r.name.toLowerCase().includes(q));
}
