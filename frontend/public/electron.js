// MRLatte — Electron main process
//
// Two modes:
//   * DEV  (MRLATTE_DEV=1, unpackaged): load the CRA dev server at :3000. The
//     developer runs the FastAPI backend themselves. No spawning here.
//   * PACKAGED (installed .exe): this process starts the embedded-Python FastAPI
//     backend (which serves the built React app + API on 127.0.0.1:8001), waits
//     for the backend to answer /api/, then loads that URL into the window.
//     Everything is bundled as electron-builder `extraResources`, so the app is
//     fully self-contained and works with no internet.
//
// To test the packaged code path WITHOUT building an installer, run:
//   set MRLATTE_RES_DIR=<repo>\dist\MRLatte && npx electron .
// which points resourcesDir() at an assemble-bundle.ps1 output folder.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");

const BACKEND_PORT = 8001;
const APP_URL = `http://127.0.0.1:${BACKEND_PORT}/`;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/`;

// Derive URLs for a runtime-chosen port (used when BACKEND_PORT is occupied
// by something else and we fall back to an OS-assigned free port).
function appUrlFor(port) {
  return `http://127.0.0.1:${port}/`;
}
function healthUrlFor(port) {
  return `http://127.0.0.1:${port}/api/`;
}

const BACKEND_START_TIMEOUT_MS = 120000; // heavy sci-stack import can be slow on 1st run

const isDev = !app.isPackaged && process.env.MRLATTE_DEV === "1";

// Multiple windows can exist at once (each Explorer double-click on a
// .nii/.nii.gz file opens a new window sharing the one backend). `windows`
// tracks every live BrowserWindow; `lastFocusedWindow` is the fallback used
// by menu actions and second-instance focusing when nothing currently has
// OS focus (e.g. Reload right after a native dialog closes).
const windows = new Set();
let lastFocusedWindow = null;
let backendProc = null;
let shuttingDown = false;
let activePort = BACKEND_PORT;

// The backend is started once, by the very first window. `backendReady`
// gates whether a later file-association open can go straight to a new
// window (openNewWindow) or must wait; `pendingBoot` queues file paths that
// arrive (via second-instance) while that first boot is still in flight.
let backendReady = false;
const pendingBoot = [];

// Files opened via Explorer double-click / file association. `pendingOpenByWc`
// hands a window's queued path to its own renderer exactly once (keyed by
// webContents.id, matching a window 1:1); `allowedOpenPaths` is the security
// boundary for mrlatte:readOpenFile — the ONLY paths it will ever read are
// ones the OS itself handed us via argv, never an arbitrary renderer-supplied
// path.
const pendingOpenByWc = new Map();
const allowedOpenPaths = new Set();
const MAX_OPEN_BYTES = 1.5 * 1024 ** 3;

