import React, { createContext, useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { summarizeNiftiHeader, allNiftiHeaderFields } from "@/lib/niftiHeaderSummary";

// (layer) => void, provided by Dashboard. LayerControlAdvanced reads it to
// show a "Header" button on every layer card (base, overlays, atlases)
// without threading a prop through each sidebar section. null = no button.
export const NiftiHeaderContext = createContext(null);

/**
 * The header tables themselves: curated summary by default, "Show all
 * fields" swaps in every raw header field. Shared by the in-app dialog below
 * and the standalone right-click viewer (pages/HeaderViewerPage.jsx).
 * `scrollClassName` sizes the scroll area for its container.
 */
export function NiftiHeaderView({ hdr, scrollClassName = "max-h-[60vh]" }) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [hdr]); // a different file starts on the summary
  const sections = useMemo(() => {
    if (!hdr) return [];
    return showAll
      ? [{ title: "All header fields", rows: allNiftiHeaderFields(hdr) }]
      : summarizeNiftiHeader(hdr);
  }, [hdr, showAll]);
  if (sections.length === 0) {
    return <div className="text-[12px] text-muted-foreground">No header available for this layer.</div>;
  }
  return (
    <>
      <div className={`space-y-3 overflow-y-auto thin-scroll pr-1 ${scrollClassName}`}>
        {sections.map((s) => (
          <div key={s.title}>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle mb-1">{s.title}</div>
            <table className="w-full text-[11px]">
              <tbody>
                {s.rows.map(([label, value], i) => (
                  <tr key={i} className="align-top">
                    <td className="w-[42%] pr-3 py-0.5 text-muted-foreground">{label}</td>
                    <td className="py-0.5 font-mono text-foreground break-words select-text">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <button
        onClick={() => setShowAll((v) => !v)}
        className="w-full border border-border py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
        data-testid="nifti-header-toggle-all"
      >
        {showAll ? "Show summary" : "Show all fields"}
      </button>
    </>
  );
}

/**
 * Read-only view of a loaded volume's NIfTI header (base scan or any
 * overlay). `target` = { name, hdr } or null (closed). The header is the one
 * niivue parsed on load — see lib/niftiHeaderSummary.js for what's shown.
 */
export function NiftiHeaderDialog({ target, onClose }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg w-[92vw] bg-panel border border-border text-foreground" data-testid="nifti-header-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
            <FileText size={14} className="text-muted-foreground" /> NIfTI header
          </DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground font-mono truncate">
            {target?.name}
          </DialogDescription>
        </DialogHeader>
        <NiftiHeaderView hdr={target?.hdr} />
      </DialogContent>
    </Dialog>
  );
}
