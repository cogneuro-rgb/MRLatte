// NeuroVue — Electron preload bridge
// Exposes a minimal `window.neurovue` API so the React app can detect the
// desktop runtime and use native file dialogs. Kept narrow on purpose;
// contextIsolation stays on and nodeIntegration off.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("neurovue", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Workspace save/open via native dialogs (JSON string in/out).
  saveWorkspace: (json) => ipcRenderer.invoke("neurovue:saveWorkspace", json),
  openWorkspace: () => ipcRenderer.invoke("neurovue:openWorkspace"),
  // Generic native "save as" for binary/text (base64 payload).
  saveFile: (defaultName, mime, base64) =>
    ipcRenderer.invoke("neurovue:saveFile", { defaultName, mime, base64 }),
});