// A path arrives on argv either quoted or not, and NSIS launches as
// `$appExe "%1"`, so argv[1] is the file when present. Skip the bare "."
// `electron .` passes in dev, and any flag-looking arg.
const NII_EXT_RE = /\.(nii|nii\.gz|gz)$/i;
function niftiPathFromArgv(argv, cwd = process.cwd()) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith("-") || a === ".") continue;
    const p = path.isAbsolute(a) ? a : path.resolve(cwd, a);
    if (NII_EXT_RE.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Paths
// --------------------------------------------------------------------------- //
// extraResources are copied into resources/ next to the packaged app. The test
// override lets us exercise this path against an assemble-bundle.ps1 folder.
function resourcesDir() {
  return process.env.MRLATTE_RES_DIR || process.resourcesPath;
}

// Per-user, machine-local data (results + logs). Uses %LOCALAPPDATA% so it is
// NOT roaming and needs no admin rights.
function dataDir() {
  const base = process.env.LOCALAPPDATA || app.getPath("userData");
  return path.join(base, "MRLatte");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Small breadcrumb trail for the quick-open (file-association) path, since
// there's no attached console for a normal double-click launch. Read at
// %LOCALAPPDATA%\MRLatte\logs\quickopen-debug.log.
function logQuickOpen(msg) {
  try {
    const logs = ensureDir(path.join(dataDir(), "logs"));
    fs.appendFileSync(path.join(logs, "quickopen-debug.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_e) {
    /* best effort */
  }
}

// Module root: every large data asset (atlases, and the two user-supplied slots)
// resolves under this one path via backend/deps.py:MODULE_ROOT. It lives OUTSIDE
// the install dir on purpose - electron-builder's NSIS updater uninstalls the
// old version, deleting resources\, so a module root in there would throw away
// the user's dropped-in tractogram and connectome bundle on every update.
function moduleRoot() {
  return path.join(dataDir(), "modules");
}

// First run (or after the user deletes the folder): seed the module root from
// the read-only copy in resources\modules - the atlases, the manifest, and the
// two empty drop-in slots. Copies only what is missing, so a user's own files
// and any modules downloaded later are never overwritten.
function seedModules(res) {
  const src = path.join(res, "modules");
  const dst = ensureDir(moduleRoot());
  if (!fs.existsSync(src)) return dst;
  try {
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
  } catch (e) {
    // Non-fatal: the app still starts, the Module Store just reports the
    // affected modules as not installed.
    console.error("[electron] seeding modules failed:", e.message);
  }
  return dst;
}

function logStream(name) {
  const logs = ensureDir(path.join(dataDir(), "logs"));
  return fs.openSync(path.join(logs, name), "a");
}

// --------------------------------------------------------------------------- //
// Health probing
// --------------------------------------------------------------------------- //
function checkHttp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new (require("net").Socket)();
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

// Like checkHttp, but also returns the response body so callers can fingerprint
// WHICH app is answering on a port (used to tell "our own leftover backend"
// apart from an unrelated program that happens to be listening there).
function checkHttpWithBody(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        // The served index.html is small; bail out early on anything huge.
        if (body.length > 65536) res.destroy();
      });
      res.on("end", () => resolve({ ok: res.statusCode === 200, body }));
      res.on("error", () => resolve({ ok: false, body: "" }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

// Fingerprint whatever is listening on `port`: is it MRLatte's own backend
// (a leftover dev server or an orphaned previous instance), or some unrelated
// program? The served frontend's <title> is literally "MRLatte · Neuroimaging
// Dashboard" (frontend/public/index.html), so a substring match on "MRLatte"
// in the response body is a reliable, zero-backend-change fingerprint.
async function identifyExistingInstance(port) {
  const { body } = await checkHttpWithBody(`http://127.0.0.1:${port}/`);
  return body.includes("MRLatte");
}

// Ask the OS for a free ephemeral port by binding a throwaway server to port 0.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const srv = net.createServer();
    srv.once("error", (err) => reject(err));
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(500);
  }
  return false;
}

// --------------------------------------------------------------------------- //
// Spawn the backend service
// --------------------------------------------------------------------------- //
async function startBackend(port) {
  const res = resourcesDir();
  const python = path.join(res, "python", "python.exe");
  const backendDir = path.join(res, "backend");
  const sitePkgs = path.join(res, "python", "site-packages");
  const staticDir = path.join(res, "frontend_build");
  const scriptsDir = path.join(res, "scripts");
  if (!fs.existsSync(python)) {
    throw new Error(`Embedded Python not found:\n${python}\nThe installation looks incomplete.`);
  }

  const dd = dataDir();
  const env = Object.assign({}, process.env, {
    STATIC_DIR: staticDir,
    // ATLAS_DIR / GLOBAL_TRACT_FILE / LNM_BUNDLE are deliberately NOT set: they
    // all derive from the module root, and a per-asset override here would
    // outrank it and pin the old bundle layout.
    MRLATTE_MODULE_ROOT: seedModules(res),
    TRACT_RESULTS_DIR: path.join(dd, "tract_results"),
    ROI_RESULTS_DIR: path.join(dd, "roi_results"),
    DICOM_RESULTS_DIR: path.join(dd, "dicom_results"),
    LNM_RESULTS_DIR: path.join(dd, "lnm_results"),
    SUMMARY_RESULTS_DIR: path.join(dd, "summary_results"),
    VALIDATION_DIR: path.join(scriptsDir, "validation_plots"),
    VALIDATION_REPORT: path.join(scriptsDir, "benson_validation_report.txt"),
    // dcm2niix on PATH so the backend's shutil.which("dcm2niix") resolves.
    PATH: path.join(res, "dcm2niix") + path.delimiter + (process.env.PATH || ""),
    PYTHONUNBUFFERED: "1",
  });
  delete env.CORS_ORIGINS; // same-origin (localhost:8001) — no CORS needed

  // The embeddable Python's python*._pth makes it IGNORE PYTHONPATH, so we add
  // site-packages + backend to sys.path at runtime via a -c bootstrap. This also
  // keeps the bundle relocatable (all paths computed here at launch).
  //
  // The two OPTIONAL Python stacks (reports-figures, validation-neuropythy) ship
  // in their own dirs only in a full build; add whichever are present so the
  // backend can import them. A core install has neither and adds nothing.
  const optionalStackInserts = ["python-reports", "python-validation"]
    .map((d) => path.join(res, d))
    .filter((p) => fs.existsSync(p))
    .map((p) => `sys.path.insert(0, r'${p}');`)
    .join("");
  const bootstrap =
    "import sys, os;" +
    `sys.path.insert(0, r'${sitePkgs}');` +
    `sys.path.insert(0, r'${backendDir}');` +
    optionalStackInserts +
    `os.chdir(r'${backendDir}');` +
    "import uvicorn;" +
    `uvicorn.run('server:app', host='127.0.0.1', port=${port})`;

  const out = logStream("backend.log");
  fs.writeSync(out, `[electron] starting backend on port ${port}\n`);
  backendProc = spawn(python, ["-c", bootstrap], {
    cwd: backendDir,
    env,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  backendProc.on("exit", (code) => {
    if (!shuttingDown) onServiceCrash("MRLatte backend", code);
  });
  const ok = await waitFor(() => checkHttp(healthUrlFor(port)), BACKEND_START_TIMEOUT_MS);
  if (!ok) {
    throw new Error(
      "The MRLatte application did not respond in time.\n" +
        "See logs\\backend.log in your MRLatte data folder."
    );
  }
}

// --------------------------------------------------------------------------- //
// Teardown
// --------------------------------------------------------------------------- //
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // /T kills the whole tree (uvicorn spawns worker python.exe children).
      execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
    } else {
      proc.kill("SIGTERM");
    }
  } catch (_e) {
    /* best effort */
  }
}

function stopServices() {
  shuttingDown = true;
  killTree(backendProc);
}

function onServiceCrash(name, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  dialog.showErrorBox(
    "MRLatte stopped",
    `${name} exited unexpectedly (code ${code}).\n` +
      "MRLatte will now close. Check the logs in your MRLatte data folder."
  );
  killTree(backendProc);
  app.quit();
}

// --------------------------------------------------------------------------- //
// IPC (local file save/open) — unchanged, works regardless of loaded URL
// --------------------------------------------------------------------------- //
function registerIpc() {
  ipcMain.handle("mrlatte:saveWorkspace", async (e, json) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: "workspace.nvws.json",
      filters: [{ name: "MRLatte Workspace", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.promises.writeFile(r.filePath, json, "utf8");
    return { canceled: false, filePath: r.filePath };
  });

  ipcMain.handle("mrlatte:openWorkspace", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "MRLatte Workspace", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const json = await fs.promises.readFile(r.filePaths[0], "utf8");
    return { canceled: false, json };
  });

  ipcMain.handle("mrlatte:saveFile", async (e, { defaultName, base64 }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.promises.writeFile(r.filePath, Buffer.from(base64, "base64"));
    return { canceled: false, filePath: r.filePath };
  });

  // Module slot picker. Returns the PATH only — the payloads run to hundreds of
  // MB, so the backend copies or registers the file itself rather than having
  // the renderer read it into memory and upload it. Electron 32 removed
  // File.path, so a plain <input type="file"> cannot supply this.
  ipcMain.handle("mrlatte:pickModuleFile", async (e, { name, extensions }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: "Select module file",
      properties: ["openFile"],
      filters: [
        { name: name || "Module file", extensions: (extensions || []).map((e) => e.replace(/^\./, "")) },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return { canceled: false, filePath: r.filePaths[0] };
  });

  // Quick-open (file-association) pull model: a window created with a queued
  // path asks for it once; a reload must not re-open the same file, so it's
  // consumed on read.
  ipcMain.handle("mrlatte:getPendingOpenFile", (e) => {
    const p = pendingOpenByWc.get(e.sender.id);
    logQuickOpen(`getPendingOpenFile wcId=${e.sender.id} found=${!!p} path=${p || "-"}`);
    if (!p) return null;
    pendingOpenByWc.delete(e.sender.id);
    const st = fs.statSync(p);
    return { filePath: p, name: path.basename(p), size: st.size };
  });

  // The only place main reads raw binary bytes for the renderer. Never widen
  // this to an arbitrary-path read — allowedOpenPaths only ever contains
  // paths the OS itself handed us via argv.
  ipcMain.handle("mrlatte:readOpenFile", async (_e, filePath) => {
    logQuickOpen(`readOpenFile path=${filePath} allowed=${allowedOpenPaths.has(filePath)}`);
    if (!allowedOpenPaths.has(filePath)) return { ok: false, error: "not-allowed" };
    const st = await fs.promises.stat(filePath);
    if (st.size > MAX_OPEN_BYTES) return { ok: false, error: "too-large", size: st.size };
    const buf = await fs.promises.readFile(filePath);
    return { ok: true, name: path.basename(filePath), bytes: new Uint8Array(buf) };
  });
}

// --------------------------------------------------------------------------- //
// Window
// --------------------------------------------------------------------------- //
function createMainWindow(openFilePath) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // Lowered from 1200x720 so the window can be parked small beside another
    // app. The sidebar is a fixed 400px and collapses to 0, so ~880px still
    // leaves a usable canvas with it open and a generous one with it collapsed;
    // below that the topbar controls start wrapping.
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#050505",
    title: "MRLatte",
    autoHideMenuBar: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  windows.add(win);
  lastFocusedWindow = win;

  // Captured now, while webContents is still alive — reading win.webContents
  // (or .id off it) from inside the "closed" handler below throws "Object
  // has been destroyed", since by the time "closed" fires the window (and
  // its webContents) has already been torn down.
  const wcId = win.webContents.id;

  logQuickOpen(`createMainWindow openFilePath=${openFilePath || "-"} wcId=${wcId}`);
  if (openFilePath) {
    pendingOpenByWc.set(wcId, openFilePath);
    allowedOpenPaths.add(openFilePath);
  }

  win.on("focus", () => {
    lastFocusedWindow = win;
  });

  win.on("closed", () => {
    windows.delete(win);
    pendingOpenByWc.delete(wcId);
    if (lastFocusedWindow === win) lastFocusedWindow = null;
  });

  // External http(s) links open in the default browser, not inside Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(appUrlFor(activePort))) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  return win;
}

function focusedOrLastWindow() {
  return BrowserWindow.getFocusedWindow() || lastFocusedWindow || null;
}

const LOADING_HTML =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>MRLatte</title>
     <style>
       html,body{height:100%;margin:0;background:#050505;color:#e8e8e8;
         font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;
         justify-content:center;flex-direction:column;gap:22px}
       .ring{width:52px;height:52px;border:4px solid #1f2937;border-top-color:#6366f1;
         border-radius:50%;animation:spin 1s linear infinite}
       @keyframes spin{to{transform:rotate(360deg)}}
       .t{font-size:20px;font-weight:600;letter-spacing:.5px}
       .s{font-size:13px;color:#9ca3af}
     </style></head><body>
       <div class="ring"></div>
       <div class="t">Starting MRLatte…</div>
       <div class="s">Loading the imaging engine — this can take a moment on first launch.</div>
     </body></html>`
  );

// Boots the backend AND creates the first window. Only ever called once per
// app run — every later window (a second Explorer double-click, or `activate`
// on macOS) goes through openNewWindow instead, since the backend is already
// up by then.
async function bootFirstWindow(openFilePath) {
  const win = createMainWindow(openFilePath);
  await win.loadURL(LOADING_HTML);
  try {
    if (!(await checkPort(BACKEND_PORT))) {
      // Fast path: our preferred port is free.
      activePort = BACKEND_PORT;
      await startBackend(BACKEND_PORT);
      if (!win.isDestroyed()) await win.loadURL(appUrlFor(BACKEND_PORT));
    } else if (await identifyExistingInstance(BACKEND_PORT)) {
      // Something's already listening on BACKEND_PORT and it fingerprints as
      // MRLatte's own backend (a leftover dev server or an orphaned previous
      // instance) — don't spawn a second backend, just load against it. It
      // already answered the fingerprint GET, so it's demonstrably live; no
      // health-check wait needed.
      activePort = BACKEND_PORT;
      if (!win.isDestroyed()) await win.loadURL(appUrlFor(BACKEND_PORT));
    } else {
      // An unrelated program occupies BACKEND_PORT — fall back to a free port.
      const port = await findFreePort();
      activePort = port;
      await startBackend(port);
      if (!win.isDestroyed()) await win.loadURL(appUrlFor(port));
    }
    backendReady = true;
    // Drain any file(s) that arrived via second-instance while we were
    // still booting (e.g. double-clicking a second file during the ~30s
    // first-run backend startup).
    const queued = pendingBoot.splice(0, pendingBoot.length);
    for (const p of queued) openNewWindow(p);
  } catch (err) {
    dialog.showErrorBox("MRLatte could not start", String(err && err.message ? err.message : err));
    stopServices();
    app.quit();
  }
}

// A later window once the backend is already running — no backend work, just
// a new BrowserWindow pointed at the same activePort.
function openNewWindow(openFilePath) {
  const win = createMainWindow(openFilePath);
  win.loadURL(appUrlFor(activePort));
  return win;
}

// Single entry point for "the OS handed us a file path to open" (cold-start
// argv or a second-instance relaunch). Queues behind the first boot if the
// backend isn't up yet.
function openFile(filePath) {
  if (!filePath) return;
  if (!backendReady) {
    pendingBoot.push(filePath);
    return;
  }
  openNewWindow(filePath);
}

// --------------------------------------------------------------------------- //
// Menu
// --------------------------------------------------------------------------- //
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => focusedOrLastWindow()?.webContents.reload() },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About MRLatte",
          click: () => {
            const win = focusedOrLastWindow();
            const opts = {
              type: "info",
              title: "About MRLatte",
              message: "MRLatte",
              detail:
                "Desktop neuroimaging visualization dashboard.\n" +
                "Niivue WebGL viewer · MNI152 · Wang 2015 · Benson 2014 · " +
                "AAL · Harvard-Oxford · Jülich · Destrieux\n\n" +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
              buttons: ["OK"],
            };
            if (win) dialog.showMessageBox(win, opts);
            else dialog.showMessageBox(opts);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------- //
// App lifecycle
// --------------------------------------------------------------------------- //
// Only one instance may run (two would fight over port 8001).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A relaunch while we're already running: a file path on its argv opens a
  // new window (sharing this process's one backend); otherwise, same as
  // before, just focus whatever window we have.
  app.on("second-instance", (_event, argv, workingDirectory) => {
    const filePath = niftiPathFromArgv(argv, workingDirectory);
    logQuickOpen(`second-instance argv=${JSON.stringify(argv)} cwd=${workingDirectory} resolvedPath=${filePath || "-"} backendReady=${backendReady}`);
    if (filePath) {
      openFile(filePath);
      return;
    }
    const win = focusedOrLastWindow() || [...windows][0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();

    if (isDev) {
      // Dev mode doesn't spawn a backend from here (the developer runs it
      // themselves), so it's "ready" for a second-instance open immediately.
      backendReady = true;
      const openPath = niftiPathFromArgv(process.argv);
      const win = createMainWindow(openPath);
      win.loadURL("http://localhost:3000/#/");
      win.webContents.openDevTools({ mode: "detach" });
    } else {
      const openPath = niftiPathFromArgv(process.argv);
      logQuickOpen(`cold-start argv=${JSON.stringify(process.argv)} resolvedPath=${openPath || "-"}`);
      bootFirstWindow(openPath);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (isDev) {
          const win = createMainWindow(null);
          win.loadURL("http://localhost:3000/#/");
        } else if (backendReady) {
          openNewWindow(null);
        } else {
          bootFirstWindow(null);
        }
      }
    });
  });

  // Ensure the backing services are always torn down with the app.
  app.on("before-quit", stopServices);
  app.on("will-quit", stopServices);
  process.on("exit", stopServices);

  app.on("window-all-closed", () => {
    stopServices();
    if (process.platform !== "darwin") app.quit();
  });
}
