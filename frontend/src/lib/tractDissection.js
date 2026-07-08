// Virtual dissection of white-matter tracts via lesion masks.
// Sends a lesion NIfTI to the backend and receives affected-tract metrics
// and downloadable NIfTI + .trk files.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

export async function dissectAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/tracts/dissect/available`);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return await r.json();  // { ok, dipy, tract_file_present, n_streamlines?, reason? }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Virtual dissection: send a lesion mask to the backend and get back
 * metrics + file URLs for the affected-tract NIfTI and filtered .trk.
 *
 * @param {File} lesionFile  - The lesion NIfTI (.nii or .nii.gz)
 * @param {object} opts
 * @param {string} [opts.name]  - Optional name label
 * @returns {Promise<{
 *   id: string,
 *   n_input_streamlines: number,
 *   n_selected_streamlines: number,
 *   affected_voxels: number,
 *   density_max: number,
 *   tract_volume_cm3: number,
 *   message?: string,
 *   files: { nifti: string, trk: string } | null,
 *   atlas_overlap: { ho_cort: object[], ho_sub: object[] }
 * }>}
 */
export async function dissectTract(lesionFile, { name = "", atlas = "harvard_oxford" } = {}) {
  const fd = new FormData();
  fd.append("file", lesionFile, lesionFile.name);
  if (name) fd.append("name", name);
  fd.append("atlas", atlas);
  const r = await fetch(`${apiBase}/api/tracts/dissect`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return await r.json();
}

/**
 * Build a full URL for a tract dissection result file.
 * relPath is e.g. "/api/tracts/dissect/result/{id}/affected_tracts.nii.gz"
 */
export function tractResultUrl(relPath) {
  return `${apiBase}${relPath}`;
}

/**
 * Find streamlines that connect two lesion masks (pass through both).
 *
 * @param {File} fileA  - First lesion NIfTI (.nii or .nii.gz)
 * @param {File} fileB  - Second lesion NIfTI (.nii or .nii.gz)
 * @param {object} opts
 * @param {string} [opts.nameA]  - Optional label for lesion A
 * @param {string} [opts.nameB]  - Optional label for lesion B
 * @param {string} [opts.modeA]  - "through" | "start" | "terminate" (per-ROI filter for A)
 * @param {string} [opts.modeB]  - "through" | "start" | "terminate" (per-ROI filter for B)
 * @returns {Promise<{
 *   id: string,
 *   n_input_streamlines: number,
 *   n_selected_streamlines: number,
 *   affected_voxels: number,
 *   density_max: number,
 *   tract_volume_cm3: number,
 *   message?: string,
 *   files: { nifti: string, trk: string } | null,
 *   atlas_overlap: { ho_cort: object[], ho_sub: object[] }
 * }>}
 */
export async function dissectBetween(
  fileA,
  fileB,
  { nameA = "", nameB = "", modeA = "through", modeB = "through", atlas = "harvard_oxford" } = {},
) {
  const fd = new FormData();
  fd.append("file_a", fileA, fileA.name);
  fd.append("file_b", fileB, fileB.name);
  if (nameA) fd.append("name_a", nameA);
  if (nameB) fd.append("name_b", nameB);
  fd.append("mode_a", modeA);
  fd.append("mode_b", modeB);
  fd.append("atlas", atlas);
  const r = await fetch(`${apiBase}/api/tracts/dissect/between`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return await r.json();
}
