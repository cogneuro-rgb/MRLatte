// Longitudinal comparison. Registration runs server-side (SimpleITK); the
// backend returns a signed difference NIfTI plus change metrics in headers.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

export async function longitudinalAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/longitudinal/available`);
    if (!r.ok) return false;
    return !!(await r.json()).available;
  } catch {
    return false;
  }
}

/**
 * Register followup→baseline and fetch the difference map.
 * Returns { file: File(difference.nii.gz), metrics: {...} }.
 */
export async function registerLongitudinal(baselineFile, followupFile) {
  const fd = new FormData();
  fd.append("baseline", baselineFile, baselineFile.name);
  fd.append("followup", followupFile, followupFile.name);
  const r = await fetch(`${apiBase}/api/longitudinal/register`, {
    method: "POST",
    body: fd,
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json()).detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  const metrics = {
    registrationMetric: r.headers.get("X-Registration-Metric"),
    sameGrid: r.headers.get("X-Same-Grid"),
    changedVoxelPct: r.headers.get("X-Changed-Voxel-Pct"),
  };
  const blob = await r.blob();
  return {
    file: new File([blob], "difference.nii.gz", { type: "application/gzip" }),
    metrics,
  };
}
