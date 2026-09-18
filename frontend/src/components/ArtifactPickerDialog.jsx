import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { summaryArtifacts, summaryDownloadUrl } from "@/lib/summary";

// Fixed display order for the four groups the backend contract defines;
// anything else it ever sends is appended after, rather than dropped.
const GROUP_ORDER = ["Viewers", "Images", "Maps", "Data"];

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "unknown size";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  for (let i = 0; i < units.length; i += 1) {
    v /= 1024;
    if (v < 1024 || i === units.length - 1) return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }
  return `${Math.round(v)} TB`;
}

// Plain <a> click, no fetch/blob — the response streams straight from the
// network to disk. Filename is left to the server's Content-Disposition
// (a single file vs. a zip of several need different names/extensions).
function openDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * ArtifactPickerDialog (task 0b) — replaces One-Click Summary's old
 * download-everything ZIP with a selective picker.
 *
 * Backend contract:
 *   GET /api/summary/artifacts/{job_id} -> { job_id, artifacts: [
 *     { rel, label, kind: "html"|"image"|"map"|"data",
 *       bytes, group: "Viewers"|"Images"|"Maps"|"Data", default } ] }
 *   GET /api/summary/download/{job_id}?p=<rel>&p=<rel>... -> one `p` is that
 *     file directly, two-or-more come back as a zip.
 *
 * Props:
 *   open, onOpenChange — dialog visibility (controlled)
 *   jobId              — the completed summary job's id (artifacts are fetched
 *                         fresh whenever the dialog opens for a given jobId)
 */
export function ArtifactPickerDialog({ open, onOpenChange, jobId }) {
  const [state, setState] = useState({ loading: false, error: null, artifacts: null });
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    if (!open || !jobId) return undefined;
    let cancelled = false;
    setState({ loading: true, error: null, artifacts: null });
    summaryArtifacts(jobId)
      .then((data) => {
        if (cancelled) return;
        const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
        setState({ loading: false, error: null, artifacts });
        setSelected(new Set(artifacts.filter((a) => a.default).map((a) => a.rel)));
      })
      .catch((e) => {
        if (cancelled) return;
        // Degrade honestly (CLAUDE.md / task 0b): a 404 here is expected while
        // the backend half of this feature isn't merged yet — say so instead
        // of silently showing an empty list.
        setState({ loading: false, error: e?.message || "request failed", artifacts: null });
      });
    return () => { cancelled = true; };
  }, [open, jobId]);

  const groups = useMemo(() => {
    const artifacts = state.artifacts || [];
    const byGroup = new Map();
    for (const a of artifacts) {
      const g = a.group || "Data";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(a);
    }
    const order = [...GROUP_ORDER, ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g))];
    return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g) }));
  }, [state.artifacts]);

  const toggle = (rel) => setSelected((prev) => {
    const n = new Set(prev);
    n.has(rel) ? n.delete(rel) : n.add(rel);
    return n;
  });

  const toggleGroup = (items, allSelected) => setSelected((prev) => {
    const n = new Set(prev);
    items.forEach((it) => (allSelected ? n.delete(it.rel) : n.add(it.rel)));
    return n;
  });

  const { count, totalBytes } = useMemo(() => {
    const artifacts = state.artifacts || [];
    let c = 0;
    let b = 0;
    for (const a of artifacts) {
      if (selected.has(a.rel)) { c += 1; b += Number(a.bytes) || 0; }
    }
    return { count: c, totalBytes: b };
  }, [state.artifacts, selected]);

  const handleDownload = () => {
    if (!jobId || selected.size === 0) return;
    openDownload(summaryDownloadUrl(jobId, [...selected]));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-[92vw] max-h-[85vh] flex flex-col bg-panel border border-border text-foreground p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="text-sm font-medium tracking-wide">Download artifacts</DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            Choose which files to download — one downloads directly, more than one as a zip.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto thin-scroll px-5 py-3 space-y-4" data-testid="artifact-picker-body">
          {state.loading && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="artifact-picker-loading">
              <Loader2 size={12} className="animate-spin" /> Loading artifacts…
            </div>
          )}
          {state.error && (
            <div className="flex items-start gap-2 border border-amber-500/50 px-3 py-2 text-[11px] text-amber-500" data-testid="artifact-picker-error">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>Could not load the artifact list ({state.error}). The backend may not have this endpoint deployed yet.</span>
            </div>
          )}
          {!state.loading && !state.error && groups.length === 0 && (
            <div className="text-[11px] text-muted-foreground" data-testid="artifact-picker-empty">No artifacts available for this job.</div>
          )}
          {groups.map(({ group, items }) => {
            const allSelected = items.every((it) => selected.has(it.rel));
            const someSelected = items.some((it) => selected.has(it.rel));
            return (
              <div key={group} className="space-y-1.5" data-testid={`artifact-group-${group}`}>
                <label className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-subtle cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                    onChange={() => toggleGroup(items, allSelected)}
                    className="accent-fuchsia-500"
                    data-testid={`artifact-group-toggle-${group}`}
                  />
                  {group}
                </label>
                <div className="border border-border divide-y divide-border">
                  {items.map((it) => (
                    <label key={it.rel} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.has(it.rel)}
                        onChange={() => toggle(it.rel)}
                        className="accent-fuchsia-500"
                        data-testid={`artifact-item-${it.rel}`}
                      />
                      <span className="flex-1 min-w-0 truncate">{it.label}</span>
                      <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{formatSize(it.bytes)}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border sm:justify-between items-center">
          <div className="font-mono text-[10px] text-muted-foreground" data-testid="artifact-picker-summary">
            {count} selected · {formatSize(totalBytes)}
          </div>
          <button
            onClick={handleDownload}
            disabled={count === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50"
            data-testid="artifact-picker-download"
          >
            <Download size={12} />Download
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ArtifactPickerDialog;
