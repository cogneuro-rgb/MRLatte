// Loading an atlas so its voxels can be READ (not shown).
//
// The "ensure it's in the viewer -> get the volume -> get its labels" triple
// was written out verbatim in three panels (OverlapPanel, LesionReportPanel,
// OneClickSummaryPanel) with three slightly different sets of guards. They are
// one operation, so they are one function.

/**
 * Make sure `atlas` is loaded as a queryable NiiVue volume and its labels are
 * fetched. Loads it invisibly when absent — this only reads voxels, so it must
 * not disturb what the user is looking at.
 *
 * @returns {Promise<{vol, labels}|null>} null when the atlas cannot be loaded
 *   or has no label table (both are normal: an atlas may have been uninstalled
 *   between the picker rendering and the button being pressed).
 */
export async function loadAtlasForReading(atlas, { viewerRef, ensureAtlasLoaded, ensureRegions }) {
  if (!atlas?.id) return null;
  const viewer = viewerRef?.current;
  if (!viewer) return null;

  let vol = viewer.getVolume?.(atlas.id);
  if (!vol?.img) {
    await ensureAtlasLoaded?.(atlas.id, { silent: true });
    vol = viewer.getVolume?.(atlas.id);
  }
  if (!vol?.img) return null;

  const regions = (await ensureRegions?.(atlas)) || [];
  if (!regions.length) return null;

  // computeAtlasOverlap and buildLesionReportModel both index by integer value.
  const labels = {};
  for (const r of regions) labels[r.value] = r.name;
  return { vol, labels, regions };
}

/**
 * The same, for a set of atlases — the shape the report and summary builders
 * take. Atlases that fail to load are skipped rather than failing the report:
 * a missing atlas should cost you its section, not the whole document.
 */
export async function loadAtlasesForReading(atlases, ctx) {
  const out = [];
  for (const a of atlases || []) {
    const loaded = await loadAtlasForReading(a, ctx);
    if (loaded) out.push({ id: a.id, name: a.name, vol: loaded.vol, labels: loaded.labels });
  }
  return out;
}
