// Client for the spherical-ROI builder backend endpoints.
// The backend rasterizes a sphere onto the bundled MNI152 grid and returns a
// downloadable NIfTI mask that can also be loaded as a viewer overlay.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

/**
 * Create a spherical ROI on the MNI152 grid.
 *
 * @param {object} opts
 * @param {number} opts.x       - Center X in world (MNI) mm
 * @param {number} opts.y       - Center Y in world (MNI) mm
 * @param {number} opts.z       - Center Z in world (MNI) mm
 * @param {number} opts.radius  - Sphere radius in mm
 * @param {string} [opts.label] - Label used in the output filename
 * @returns {Promise<{ id: string, label: string, voxels: number, file: string }>}
 */
export async function createSphereROI({ x, y, z, radius, label = "roi" }) {
  const fd = new FormData();
  fd.append("x", String(x));
  fd.append("y", String(y));
  fd.append("z", String(z));
  fd.append("radius", String(radius));
  fd.append("label", label);
  const r = await fetch(`${apiBase}/api/roi/sphere`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return await r.json();
}

/**
 * Build a full URL for a spherical-ROI result file.
 * relPath is e.g. "/api/roi/result/{id}/roi_<label>.nii.gz"
 */
export function roiResultUrl(relPath) {
  return `${apiBase}${relPath}`;
}
