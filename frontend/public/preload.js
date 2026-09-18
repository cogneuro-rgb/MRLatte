// MRLatte — Electron preload bridge
// Exposes a minimal `window.mrlatte` API so the React app can detect the
// desktop runtime and use native file dialogs. Kept narrow on purpose;
// contextIsolation stays on and nodeIntegration off.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("mrlatte", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Real filesystem path for a File object picked via drag-drop or a plain
  // <input type=file> (item 13's hover tooltip). File.path was removed in
  // Electron 32 (see mrlatte:pickModuleFile below); webUtils.getPathForFile
  // is its renderer-safe replacement and, unlike the IPC dialog used for
  // module slots, works for whatever the user already dropped/selected — no
  // second native picker needed. Returns null in the browser build (no
  // window.mrlatte at all there) and for anything getPathForFile can't
  // resolve.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch (_e) { return null; }
  },
  // Workspace save/open via native dialogs (JSON string in/out).
  saveWorkspace: (json) => ipcRenderer.invoke("mrlatte:saveWorkspace", json),
  openWorkspace: () => ipcRenderer.invoke("mrlatte:openWorkspace"),
  // Generic native "save as" for binary/text (base64 payload).
  saveFile: (defaultName, mime, base64) =>
    ipcRenderer.invoke("mrlatte:saveFile", { defaultName, mime, base64 }),
  // Native picker for a module slot payload; resolves to a filesystem PATH,
  // which the backend then copies or registers. Nothing is read here.
  pickModuleFile: (name, extensions) =>
    ipcRenderer.invoke("mrlatte:pickModuleFile", { name, extensions }),
  // Quick-open (Explorer double-click / file association): pull, not push.
  // getPendingOpenFile resolves to null when this window wasn't opened with
  // a file, or once the one path it had has already been consumed.
  getPendingOpenFile: () => ipcRenderer.invoke("mrlatte:getPendingOpenFile"),
  readOpenFile: (filePath) => ipcRenderer.invoke("mrlatte:readOpenFile", filePath),
});
