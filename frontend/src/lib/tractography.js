// Tractography helpers. NiiVue parses .tck/.trk entirely in the WebGL renderer,
// so multi-GB tractograms exceed the browser's contiguous-ArrayBuffer limit.
// For oversized files we delegate to the backend, which subsamples the
// streamlines and returns a smaller file the renderer can handle.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

export async function tractSubsampleAvailable() {
  try {
    const r = await fetch(`${apiBase}/api/tracts/subsample/available`);
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.available;
  } catch {
    return false;
  }
}

/**
 * Subsample a large tractogram (.tck/.trk) via the backend.
 * Returns a File (same format, fewer streamlines) or throws with a readable
 * message.
 */
export async function subsampleTract(file, maxStreamlines = 200000) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("max_streamlines", String(maxStreamlines));
  const r = await fetch(`${apiBase}/api/tracts/subsample`, {
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
  const blob = await r.blob();
  return new File([blob], file.name, { type: "application/octet-stream" });
}
