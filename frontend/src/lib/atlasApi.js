// Atlas registry client.
//
// The atlas list used to be a hardcoded array (atlasConfig.STANDARD_ATLASES)
// that had drifted from what was actually installed. `/api/atlases` is now the
// only source of truth, and it returns the SAME per-layer fields the viewer
// already consumes (`id`, `url`, `labelsUrl`, `colormap`, `opacity`,
// `ignoreZeroVoxels`), so volumeApi.addOverlayFromUrl takes a descriptor
// unchanged.
//
// Same rule as lib/modules.js: never probe an asset URL to decide whether an
// atlas exists. backend/server.py falls any non-/api 404 back to index.html
// with status 200, so a missing atlas "succeeds" and NiiVue then chokes parsing
// the app shell as a NIfTI. /api/* returns real JSON 404s.

const apiBase = process.env.REACT_APP_BACKEND_URL || "";

async function call(path, options) {
  const r = await fetch(`${apiBase}/api/atlases${path}`, options);
  let body = null;
  try {
    body = await r.json();
  } catch (_e) {
    body = null;
  }
  if (!r.ok) {
    const detail = body?.detail || body?.error || `HTTP ${r.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

/** Installed atlases (in the user's order) plus the 1-click catalog. */
export async function fetchAtlases() {
  try {
    const data = await call("");
    return {
      ok: true,
      atlases: data?.atlases || [],
      catalog: data?.catalog || [],
      atlasDir: data?.atlasDir || null,
    };
  } catch (e) {
    // Backend not running (web dev without uvicorn, or Electron before the
    // sidecar is up). Callers must treat this as "unknown", not "empty".
    return { ok: false, reason: e.message, atlases: [], catalog: [] };
  }
}

export const fetchAtlasLabels = (id) => call(`/${encodeURIComponent(id)}/labels`);

export const patchAtlas = (id, fields) =>
  call(`/${encodeURIComponent(id)}`, json("PATCH", fields));

export const removeAtlas = (id) =>
  call(`/${encodeURIComponent(id)}`, { method: "DELETE" });

export const setAtlasOrder = (order) => call("/order", json("POST", { order }));

export const deriveLeftRight = (id, body) =>
  call(`/${encodeURIComponent(id)}/derive-lr`, json("POST", body));

export const regionMask = (id, values, label) =>
  call(`/${encodeURIComponent(id)}/region-mask`, json("POST", { values, label }));

export const installFromCatalog = (catalogId) =>
  call(`/catalog/${encodeURIComponent(catalogId)}/install`, json("POST"));

export const atlasJobStatus = (jobId) => call(`/jobs/${encodeURIComponent(jobId)}`);

/** Upload an atlas for inspection. Nothing is installed until commitImport. */
export async function stageImport({ volume, labels, name }) {
  const form = new FormData();
  form.append("volume", volume);
  if (labels) form.append("labels", labels);
  form.append("name", name || "");
  return call("/import/stage", { method: "POST", body: form });
}

export const commitImport = (stageId, body) =>
  call(`/import/${encodeURIComponent(stageId)}/commit`, json("POST", body));

export const discardImport = (stageId) =>
  call(`/import/${encodeURIComponent(stageId)}`, { method: "DELETE" });

/**
 * Poll a catalog-install job to completion.
 * `onProgress(job)` fires on every tick; resolves with the final job.
 */
export async function pollAtlasJob(jobId, onProgress, { intervalMs = 700, timeoutMs = 300000 } = {}) {
  const started = Date.now();
  for (;;) {
    const job = await atlasJobStatus(jobId);
    onProgress?.(job);
    if (job?.done) return job;
    if (Date.now() - started > timeoutMs) {
      throw new Error("install timed out");
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/** Human-readable byte size. Mirrors lib/modules.formatBytes. */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "unknown size";
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let out = v;
  for (let i = 0; i < units.length; i += 1) {
    out /= 1024;
    if (out < 1024 || i === units.length - 1) return `${out.toFixed(out < 10 ? 1 : 0)} ${units[i]}`;
  }
  return `${v} B`;
}
