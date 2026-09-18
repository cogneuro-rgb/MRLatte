// Optional-module manifest client.
//
// The app ships without its large assets (whole-brain tractogram, connectome
// bundle, atlas packs) and without the heavy plotting/validation Python stacks.
// `/api/modules` is the ONLY source of truth for what is installed.
//
// Do NOT try to detect a missing asset by fetching its URL: backend/server.py
// falls any non-/api 404 back to index.html with status 200, so a missing
// atlas "succeeds" and NiiVue then chokes trying to parse the app shell as a
// NIfTI. /api/* paths do return real JSON 404s, which is why this endpoint is
// safe to probe.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

/**
 * @returns {Promise<{
 *   ok: boolean, reason?: string,
 *   modules: Array<{
 *     id, name, description, type, tier, version, bytes, bytesHuman,
 *     unlocks: string[], installed: boolean, verified: boolean,
 *     missing: string[], path: string|null, sources: object[], license: object
 *   }>,
 *   capabilities: Record<string, boolean>,
 *   installable: boolean
 * }>}
 */
export async function fetchModules() {
  try {
    const r = await fetch(`${apiBase}/api/modules`);
    if (!r.ok) {
      return { ok: false, reason: `HTTP ${r.status}`, modules: [], capabilities: {}, installable: false };
    }
    const data = await r.json();
    return {
      ok: true,
      modules: Array.isArray(data?.modules) ? data.modules : [],
      capabilities: data?.capabilities || {},
      installable: !!data?.installable,
      moduleRoot: data?.moduleRoot,
      // Optional, for the store's pre-install free-space check. Absent on a
      // backend that does not report it — the check is then simply skipped.
      freeBytes: firstNumber(data?.freeBytes, data?.diskFree, data?.free_bytes),
    };
  } catch (e) {
    // Backend not running (web dev without uvicorn, or Electron before the
    // sidecar is up). Callers must treat this as "unknown", not "missing".
    return { ok: false, reason: e.message, modules: [], capabilities: {}, installable: false };
  }
}

/** Human-readable byte size. Mirrors the backend's `bytesHuman`; used as a
 *  fallback when an older backend response omits it. */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "unknown size";
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let out = v;
  for (let i = 0; i < units.length; i += 1) {
    out /= 1024;
    if (out < 1024 || i === units.length - 1) {
      return `${out < 10 ? out.toFixed(1) : Math.round(out)} ${units[i]}`;
    }
  }
  return `${Math.round(out)} TB`;
}

