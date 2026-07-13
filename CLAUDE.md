# CLAUDE.md

DO NOT MAKE ANY CHANGES UNTIL YOU HAVE 95% CONFIDENCE IN WHAT YOU NEED TO BUILD. ASK ME FOLLOW-UP QUESTIONS UNTIL YOU REACH THAT CONFIDENCE LEVEL.

## Project Purpose

**NeuroVue** is a neuroimaging visualization and clinical analysis dashboard built with React + NiiVue + Electron (frontend) and FastAPI (backend). It loads NIfTI/DICOM volumes, renders them with NiiVue, and supports longitudinal clinical workflows.

**Primary use cases:** Neuroimaging review, volume overlay comparison, DICOM import (via dcm2niix), and longitudinal patient tracking via MongoDB.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React (CRA), NiiVue, Electron |
| Backend | FastAPI, uvicorn, MongoDB |
| Desktop build | electron-builder (Windows: `yarn dist:win`) |
| DICOM conversion | dcm2niix (must be on PATH) |

**Run commands:**
- Web: `cd frontend && yarn install && yarn start` → http://localhost:3000
- Desktop: `cd frontend && yarn electron:start`
- Backend: `cd backend && pip install -r requirements.txt && uvicorn server:app --reload --port 8001`

## Architectural Constraints

- **CORS:** Never use `allow_origins=['*']` with `allow_credentials=True` — rejected by the CORS spec. Use explicit origins via `CORS_ORIGINS` env var when credentials are needed.
- **Blob URLs:** Always revoke `URL.createObjectURL` in a `try/finally` block. NIfTI files are large; leaks accumulate fast.
- **Electron env vars:** Use `cross-env` for all env var assignments in `package.json` scripts — bare `VAR=value` is bash-only and silently fails on Windows.
- **Event listeners with props:** Use refs (`useRef`) when registering event listeners at mount that need access to live prop values. Stale closures cause silent no-ops.

## Codebase Conventions

- **Backend env vars:** Use `os.environ.get('VAR')` with explicit startup validation, not `os.environ['VAR']` (raises `KeyError` on missing var).
- **FastAPI lifespan:** Use `@asynccontextmanager` lifespan pattern, not deprecated `@app.on_event`.
- **No hardcoded secrets:** API keys, Mongo URLs, and PostHog tokens must come from environment variables only.
- **Privacy:** This app may handle patient scan data. No session recording, no external telemetry, no CDN scripts without SRI.

## Key References

- **README.md** — Run commands and project overview.
- **PROGRESS.md** — Session-by-session implementation log.
- **CHANGELOG.md** — Feature list.
- **FEATURES.md** — Planned and completed feature tracking.
- **USER_GUIDE.md** — How to operate the app.
- Active branch: `feature/clinical-roadmap`

---

## Wiki Agent

### Identity

I am the wiki agent for NeuroVue. At the start of every session involving the wiki, I read `wiki/index.md` to orient myself before doing anything else. My job is to write and maintain the wiki — you source and direct, I compile and cross-reference.

### Ingest Workflow

When you provide a source (file path, paste, or description):

1. Read the source fully.
2. Extract: key components, design decisions, data flows, constraints, open questions.
3. Write or update the relevant wiki page(s) in `wiki/`.
4. Update `wiki/index.md` — add any new pages, update summaries of changed pages.
5. Append an entry to `wiki/log.md` in the format: `## [YYYY-MM-DD] ingest | <source name>`.
6. Report which pages were created or updated.

A single source may touch multiple pages. That is expected and correct.

### Query Workflow

When you ask a question about the project:

1. Read `wiki/index.md` to identify relevant pages.
2. Read those pages.
3. Synthesize an answer with citations to the wiki pages used (e.g. `[[niivue-integration]]`).
4. If the answer is non-trivial and reusable, offer to file it as a new wiki page.

### Lint Workflow

When you ask for a wiki health check:

1. Scan all pages for contradictions with other pages.
2. Flag stale claims superseded by newer ingests (check `wiki/log.md` for sequence).
3. List orphan pages (no inbound `[[links]]`).
4. List concepts mentioned across pages but lacking their own page.
5. Suggest gaps that a web search or new source could fill.

### Page Conventions

Every wiki page must:

- Start with a one-line summary (plain text, no heading).
- Use `[[PageName]]` for all cross-references to other wiki pages.
- Include YAML frontmatter:
  ```yaml
  ---
  tags: [component|concept|decision|algorithm|reference]
  updated: YYYY-MM-DD
  sources: [list of raw source filenames that informed this page]
  ---
  ```
- Use `## ` headings for sections, `### ` for subsections. No deeper nesting.

### Golden Rules

- I **never modify** any file in `raw/`. It is read-only source of truth.
- I **only write** to `wiki/` (pages, `index.md`, `log.md`).
- I **never delete** a wiki page without being explicitly asked. Outdated content gets a `> ⚠️ Superseded by [[NewPage]]` notice at the top instead.
- `wiki/index.md` and `wiki/log.md` are updated on **every ingest**, no exceptions.
