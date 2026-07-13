# NeuroVue

Neuroimaging visualization + clinical analysis dashboard (React + Niivue + Electron, FastAPI backend).

## Run

- **Web:** `cd frontend && yarn install && yarn start` → http://localhost:3000
- **Desktop:** `cd frontend && yarn electron:start` (CRA dev server + Electron together)
- **Desktop build (Windows):** `cd frontend && yarn dist:win` → `frontend/dist-electron/`
- **Backend (optional; needed for DICOM import + longitudinal):**
  `cd backend && pip install -r requirements.txt && uvicorn server:app --reload --port 8001`
  - DICOM import also needs the `dcm2niix` binary on PATH.

See `USER_GUIDE.md` for how to operate the app and how each feature works,
`PROGRESS.md` for the implementation log, and `CHANGELOG.md` for the feature
list. Active work is on the `feature/clinical-roadmap` branch.

---

# Notes / Original Instructions


Changes Made
1. Emergent logo removed — frontend/public/index.html
Removed the Made with Emergent badge (fixed bottom-right overlay)
Removed the emergent-main.js CDN script (was loading an external script on every page load)
Removed the PostHog session recording script (was recording all user sessions including cross-origin iframes)
Fixed the meta description from "A product of emergent.sh" to "NeuroVue — Neuroimaging Visualization Dashboard"
2. Desktop app fixed for Windows — frontend/package.json
The electron:dev script used bare NEUROVUE_DEV=1 which is bash-only and silently fails on Windows — the env var is never set, so Electron falls back to loading build/index.html instead of localhost:3000
Fixed to use cross-env (already in devDependencies): cross-env NEUROVUE_DEV=1 wait-on ...
To run the desktop app: yarn electron:start (starts CRA dev server + Electron together), or yarn dist:win for a production .zip build
Bugs & Security Issues Found
Security:

[FIXED] CORS credentials + wildcard origins — backend/server.py: allow_credentials=True with allow_origins=['*'] is rejected by the CORS spec; browsers silently fail credentialed requests. Fixed to only enable credentials when explicit origins are configured via CORS_ORIGINS env var.
[FIXED] PostHog session recording removed — For a neuroimaging tool that may handle patient scan data, recording all user sessions (including cross-origin iframes) is a significant privacy risk.
External script without SRI — emergent-main.js was loaded from a CDN with no Subresource Integrity hash; a compromised CDN could inject arbitrary code. Removed entirely now.
PostHog API key was hardcoded in the HTML — **. Removed.
Bugs:

[FIXED] Double-click handler stale closure — NiivueViewer.jsx:150: The handleDblClick registered at mount checked if (!onDoubleClickSlice) using the stale prop from mount time, not the live ref. If the prop was undefined at mount but later set, double-click swap would silently no-op forever. Both the guard check and the invocation now use onDoubleClickSliceRef.current.
[FIXED] Blob URL memory leaks — replaceBaseVolume, addOverlayFromFile, and addMeshFromFile all called URL.createObjectURL but never URL.revokeObjectURL. For a medical imaging app loading large NIfTI files repeatedly, this causes significant memory accumulation. Fixed with try/finally to always revoke.
Backend MongoDB crash on missing env var — server.py:19 — os.environ['MONGO_URL'] raises KeyError at startup if the env var isn't set. Consider os.environ.get('MONGO_URL') with a startup validation message.
@app.on_event("shutdown") deprecated — FastAPI has deprecated this in favor of @asynccontextmanager lifespan. Not broken now but will generate warnings in newer FastAPI versions