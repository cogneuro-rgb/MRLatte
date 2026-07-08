# NeuroVue — Desktop (Windows) Build

The web app is wrapped with **Electron 33** to ship as a Windows desktop application. All atlas data (MNI152, Wang 2015, Benson 2014, AAL, Harvard-Oxford, Jülich, Destrieux, Conte69) is bundled inside the installer so the app runs **fully offline**.

## Quick start (end-users)

1. Download `NeuroVue-0.1.0-x64.zip` from `frontend/dist-electron/`
2. Right-click the `.zip` → **Extract All…** to any folder (e.g. `C:\Apps\NeuroVue\`)
3. Double-click `NeuroVue.exe` — the dashboard opens in its own window
4. On first launch, Windows SmartScreen may show *"Unrecognised app"* (because the build is unsigned). Click **More info → Run anyway**. See *Code-signing* below to remove this warning permanently.

> **System requirements**: Windows 10 / 11 (x64) · WebGL2-capable GPU · ≥ 4 GB RAM

## Developer commands

Run from `/app/frontend/`:

| Command | What it does |
|---|---|
| `yarn electron:start` | Runs CRA dev server + Electron in dev mode with DevTools (hot reload) |
| `yarn electron:build` | Builds for the current host platform |
| `yarn dist:win` | Builds a Windows x64 zip → `dist-electron/NeuroVue-${version}-x64.zip` |
| `yarn dist:linux` | Builds a Linux AppImage |
| `yarn dist:mac` | Builds a macOS dmg |

## Build output

```
frontend/dist-electron/
├── NeuroVue-0.1.0-x64.zip       ← Ship this (~160 MB compressed)
└── win-unpacked/
    ├── NeuroVue.exe             ← Main executable
    ├── resources/app.asar       ← React build + atlases bundled here
    ├── *.dll, *.pak, locales/   ← Chromium runtime
    └── …
```

The zipped app is **~160 MB** compressed (~522 MB extracted) — that includes the full Chromium runtime + WebGL2 stack so the same niivue render works identically to the web preview.

## Architecture

- `public/electron.js` — main process (window creation, menu, file-open dialogs)
- `public/preload.js` — context-bridge exposing `window.neurovue.isDesktop`
- `electron/build-resources/icon.{ico,png}` — app icons (Windows + Linux)
- React frontend is untouched — same `Dashboard.jsx`, same niivue viewer, only the router was switched to `HashRouter` so it works under `file://`

## Building a true `.exe` installer (NSIS)

The current build target is `zip` because this CI host is **arm64 Linux**, and electron-builder's NSIS toolchain requires **x64**. To produce a proper double-click installer (`NeuroVue-Setup.exe`), run on **any x64 machine** (Windows, macOS, or x64 Linux with Wine):

```bash
# On Windows / x64 Linux / macOS:
cd frontend
yarn install
yarn dist:win   # after changing target back to "nsis"
```

Re-enable NSIS by editing `package.json → build.win.target`:

```json
"target": [
  { "target": "nsis", "arch": ["x64"] }
]
```

The output `NeuroVue-Setup-0.1.0-x64.exe` is a Windows installer with Start-Menu + Desktop shortcuts that lets users pick the install path.

## Code-signing (optional but recommended for distribution)

To remove the SmartScreen *"Unrecognised app"* warning:

1. Buy an OV or EV Windows code-signing certificate (Sectigo / DigiCert / SSL.com, ~ $200–500 / year)
2. Set environment variables before running `yarn dist:win`:
   ```bash
   export CSC_LINK=path/to/cert.pfx
   export CSC_KEY_PASSWORD=your-cert-password
   ```
3. Re-enable signing by removing `"signAndEditExecutable": false` from `package.json → build.win`
4. Rebuild — electron-builder will sign `NeuroVue.exe` and the installer automatically

## Notes

- The FastAPI backend (`/app/backend/server.py`) is **not** bundled. All neuroimaging analysis runs client-side via niivue. If you later add backend features, point them at a hosted API URL or bundle FastAPI separately with a tool like `pyinstaller`.
- The app writes nothing outside its temp folder — screenshots and saved drawings prompt the user with the OS Save dialog.
