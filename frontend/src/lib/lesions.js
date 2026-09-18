// Drawn-lesion persistence. The drawing panel saves a lesion both locally (NiiVue
// download) and to the backend via this helper, which POSTs the gzipped NIfTI
// bytes to /api/lesions. Mirrors the fetch/error pattern in dicom.js.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

/**
 * Upload a drawn lesion to the server.
 * @param {Blob|Uint8Array} data  gzipped NIfTI bytes of the drawing
 * @param {string} name           user-supplied case/lesion name
 * @param {string} [base]         loaded base-scan label (optional context)
 * @returns {Promise<object>}     { ok, id, path, bytes }
 * @throws {Error} with a readable message on non-OK responses
 */
export async function uploadLesion(data, name, base) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/gzip" });
  const fd = new FormData();
  fd.append("file", blob, "lesion.nii.gz");
  fd.append("name", name);
  if (base) fd.append("base", base);

  const r = await fetch(`${apiBase}/api/lesions`, { method: "POST", body: fd });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      detail = (await r.json()).detail || detail;
    } catch { /* keep status */ }
    throw new Error(detail);
  }
  return r.json();
}

/**
 * Wrap the current in-memory NiiVue drawing (scratch lesion) as a File without
 * saving it to disk first — so analyses (tract dissection, DaLn mapper, volume)
 * can consume a freshly drawn/edited lesion directly. Returns null if nothing
 * is drawn.
 * @param {object} viewerRef  ref to NiivueViewer imperative handle
 * @param {string} [name]     filename (defaults to "current_drawing.nii.gz")
 * @returns {Promise<File|null>}
 */
export async function currentDrawingAsFile(viewerRef, name = "current_drawing.nii.gz") {
  // getDrawingBytes() returns a non-empty NIfTI even for an all-zero bitmap,
  // so a byte-length check never actually detects an empty drawing — ask the
  // viewer directly instead (item 60). Callers are expected to toast on a
  // null return so the user sees why nothing happened.
  if (viewerRef?.current?.isDrawingEmpty?.()) return null;
  const bytes = await viewerRef?.current?.getDrawingBytes?.();
  if (!bytes || !bytes.length) return null;
  return new File([bytes], name, { type: "application/gzip" });
}
