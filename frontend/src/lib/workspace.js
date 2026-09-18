// Workspace (.nvws.json) save/restore helpers.
//
// Standard atlases & retinotopy reload from static /atlases/<id>/* URLs, so only
// their visibility/settings are stored. A v3 or older workspace holds the
// pre-revamp atlas ids (ho_cort, hcp1065, visfAtlas); applyWorkspace resolves
// them through the registry's aliases, so old files keep restoring. User-uploaded volumes live only as
// in-memory File objects, so their bytes are embedded as base64 to make the
// workspace self-contained (this enlarges the file — documented trade-off).

export const WORKSPACE_VERSION = 4;

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
  const filename = `mrlatte-${rawLabel}-${date}.nvws.json`;
  if (isDesktop() && window.mrlatte.saveWorkspace) {
    const r = await window.mrlatte.saveWorkspace(json);
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
    input.accept = ".json,.nvws,application/json";
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