/** Size label for a module record, preferring the server-rendered string. */
export function moduleSize(m) {
  return m?.bytesHuman || formatBytes(m?.bytes);
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// === Manifest shape helpers ==================================================
// Two module shapes exist and neither may be assumed:
//   multi-file  -> `files: [{path, bytes, sha256}]`, module-level sha256 null
//   single-file -> module-level `sha256`, no `files`
// (see modules/manifest.json). A phase-3 backend omits both fields entirely,
// so every accessor below degrades to "unknown" rather than to a wrong claim.

/** Per-file records for a multi-file module; [] for single-file or unknown. */
export function moduleFiles(m) {
  return Array.isArray(m?.files) ? m.files : [];
}

/** Module-level sha256 (single-file modules only), or null. */
export function moduleSha256(m) {
  return typeof m?.sha256 === "string" && m.sha256 ? m.sha256 : null;
}

/** `data` modules install by download/upload; `slot` modules install by PATH
 *  (see slotInstallModule). Only `python-package` modules remain uninstallable
 *  from the app — their pip source is deliberately not shelled out to. */
export function isInstallableType(m) {
  return ["data", "slot"].includes(m?.type || "data");
}

/** A user-supplied payload selected by path rather than uploaded. */
export function isSlotModule(m) {
  return (m?.type || "data") === "slot";
}

/** The extensions a slot accepts, e.g. [".trk"]. */
export function slotExtensions(m) {
  return (m?.slot?.extensions || []).filter(Boolean);
}

/** The manifest's `redistributable` flag. Defaults to true only when a licence
 *  block is absent; an explicit `false` means we may never serve the bytes. */
export function isRedistributable(m) {
  return m?.license?.redistributable !== false;
}

/** Unresolved provenance warning (lnm-connectome-d100 carries one). */
export function provenanceReview(m) {
  return m?.license?.provenanceReview || null;
}

/** A source MRLatte can actually fetch bytes from. `upstream` entries are
 *  landing pages, not direct downloads, so they do NOT count. */
export function downloadSource(m) {
  return (m?.sources || []).find(
    (s) => s && (s.type === "github-release" || s.type === "url" || s.type === "http"),
  ) || null;
}

/** The human landing page a user must visit to obtain a non-redistributable
 *  module themselves. */
export function upstreamSource(m) {
  return (m?.sources || []).find((s) => s && s.type === "upstream") || null;
}

export function acceptsSideload(m) {
  const sources = m?.sources || [];
  return !sources.length || sources.some((s) => s && s.type === "sideload");
}

/**
 * "installed" | "broken" | "missing".
 *
 * An explicit backend state wins. The fallback only calls a module `broken`
 * when the response proves a PARTIAL install (some required files present,
 * some not) — never on a guess, and never by probing an asset URL.
 */
export function moduleStatus(m) {
  if (!m) return "missing";
  const s = String(m.state || m.status || "").toLowerCase();
  if (s === "installed" || s === "broken" || s === "missing") return s;
  if (m.broken === true) return "broken";
  if (m.installed) return "installed";
  const files = moduleFiles(m);
  const missing = Array.isArray(m.missing) ? m.missing : [];
  if (files.length && missing.length && missing.length < files.length) return "broken";
  return "missing";
}

// === Installer API (phase 4) =================================================
// Endpoint contract: plans/phase-4.md.
//   POST   /api/modules/{id}/sideload   multipart upload
//   POST   /api/modules/{id}/install    -> { job_id }
//   GET    /api/modules/jobs/{job_id}   -> { stage, progress, bytes_done, bytes_total, error }
//   POST   /api/modules/{id}/cancel
//   DELETE /api/modules/{id}
//   POST   /api/modules/{id}/verify
//
// Every one of these may be absent from the running backend (an older build,
// or a sidecar that has not been restarted). `/api/*` returns real JSON 404s —
// unlike static paths, which server.py rewrites to index.html with status 200 —
// so a 404/405 here is trustworthy and is surfaced as `missing: true`, which
// the UI reports as "not available in the running backend" rather than as a
// failed install.

async function apiRequest(path, { method = "GET", body, headers } = {}) {
  let r;
  try {
    r = await fetch(`${apiBase}${path}`, { method, body, headers });
  } catch (e) {
    return { ok: false, unreachable: true, error: e?.message || "backend unreachable" };
  }
  let text = "";
  try { text = await r.text(); } catch { /* empty body */ }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!r.ok) {
    const detail = data?.detail || data?.error || data?.message;
    // Some endpoints answer with a structured detail ({error, reason}) so the
    // cause survives to the UI — the slot validators and the archive-boundary
    // check both do. Flattening to `HTTP 400` here would throw away the only
    // part the user can act on.
    const text = typeof detail === "string"
      ? detail
      : (detail && typeof detail === "object"
        ? [detail.error, detail.reason].filter(Boolean).join(" — ")
        : "");
    return {
      ok: false,
      status: r.status,
      missing: r.status === 404 || r.status === 405 || r.status === 501,
      error: text || `HTTP ${r.status}`,
      data,
    };
  }
  return { ok: true, status: r.status, data: data ?? {} };
}

/** POST a JSON body, retrying without one if the endpoint turns out to expect
 *  form data or no body at all (422). Keeps us compatible with either signature
 *  the backend lands on. */
async function postJson(path, payload) {
  const res = await apiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (res.ok || res.status !== 422) return res;
  return apiRequest(path, { method: "POST" });
}

const enc = (id) => encodeURIComponent(id);

/**
 * Job id out of whatever key the backend used, or null for a synchronous
 * endpoint. Deliberately does NOT fall back to a bare `id`: the sideload,
 * uninstall and verify responses all carry `"id": <module id>`, and treating
 * that as a job id would poll /api/modules/jobs/<module-id> forever.
 */
export function jobIdOf(data) {
  return data?.job_id || data?.jobId || data?.job?.id || null;
}

/** Start the download install path. @returns apiRequest result; job id via jobIdOf(res.data). */
export function installModule(id, { repair = false } = {}) {
  return postJson(`/api/modules/${enc(id)}/install`, { repair });
}

/** Poll a running install/verify job. */
export function moduleJobStatus(jobId) {
  return apiRequest(`/api/modules/jobs/${enc(jobId)}`);
}

/** Ask the backend to stop the module's running job. `jobId` is a query
 *  parameter; omitting it makes the backend cancel that module's latest job. */
export function cancelModuleJob(id, jobId) {
  const q = jobId ? `?job_id=${enc(jobId)}` : "";
  return postJson(`/api/modules/${enc(id)}/cancel${q}`, {});
}

/** Remove an installed module. The backend refuses for legacy-tier assets
 *  (a dev checkout) — that refusal is surfaced verbatim. */
export function uninstallModule(id) {
  return apiRequest(`/api/modules/${enc(id)}`, { method: "DELETE" });
}

/** Deep streamed SHA-256. May answer inline (per-file results) or hand back a
 *  job id for long files — callers must handle both. */
