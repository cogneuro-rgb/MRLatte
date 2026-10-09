import React, { useRef } from "react";
import { AlertTriangle, Info, LocateFixed } from "lucide-react";
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
// Where a finding is, if lqtpy said (0.6.0+): the first location's world
// position, or null. See lqtpy docs/QC.md, "Locations".
const findingMM = (f) => {
  const mm = f?.locations?.[0]?.mm;
  return Array.isArray(mm) && mm.length >= 3 && mm.every((v) => Number.isFinite(v)) ? mm : null;
};
const describeLocation = (f) => {
  const loc = f?.locations?.[0];
  if (!loc) return "";
  return loc.kind === "slice" && loc.plane ? `${loc.plane} slice ${loc.index}` : "";
};

export function LesionQcDialog({
  open, flags = [], actionLabel, onConfirm, onCancel, readOnly = false,
  // lqtpy 0.6.0+ extras, all optional:
  verdict,          // the mask as a whole: "usable" / "usable with caution" / "fix before use" / "unusable"
  onGoTo,           // (mm) => void — jump the viewer to a finding; the dialog closes
  onInterpolate,    // () => void — offered when slices were skipped; the dialog closes
}) {
  const hasGaps = flags.some((f) => f.id === "sparse_slices" && f.severity !== "info");
  const findings = flags.filter((f) => f.severity !== "info");
  const notes = flags.filter((f) => f.severity === "info");

  const renderFinding = (f, i) => {
    const isNote = f.severity === "info";
    // lqtpy's own words: info = Note, warn = Check, error = Problem, plus the
    // grade (minor / moderate / major). lqtpy 0.6.0 sends the finished text as
    // `label`; for an older one it is assembled here.
    const word = isNote ? "Note" : f.severity === "error" ? "Problem" : "Check";
    const label = f.label || (f.grade && !isNote ? `${word}, ${f.grade}` : word);
    const where = f.where || describeLocation(f);
    return (
      <div key={`${f.id}-${i}`} className="border border-border px-3 py-2 space-y-1" data-testid={`lesion-qc-flag-${f.id}`}>
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
          {isNote ? <Info size={11} /> : <AlertTriangle size={11} className="text-amber-500" />}
          {label}
        </div>
        <div className="text-[12px] text-foreground">{f.message}</div>
        {f.suggestion && (
          <div className="text-[11px] text-muted-foreground">{f.suggestion}</div>
        )}
        {onGoTo && findingMM(f) && (
          <button
            onClick={() => onGoTo(findingMM(f))}
            className="mt-1 inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1.5 py-0.5 transition-colors"
            title="Close this and move the viewer to where the problem is"
            data-testid={`lesion-qc-goto-${f.id}`}
          >
            <LocateFixed size={10} />
            Go to{where ? ` ${where}` : ""}
          </button>
        )}
      </div>
    );
  };
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
          {verdict && (
            <div className="text-[11px] text-foreground" data-testid="lesion-qc-verdict">
              Overall: <span className="font-medium">{verdict}</span>
            </div>
          )}
        </DialogHeader>

        <div className="space-y-3 max-h-[50vh] overflow-y-auto thin-scroll" data-testid="lesion-qc-flag-list">
          {findings.map(renderFinding)}
          {/* Notes never stop a save on their own, so when something real is
              listed they fold away under it instead of competing with it. */}
          {notes.length > 0 && (findings.length === 0 ? notes.map(renderFinding) : (
            <details className="text-[11px] text-muted-foreground" data-testid="lesion-qc-notes">
              <summary className="cursor-pointer select-none hover:text-foreground">
                {notes.length === 1 ? "1 note" : `${notes.length} notes`}
              </summary>
              <div className="space-y-3 mt-2">{notes.map(renderFinding)}</div>
            </details>
          ))}
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
              {hasGaps && onInterpolate && (
                <button
                  onClick={onInterpolate}
                  className="px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground"
                  title="Fill the slices between the ones you drew, then check the result before saving"
                  data-testid="lesion-qc-interpolate"
                >
                  Interpolate all
                </button>
              )}
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
