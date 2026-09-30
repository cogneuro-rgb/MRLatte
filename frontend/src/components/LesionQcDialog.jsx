import React, { useRef } from "react";
import { AlertTriangle, Info } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

/**
 * Confirmation dialog shown before Save/Download when lqtpy.qc.check() finds
 * issues with the current drawing (frontend/src/lib/lesionQc.js). Modelled
 * on the wording of lqtpy's own report ("## Quality — Check ... / Note
 * ..."): error/warn flags are labelled "Check", info flags "Note" — the
 * backend already sorts errors first (lqtpy.qc.check's own ordering).
 *
 * Two modes:
 *  - Confirmation (default): "Keep editing" / "<actionLabel>" (e.g. "Save
 *    anyway"). "Keep editing" is the default focus — the safer choice is to
 *    go back and look, not to save/download past a flagged issue.
 *  - `readOnly`: a single "Close" button — used by the idle-drawing toast's
 *    "Details" action, which only ever shows what QC found, never gates an
 *    action.
 */
export function LesionQcDialog({
  open, flags = [], actionLabel, onConfirm, onCancel, readOnly = false,
}) {
  const defaultFocusRef = useRef(null);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel?.(); }}>
      <DialogContent
        className="max-w-md w-[92vw] bg-panel border border-border text-foreground"
        onOpenAutoFocus={(e) => { e.preventDefault(); defaultFocusRef.current?.focus(); }}
        data-testid="lesion-qc-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-500" />
            {readOnly ? "Possible issues with this drawing" : "Quality check found possible issues"}
          </DialogTitle>
          {!readOnly && (
            <DialogDescription className="text-[11px] text-muted-foreground">
              lqtpy checked the current drawing. Review below, or continue anyway.
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3 max-h-[50vh] overflow-y-auto thin-scroll" data-testid="lesion-qc-flag-list">
          {flags.map((f, i) => {
            const isNote = f.severity === "info";
            return (
              <div key={`${f.id}-${i}`} className="border border-border px-3 py-2 space-y-1" data-testid={`lesion-qc-flag-${f.id}`}>
                <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                  {isNote ? <Info size={11} /> : <AlertTriangle size={11} className="text-amber-500" />}
                  {isNote ? "Note" : "Check"}
                </div>
                <div className="text-[12px] text-foreground">{f.message}</div>
                {f.suggestion && (
                  <div className="text-[11px] text-muted-foreground">{f.suggestion}</div>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2">
          {readOnly ? (
            <button
              ref={defaultFocusRef}
              onClick={onCancel}
              className="px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground"
              data-testid="lesion-qc-close"
            >
              Close
            </button>
          ) : (
            <>
              <button
                ref={defaultFocusRef}
                onClick={onCancel}
                className="px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground"
                data-testid="lesion-qc-keep-editing"
              >
                Keep editing
              </button>
              <button
                onClick={onConfirm}
                className="px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                data-testid="lesion-qc-confirm"
              >
                {actionLabel}
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LesionQcDialog;
