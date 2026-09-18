import React, { useEffect, useRef } from "react";
import { ExternalLink, Download } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { downloadText } from "@/lib/volumeAnalysis";

/**
 * ReportDialog — the uniform Open/Save surface for every MRLatte report
 * (item 103): a modal preview (iframe srcDoc) with "Open in new window" and
 * "Save HTML" actions. `html` is a complete, already-composed document (see
 * lib/report/index.js::buildReport) — this component only presents it.
 *
 * Props:
 *   open, onOpenChange — dialog visibility (controlled)
 *   title, subject      — shown in the dialog header
 *   html                 — the full report HTML string to preview/open/save
 *   filename             — default filename for Save (".html" appended if missing)
 */
export function ReportDialog({ open, onOpenChange, title = "Report", subject, html, filename = "report.html" }) {
  // Blob URL backing "Open in new window" — created lazily per-open, revoked
  // on close/unmount rather than immediately after window.open() so the new
  // tab has time to actually load it.
  const blobUrlRef = useRef(null);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const openInNewWindow = () => {
    if (!html) return;
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const blob = new Blob([html], { type: "text/html" });
    blobUrlRef.current = URL.createObjectURL(blob);
    window.open(blobUrlRef.current, "_blank", "noopener,noreferrer");
  };

  const save = () => {
    if (!html) return;
    const name = filename.endsWith(".html") ? filename : `${filename}.html`;
    downloadText(name, html, "text/html");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[92vw] h-[85vh] flex flex-col bg-panel border border-border text-foreground p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="text-sm font-medium tracking-wide">{title}</DialogTitle>
          {subject && <DialogDescription className="text-[11px] font-mono truncate">{subject}</DialogDescription>}
        </DialogHeader>
        <div className="flex-1 min-h-0 bg-white">
          {html ? (
            <iframe title={title} srcDoc={html} className="w-full h-full border-0" data-testid="report-dialog-iframe" />
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No report to display</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={openInNewWindow}
            disabled={!html}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground disabled:opacity-50"
            data-testid="report-dialog-open-window"
          >
            <ExternalLink size={12} />Open in New Window
          </button>
          <button
            onClick={save}
            disabled={!html}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50"
            data-testid="report-dialog-save"
          >
            <Download size={12} />Save HTML
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ReportDialog;