export function verifyModule(id) {
  return postJson(`/api/modules/${enc(id)}/verify`, {});
}

/**
 * Install a slot module from a filesystem PATH.
 *
 * `mode: "copy"` duplicates the file into the slot directory; `mode: "link"`
 * registers it where it already sits, which is why this takes a path instead of
 * an upload — a 673 MB tractogram should not have to move at all, let alone
 * travel through HTTP. The backend validates the file structurally before
 * anything happens, so a wrong file comes back immediately with the validator's
 * own reason rather than after a long transfer.
 */
export function slotInstallModule(id, path, mode = "copy") {
  return postJson(`/api/modules/${enc(id)}/slot-install`, { path, mode });
}

/** True when a native file picker is reachable (desktop build only). */
export function canPickFiles() {
  return typeof window !== "undefined" && !!window.mrlatte?.pickModuleFile;
}

/**
 * Native picker for a slot payload, resolving to an absolute path.
 *
 * Desktop only: Electron 32 removed `File.path`, so a browser `<input>` cannot
 * yield a path and there is nothing for the backend to copy or register. In the
 * browser build callers fall back to `sideloadModule`.
 *
 * @returns {Promise<string|null>} path, or null if cancelled/unavailable.
 */
export async function pickSlotFile(m) {
  if (!canPickFiles()) return null;
  const exts = slotExtensions(m);
  const r = await window.mrlatte.pickModuleFile(m?.name || "Module file", exts);
  return r && !r.canceled ? r.filePath : null;
}

/**
 * Upload a module archive (or, for a single-file module, the file itself).
 *
 * XHR rather than fetch: a sideload is up to 706 MB and upload progress is the
 * only feedback there is until the server starts hashing. `signal` aborts the
 * transfer.
 *
 * @returns {Promise<{ok, data?, error?, status?, missing?, aborted?, unreachable?}>}
 */
export function sideloadModule(id, file, { onProgress, signal } = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase}/api/modules/${enc(id)}/sideload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onerror = () => resolve({ ok: false, unreachable: true, error: "upload failed — backend unreachable" });
    xhr.onabort = () => resolve({ ok: false, aborted: true, error: "upload cancelled" });
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, status: xhr.status, data: data ?? {} });
        return;
      }
      const detail = data?.detail || data?.error || data?.message;
      resolve({
        ok: false,
        status: xhr.status,
        missing: xhr.status === 404 || xhr.status === 405 || xhr.status === 501,
        error: typeof detail === "string" && detail ? detail : `HTTP ${xhr.status}`,
        data,
      });
    };
    const fd = new FormData();
    fd.append("file", file, file.name);
    xhr.send(fd);
    if (signal) {
      if (signal.aborted) xhr.abort();
      else signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
  });
}

/**
 * Normalise a job status payload.
 *
 * plans/phase-4.md documents { stage, progress, bytes_done, bytes_total, error }
 * while every existing MRLatte job also carries `done` and `message`
 * (backend/deps.py's set_job_status). Accept either: `done` when present,
 * otherwise a terminal stage name or a set error.
 */
const TERMINAL_STAGES = new Set([
  "done", "complete", "completed", "finished", "ok", "installed",
  "error", "failed", "cancelled", "canceled",
]);

export function normalizeJob(s) {
  const raw = s || {};
  const stage = String(raw.stage || raw.state || "running");
  const key = stage.toLowerCase();
  const error = raw.error || null;
  const cancelled = key === "cancelled" || key === "canceled";
  const done = typeof raw.done === "boolean"
    ? raw.done || !!error
    : TERMINAL_STAGES.has(key) || !!error;
  const bytesDone = firstNumber(raw.bytes_done, raw.bytesDone);
  const bytesTotal = firstNumber(raw.bytes_total, raw.bytesTotal);
  let progress = firstNumber(raw.progress);
  if (progress === null && bytesTotal > 0 && bytesDone !== null) progress = bytesDone / bytesTotal;
  // Tolerate a 0..100 backend as well as the 0..1 one every existing job uses.
  if (progress !== null && progress > 1) progress = progress / 100;
  if (progress !== null) progress = Math.max(0, Math.min(1, progress));
  return {
    stage,
    message: raw.message || null,
    progress,
    bytesDone,
    bytesTotal,
    error: typeof error === "string" ? error : error ? JSON.stringify(error) : null,
    cancelled,
    done,
    result: raw.result ?? null,
  };
}

/** Byte transfer label, e.g. "12.4 MB / 706 MB". */
export function transferLabel(bytesDone, bytesTotal) {
  if (bytesDone === null || bytesDone === undefined) return null;
  if (!bytesTotal) return formatBytes(bytesDone);
  return `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`;
}
