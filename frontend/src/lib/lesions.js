// Drawn-lesion persistence. The drawing panel saves a lesion both locally (NiiVue
// download) and to the backend via this helper, which POSTs the gzipped NIfTI
// bytes to /api/lesions. Mirrors the fetch/error pattern in dicom.js.

import { isDesktop, fileToBase64 } from "@/lib/workspace";

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
 * Save the current NiiVue drawing to a local file, using the best mechanism for
 * the runtime.
 *
 * Desktop (Electron): route through the native Save dialog via
 * window.neurovue.saveFile. NiiVue's saveImage triggers a browser `<a download>`
 * click on a blob: URL, which silently no-ops in packaged Electron (no default
 * download UI) — so the desktop path must use the IPC bridge instead.
 * Web: preserve the existing NiiVue blob-download behaviour exactly.
 *
 * @param {object} viewerRef  ref to NiivueViewer imperative handle
 * @param {string} filename   suggested download filename (e.g. lesion_*.nii.gz)
 * @returns {Promise<{ok:boolean, canceled?:boolean, empty?:boolean}>}
 */
export async function saveLesionLocally(viewerRef, filename) {
  if (isDesktop() && window.neurovue?.saveFile) {
    const bytes = await viewerRef?.current?.getDrawingBytes?.();
    if (!bytes) return { ok: false, empty: true }; // no drawing / read failed
    const b64 = await fileToBase64(new Blob([bytes]));
    const r = await window.neurovue.saveFile(filename, "application/gzip", b64);
    return r?.canceled ? { ok: false, canceled: true } : { ok: true };
  }
  // Web: unchanged NiiVue download (surfaces its own error toast on failure).
  const ok = await viewerRef?.current?.saveDrawing?.(filename);
  return { ok: !!ok };
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
  const bytes = await viewerRef?.current?.getDrawingBytes?.();
  if (!bytes || !bytes.length) return null;
  return new File([bytes], name, { type: "application/gzip" });
}
