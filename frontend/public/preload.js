// MRLatte — Electron preload bridge
// Exposes a minimal `window.mrlatte` API so the React app can detect the
// desktop runtime and use native file dialogs. Kept narrow on purpose;
// contextIsolation stays on and nodeIntegration off.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const APPEARANCES = ["system", "light", "dark"];

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
  saveWorkspace: (json, name) => ipcRenderer.invoke("mrlatte:saveWorkspace", json, name),
  openWorkspace: () => ipcRenderer.invoke("mrlatte:openWorkspace"),
  // A workspace saved with links (paths, not copies): let this window read
  // the files the workspace it just opened points to. The main process
  // decides which paths those are (from the workspace it read itself) and
  // asks first about any on another computer. Then readOpenFile works for
  // them; a DICOM base's source folder is read with readDicomFolder.
  allowWorkspaceLinks: () => ipcRenderer.invoke("mrlatte:allowWorkspaceLinks"),
  readDicomFolder: (folderPath) => ipcRenderer.invoke("mrlatte:readDicomFolder", folderPath),
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
  // Sidebar open/closed, so main can lower the window's minimum width while
  // the sidebar is hidden. Boolean only — main owns the actual sizes.
  setSidebarOpen: (open) => ipcRenderer.send("mrlatte:setSidebarOpen", open === true),
  // Native menu bar. A menu click arrives as a command id only (never the
  // IPC event); the returned function removes exactly this listener.
  onMenuCommand: (cb) => {
    const listener = (_e, id) => { if (typeof cb === "function" && typeof id === "string") cb(id); };
    ipcRenderer.on("mrlatte:menu", listener);
    return () => { ipcRenderer.removeListener("mrlatte:menu", listener); };
  },
  // What the menu needs to read from the app (labels, enabled states). Plain
  // values only — main whitelists them again, this just keeps the payload clean.
  setMenuState: (state) => {
    const s = state && typeof state === "object" ? state : {};
    const out = {};
    for (const k of ["sidebarVisible", "toolbarVisible", "canUndo", "canRedo"]) {
      if (typeof s[k] === "boolean") out[k] = s[k];
    }
    if (APPEARANCES.includes(s.appearance)) out.appearance = s.appearance;
    ipcRenderer.send("mrlatte:menuState", out);
  },
  // The app's light/dark choice → native chrome (menus, title bar) and the
  // first loading page; main persists it. Anything but the three modes is dropped.
  setAppearance: (mode) => {
    if (APPEARANCES.includes(mode)) ipcRenderer.send("mrlatte:setAppearance", mode);
  },
  // Standalone header window only (electron.js --header mode): the leading
  // bytes of the file it was launched for. Takes no path — main already
  // knows the one file this window may read.
  readHeaderFile: () => ipcRenderer.invoke("mrlatte:readHeaderFile"),
});
