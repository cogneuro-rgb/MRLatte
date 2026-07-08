// NeuroVue — Electron main process
//
// Two modes:
//   * DEV  (NEUROVUE_DEV=1, unpackaged): load the CRA dev server at :3000. The
//     developer runs MongoDB + the FastAPI backend themselves. No spawning here.
//   * PACKAGED (installed .exe): this process starts the WHOLE offline stack —
//     it spawns the bundled portable MongoDB and the embedded-Python FastAPI
//     backend (which serves the built React app + API on 127.0.0.1:8001), waits
//     for the backend to answer /api/, then loads that URL into the window.
//     Everything is bundled as electron-builder `extraResources`, so the app is
//     fully self-contained and works with no internet.
//
// To test the packaged code path WITHOUT building an installer, run:
//   set NEUROVUE_RES_DIR=<repo>\dist\NeuroVue && npx electron .
// which points resourcesDir() at an assemble-bundle.ps1 output folder.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execFile } = require("child_process");

const BACKEND_PORT = 8001;
const MONGO_PORT = 27117;
const APP_URL = `http://127.0.0.1:${BACKEND_PORT}/`;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/`;

const MONGO_START_TIMEOUT_MS = 30000;
const BACKEND_START_TIMEOUT_MS = 120000; // heavy sci-stack import can be slow on 1st run

const isDev = !app.isPackaged && process.env.NEUROVUE_DEV === "1";

let mainWindow = null;
let mongoProc = null;
let backendProc = null;
let shuttingDown = false;

// --------------------------------------------------------------------------- //
// Paths
// --------------------------------------------------------------------------- //
// extraResources are copied into resources/ next to the packaged app. The test
// override lets us exercise this path against an assemble-bundle.ps1 folder.
function resourcesDir() {
  return process.env.NEUROVUE_RES_DIR || process.resourcesPath;
}

// Per-user, machine-local data (db + lesions + logs). Uses %LOCALAPPDATA% so it
// is NOT roaming (a Mongo dbpath must not be synced) and needs no admin rights.
function dataDir() {
  const base = process.env.LOCALAPPDATA || app.getPath("userData");
  return path.join(base, "NeuroVue");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
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
// Spawn the backing services
// --------------------------------------------------------------------------- //
async function startMongo() {
  const res = resourcesDir();
  const mongod = path.join(res, "mongo", "mongod.exe");
  if (!fs.existsSync(mongod)) {
    throw new Error(`MongoDB engine not found:\n${mongod}\nThe installation looks incomplete.`);
  }
  const dbDir = ensureDir(path.join(dataDir(), "db"));
  const out = logStream("mongod.log");
  mongoProc = spawn(
    mongod,
    ["--dbpath", dbDir, "--port", String(MONGO_PORT), "--bind_ip", "127.0.0.1"],
    { stdio: ["ignore", out, out], windowsHide: true }
  );
  mongoProc.on("exit", (code) => {
    if (!shuttingDown) onServiceCrash("MongoDB", code);
  });
  const ok = await waitFor(() => checkPort(MONGO_PORT), MONGO_START_TIMEOUT_MS);
  if (!ok) {
    throw new Error(
      "The database did not start in time.\n" +
        "On older PCs this can mean the CPU lacks AVX support.\n" +
        "See logs\\mongod.log in your NeuroVue data folder."
    );
  }
}

async function startBackend() {
  const res = resourcesDir();
  const python = path.join(res, "python", "python.exe");
  const backendDir = path.join(res, "backend");
  const sitePkgs = path.join(res, "python", "site-packages");
  const staticDir = path.join(res, "frontend_build");
  const scriptsDir = path.join(res, "scripts");
  const dataFilesDir = path.join(res, "data");
  if (!fs.existsSync(python)) {
    throw new Error(`Embedded Python not found:\n${python}\nThe installation looks incomplete.`);
  }

  const dd = dataDir();
  const env = Object.assign({}, process.env, {
    MONGO_URL: `mongodb://127.0.0.1:${MONGO_PORT}`,
    DB_NAME: "neurovue",
    STATIC_DIR: staticDir,
    ATLAS_DIR: path.join(staticDir, "atlases"),
    LESION_DIR: path.join(dd, "lesions"),
    TRACT_RESULTS_DIR: path.join(dd, "tract_results"),
    ROI_RESULTS_DIR: path.join(dd, "roi_results"),
    DICOM_RESULTS_DIR: path.join(dd, "dicom_results"),
    LNM_RESULTS_DIR: path.join(dd, "lnm_results"),
    SUMMARY_RESULTS_DIR: path.join(dd, "summary_results"),
    LNM_BUNDLE: path.join(dataFilesDir, "lnm_bundle_d100.npz"),
    GLOBAL_TRACT_FILE: path.join(dataFilesDir, "tracts", "S35_1mm.trk"),
    VALIDATION_DIR: path.join(scriptsDir, "validation_plots"),
    VALIDATION_REPORT: path.join(scriptsDir, "benson_validation_report.txt"),
    // dcm2niix on PATH so the backend's shutil.which("dcm2niix") resolves.
    PATH: path.join(res, "dcm2niix") + path.delimiter + (process.env.PATH || ""),
    PYTHONUNBUFFERED: "1",
  });
  delete env.CORS_ORIGINS; // same-origin (localhost:8001) — no CORS needed

  ensureDir(path.join(dd, "lesions"));

  // The embeddable Python's python*._pth makes it IGNORE PYTHONPATH, so we add
  // site-packages + backend to sys.path at runtime via a -c bootstrap. This also
  // keeps the bundle relocatable (all paths computed here at launch).
  const bootstrap =
    "import sys, os;" +
    `sys.path.insert(0, r'${sitePkgs}');` +
    `sys.path.insert(0, r'${backendDir}');` +
    `os.chdir(r'${backendDir}');` +
    "import uvicorn;" +
    `uvicorn.run('server:app', host='127.0.0.1', port=${BACKEND_PORT})`;

  const out = logStream("backend.log");
  backendProc = spawn(python, ["-c", bootstrap], {
    cwd: backendDir,
    env,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  backendProc.on("exit", (code) => {
    if (!shuttingDown) onServiceCrash("NeuroVue backend", code);
  });
  const ok = await waitFor(() => checkHttp(HEALTH_URL), BACKEND_START_TIMEOUT_MS);
  if (!ok) {
    throw new Error(
      "The NeuroVue application did not respond in time.\n" +
        "See logs\\backend.log in your NeuroVue data folder."
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
  killTree(mongoProc);
}

function onServiceCrash(name, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  dialog.showErrorBox(
    "NeuroVue stopped",
    `${name} exited unexpectedly (code ${code}).\n` +
      "NeuroVue will now close. Check the logs in your NeuroVue data folder."
  );
  killTree(backendProc);
  killTree(mongoProc);
  app.quit();
}

// --------------------------------------------------------------------------- //
// IPC (local file save/open) — unchanged, works regardless of loaded URL
// --------------------------------------------------------------------------- //
function registerIpc() {
  ipcMain.handle("neurovue:saveWorkspace", async (_e, json) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: "workspace.nvws.json",
      filters: [{ name: "NeuroVue Workspace", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.promises.writeFile(r.filePath, json, "utf8");
    return { canceled: false, filePath: r.filePath };
  });

  ipcMain.handle("neurovue:openWorkspace", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "NeuroVue Workspace", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const json = await fs.promises.readFile(r.filePaths[0], "utf8");
    return { canceled: false, json };
  });

  ipcMain.handle("neurovue:saveFile", async (_e, { defaultName, base64 }) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.promises.writeFile(r.filePath, Buffer.from(base64, "base64"));
    return { canceled: false, filePath: r.filePath };
  });
}

// --------------------------------------------------------------------------- //
// Window
// --------------------------------------------------------------------------- //
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: "#050505",
    title: "NeuroVue",
    autoHideMenuBar: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // External http(s) links open in the default browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

const LOADING_HTML =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>NeuroVue</title>
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
       <div class="t">Starting NeuroVue…</div>
       <div class="s">Loading the imaging engine — this can take a moment on first launch.</div>
     </body></html>`
  );

async function startPackagedApp() {
  createMainWindow();
  await mainWindow.loadURL(LOADING_HTML);
  try {
    // Guard against a stale/duplicate instance holding the ports.
    if (await checkPort(BACKEND_PORT)) {
      throw new Error(
        `Port ${BACKEND_PORT} is already in use. NeuroVue may already be running.\n` +
          "Close the other instance (or reboot) and try again."
      );
    }
    await startMongo();
    await startBackend();
    if (mainWindow) await mainWindow.loadURL(APP_URL);
  } catch (err) {
    dialog.showErrorBox("NeuroVue could not start", String(err && err.message ? err.message : err));
    stopServices();
    app.quit();
  }
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
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
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
          label: "About NeuroVue",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About NeuroVue",
              message: "NeuroVue",
              detail:
                "Desktop neuroimaging visualization dashboard.\n" +
                "Niivue WebGL viewer · MNI152 · Wang 2015 · Benson 2014 · " +
                "AAL · Harvard-Oxford · Jülich · Destrieux\n\n" +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
              buttons: ["OK"],
            });
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
// Only one instance may run (two would fight over ports 8001 / 27117).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    buildMenu();

    if (isDev) {
      createMainWindow();
      mainWindow.loadURL("http://localhost:3000/#/");
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
      startPackagedApp();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (isDev) createMainWindow();
        else startPackagedApp();
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
