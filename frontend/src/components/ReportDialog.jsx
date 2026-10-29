import React, { useEffect, useRef } from "react";
import { ExternalLink, Download, FileText } from "lucide-react";
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
      <DialogContent className="max-w-5xl w-[92vw] h-[88vh] flex flex-col overflow-hidden bg-panel border border-edge text-foreground p-0 gap-0">
        {/* One header row: what it is, then its actions (the dialog's own
            close button sits at the right end, hence the padding). */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border py-2.5 pl-4 pr-14">
          <FileText size={16} className="flex-shrink-0 text-muted-foreground" />
          <DialogHeader className="min-w-0 flex-1 space-y-0 text-left">
            <DialogTitle className="text-[13.5px] leading-[18px]">{title}</DialogTitle>
            {subject && <DialogDescription className="truncate text-[12px] text-subtle">{subject}</DialogDescription>}
          </DialogHeader>
          <button
            onClick={openInNewWindow}
            disabled={!html}
            className="btn gap-1.5"
            data-testid="report-dialog-open-window"
          >
            <ExternalLink size={13} />Open in new window
          </button>
          <button
            onClick={save}
            disabled={!html}
            className="btn-primary gap-1.5"
            data-testid="report-dialog-save"
          >
            <Download size={13} />Save HTML
          </button>
        </div>
        <div className="flex-1 min-h-0 bg-[#F2EFE9]">
          {html ? (
            <iframe title={title} srcDoc={html} className="w-full h-full border-0" data-testid="report-dialog-iframe" />
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No report to display</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ReportDialog;
