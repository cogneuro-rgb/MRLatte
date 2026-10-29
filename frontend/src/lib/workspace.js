// Workspace (.mrlatte) save/restore helpers. A workspace is plain JSON; files
// saved before 0.5.0 are named .nvws.json ("NeuroVue workspace", the app's old
// name) and still open. A single extension is what lets Windows open the file
// in MRLatte on a double-click (installer.nsh associates .mrlatte).
//
// Standard atlases & retinotopy reload from static /atlases/<id>/* URLs, so only
// their visibility/settings are stored. A v3 or older workspace holds the
// pre-revamp atlas ids (ho_cort, hcp1065, visfAtlas); applyWorkspace resolves
// them through the registry's aliases, so old files keep restoring. User-uploaded volumes live only as
// in-memory File objects, so their bytes are embedded as base64 to make the
// workspace self-contained (this enlarges the file — documented trade-off).

// v5 adds userLayers[].transform (manual move / rotate / scale); v6 adds the
// base volume itself, and files saved as links (path + size instead of a copy;
// a DICOM base as its source folder or zip, converted again on open). Dashboard
// stamps the LOWEST version that can hold what the workspace contains, so a
// workspace without a custom base or adjusted layer still opens in older
// versions — and one with them is refused there instead of opening wrong.
export const WORKSPACE_VERSION = 6;

export const WORKSPACE_EXT = ".mrlatte";
/** Names MRLatte opens as a workspace (current and pre-0.5.0). */
export function isWorkspaceFileName(name) {
  return /\.(mrlatte|nvws\.json|nvws)$/i.test(String(name || ""));
}
/** A workspace object from raw file bytes (quick-open / double-click). */
export function parseWorkspaceBytes(bytes) {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

export async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToFile(b64, name, type = "application/octet-stream") {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}

const isDesktop = () =>
  typeof window !== "undefined" && window.mrlatte?.isDesktop === true;

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Save arbitrary binary bytes to disk with the same UX as every other save:
 * a native Save-As dialog in Electron, a blob download in the browser.
 * @param {string} defaultName suggested filename
 * @param {string} mime        content type (e.g. "application/gzip")
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{canceled: boolean, filePath?: string}>}
 */
export async function saveBinaryFile(defaultName, mime, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isDesktop() && window.mrlatte.saveFile) {
    const r = await window.mrlatte.saveFile(defaultName, mime, bytesToBase64(data));
    return { canceled: !!r?.canceled, filePath: r?.filePath };
  }
  const blob = new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
  return { canceled: false, filePath: defaultName };
}

/** Persist a workspace object. Native dialog in Electron, blob download in web. */
export async function saveWorkspace(workspace) {
  const json = JSON.stringify(workspace);
  // Build a human-readable filename: mrlatte-<label>-<date>.nvws.json
  const date = (workspace.savedAt || new Date().toISOString()).slice(0, 10);
  const rawLabel = (workspace.label || "session").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40);
  const filename = `mrlatte-${rawLabel}-${date}${WORKSPACE_EXT}`;
  if (isDesktop() && window.mrlatte.saveWorkspace) {
    const r = await window.mrlatte.saveWorkspace(json, filename);
    return !r?.canceled;
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

/** Load a workspace object. Native dialog in Electron, file picker in web. */
export async function openWorkspace() {
  if (isDesktop() && window.mrlatte.openWorkspace) {
    const r = await window.mrlatte.openWorkspace();
    if (r?.canceled || !r?.json) return null;
    return JSON.parse(r.json);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mrlatte,.json,.nvws,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        resolve(JSON.parse(await f.text()));
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}
