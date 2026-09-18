// lqtpy-backed lesion-metrics API client (backend/routers/lesion_metrics.py).
// Pure HTTP layer + the dev-only engine-override switch — no atlas/volume math
// here (that stays in lesionReport.js, which composes this client with the JS
// engine to pick lqtpy vs. JS and fall back visibly). Mirrors the fetch/error
// conventions of lib/summary.js and lib/lesions.js.

import { useEffect, useState } from "react";

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

/** Carries the HTTP status so callers can tell 503 (engine unavailable) from
 * a 4xx caller error (bad/empty lesion, unknown atlas) from a 5xx environment
 * error — the three have different UI treatments (see lesionReport.js). */
export class LesionMetricsHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LesionMetricsHttpError";
    this.status = status;
  }
}

async function readErrorDetail(r) {
  let detail = `HTTP ${r.status}`;
  try {
    const body = await r.json();
    detail = body?.detail || detail;
  } catch { /* keep status */ }
  return detail;
}

// --------------------------------------------------------------------------- #
// Capabilities — cached; getCapabilities({ forceRefresh: true }) re-fetches.
// --------------------------------------------------------------------------- #
let _capabilitiesPromise = null;

export function getCapabilities({ forceRefresh = false } = {}) {
  if (forceRefresh || !_capabilitiesPromise) {
    _capabilitiesPromise = (async () => {
      const r = await fetch(`${apiBase}/api/lesion/capabilities`);
      if (!r.ok) throw new LesionMetricsHttpError(await readErrorDetail(r), r.status);
      return r.json();
    })().catch((e) => {
      _capabilitiesPromise = null; // never cache a failed lookup
      throw e;
    });
  }
  return _capabilitiesPromise;
}

// --------------------------------------------------------------------------- #
// Upload — content-addressed, deduplicated client-side by sha256 so an
// unchanged lesion (e.g. re-running Overlap after switching atlases) never
// re-uploads. Per-tab only: the map is module-level, not persisted, so a
// reload re-uploads once, same as the backend's own content-addressing would
// require anyway.
// --------------------------------------------------------------------------- #
const _uploadedByHash = new Map(); // sha256 hex -> lesion_id

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {File|Blob} fileOrBlob @returns {Promise<string>} lesion_id */
export async function uploadLesion(fileOrBlob) {
  const hash = await sha256Hex(fileOrBlob);
  const cached = _uploadedByHash.get(hash);
  if (cached) return cached;

  const fd = new FormData();
  fd.append("file", fileOrBlob, fileOrBlob.name || "lesion.nii.gz");
  const r = await fetch(`${apiBase}/api/lesion/upload`, { method: "POST", body: fd });
  if (!r.ok) throw new LesionMetricsHttpError(await readErrorDetail(r), r.status);
  const body = await r.json();
  _uploadedByHash.set(hash, body.lesion_id);
  return body.lesion_id;
}

// --------------------------------------------------------------------------- #
// Metrics
// --------------------------------------------------------------------------- #

/**
 * @param {{lesionId: string, atlasIds: string[], threshold?: number}} args
 * @returns {Promise<object>} { lesion_stats, atlas_overlap, provenance } —
 *   see backend/lesion_metrics.py::compute_metrics for the exact shape.
 */
export async function fetchMetrics({ lesionId, atlasIds, threshold }) {
  const r = await fetch(`${apiBase}/api/lesion/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lesion_id: lesionId, atlas_ids: atlasIds || [], threshold }),
  });
  if (!r.ok) throw new LesionMetricsHttpError(await readErrorDetail(r), r.status);
  return r.json();
}

// --------------------------------------------------------------------------- #
// Report fragments — lqtpy's embeddable HTML sections (morphometry detail,
// network rollup, streamline disconnection, ...) for parts of the report
// MRLatte doesn't render itself. See backend/lesion_metrics.py::
// build_report_fragments for the engine and lib/lesionReport.js::
// resolveReportFragments for the composition (upload + fetch + fail-soft).
// --------------------------------------------------------------------------- #

/**
 * @param {{lesionId: string, atlasIds?: string[], sections: string[], threshold?: number, theme?: object}} args
 * @returns {Promise<{stylesheet: string, fragments: object, unavailable: object, provenance: object}>}
 *   see backend/lesion_metrics.py::build_report_fragments for the exact shape.
 */
export async function fetchReportFragments({ lesionId, atlasIds = [], sections, threshold, theme }) {
  const r = await fetch(`${apiBase}/api/lesion/report-fragments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lesion_id: lesionId, atlas_ids: atlasIds || [], sections, threshold, theme,
    }),
  });
  if (!r.ok) throw new LesionMetricsHttpError(await readErrorDetail(r), r.status);
  return r.json();
}

// --------------------------------------------------------------------------- #
// Dev-only engine override — lets a developer force the JS engine for
// side-by-side comparison against lqtpy. Hidden in production builds (the
// toggle UI checks isDevBuild(); the override itself is also ignored outside
// dev builds, so a stray localStorage value from a previous dev session can
// never silently change a production build's behaviour). Persisted via
// localStorage under try/catch, same convention as hooks/use-theme.js — but
// NOT cached across reloads for uploaded-lesion hashes (see _uploadedByHash
// above), only for this preference.
// --------------------------------------------------------------------------- #
const DEV_ENGINE_STORAGE_KEY = "mrlatte-lesion-engine-dev";

export function isDevBuild() {
  return process.env.NODE_ENV !== "production";
}

function readDevEngineOverride() {
  try {
    return localStorage.getItem(DEV_ENGINE_STORAGE_KEY) === "js" ? "js" : null;
  } catch {
    return null;
  }
}

let _devEngineOverride = readDevEngineOverride();
const _devEngineListeners = new Set();

/** @returns {"js"|null} */
export function getDevEngineOverride() {
  return isDevBuild() ? _devEngineOverride : null;
}

export function setDevEngineOverride(next) {
  _devEngineOverride = next === "js" ? "js" : null;
  try {
    if (_devEngineOverride) localStorage.setItem(DEV_ENGINE_STORAGE_KEY, "js");
    else localStorage.removeItem(DEV_ENGINE_STORAGE_KEY);
  } catch { /* storage unavailable */ }
  _devEngineListeners.forEach((fn) => fn(_devEngineOverride));
}

/**
 * React hook for the dev-engine toggle. A module-level pub/sub (not just
 * useState) so the OverlapPanel and LesionReportPanel instances mounted
 * side-by-side under the same lesion (LesionMasksSection's renderLayerExtra)
 * stay in sync when either one flips the switch — a plain per-component
 * useState would only update the component that changed it.
 */
export function useLesionEngineDevOverride() {
  const [value, setValue] = useState(_devEngineOverride);
  useEffect(() => {
    const fn = (v) => setValue(v);
    _devEngineListeners.add(fn);
    return () => _devEngineListeners.delete(fn);
  }, []);
  return [isDevBuild() ? value : null, setDevEngineOverride];
}
