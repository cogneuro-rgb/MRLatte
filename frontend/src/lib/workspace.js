// Workspace (.nvws.json) save/restore helpers.
//
// Standard atlases & retinotopy reload from static /atlases/* URLs, so only
// their visibility/settings are stored. User-uploaded volumes live only as
// in-memory File objects, so their bytes are embedded as base64 to make the
// workspace self-contained (this enlarges the file — documented trade-off).

export const WORKSPACE_VERSION = 2;

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

export const isDesktop = () =>
  typeof window !== "undefined" && window.neurovue?.isDesktop === true;

/** Persist a workspace object. Native dialog in Electron, blob download in web. */
export async function saveWorkspace(workspace) {
  const json = JSON.stringify(workspace);
  // Build a human-readable filename: neurovue-<label>-<date>.nvws.json
  const date = (workspace.savedAt || new Date().toISOString()).slice(0, 10);
  const rawLabel = (workspace.label || "session").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40);
  const filename = `neurovue-${rawLabel}-${date}.nvws.json`;
  if (isDesktop() && window.neurovue.saveWorkspace) {
    const r = await window.neurovue.saveWorkspace(json);
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
  if (isDesktop() && window.neurovue.openWorkspace) {
    const r = await window.neurovue.openWorkspace();
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
