import React, { useEffect, useState } from "react";
import { FileText, AlertTriangle } from "lucide-react";
import * as nifti from "nifti-reader-js";
import { NiftiHeaderView } from "@/components/NiftiHeaderDialog";

/**
 * Standalone NIfTI header viewer — the Explorer right-click "MRLatte ›
 * View NIfTI header" window (electron.js `--header <file>` mode). No viewer,
 * no backend, no /api calls: index.js mounts this instead of <App/> for
 * #/header. The main process reads only the file's first bytes (decompressing
 * .nii.gz on the fly) and hands them over here; they're parsed with
 * nifti-reader-js, the same parser niivue uses, and shown with the same view
 * as the in-app header dialog.
 */
export default function HeaderViewerPage() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    (async () => {
      try {
        const r = await window.mrlatte?.readHeaderFile?.();
        if (!r?.ok) throw new Error(r?.error || "Couldn't read the file.");
        document.title = `NIfTI header — ${r.name}`;
        const bytes = r.bytes;
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (!nifti.isNIFTI(buf)) throw new Error("This file doesn't have a NIfTI header.");
        setState({ name: r.name, path: r.path, hdr: nifti.readHeader(buf) });
      } catch (e) {
        setState({ error: e?.message || String(e) });
      }
    })();
  }, []);

  return (
    <div className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground" data-testid="header-viewer-page">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium tracking-wide">
          <FileText size={14} className="text-muted-foreground" /> NIfTI header
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={state.path}>
          {state.path || state.name || ""}
        </div>
      </div>
      {state.loading && <div className="text-[12px] text-muted-foreground">Reading…</div>}
      {state.error && (
        <div className="flex items-start gap-2 border border-orange-500/60 px-3 py-2 text-[12px] text-orange-200" data-testid="header-viewer-error">
          <AlertTriangle size={14} className="mt-px shrink-0 text-orange-400" />
          {state.error}
        </div>
      )}
      {state.hdr && <NiftiHeaderView hdr={state.hdr} scrollClassName="flex-1 min-h-0" />}
    </div>
  );
}
