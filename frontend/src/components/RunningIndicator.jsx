import React from "react";
import { Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";

/**
 * RunningIndicator — shared bottom-left "this is running in the background"
 * box (SMALL-FIXES item 57). Originally One-Click Summary's own bespoke UI;
 * extracted so Tract Dissection and Lesion Network Mapping can show the same
 * affordance during their (single-await, no polling) background computes.
 *
 * - `steps` (optional): an ordered list of { key, label, state } where state
 *   is "pending" | "active" | "done" | "error". Multi-stage jobs (One-Click
 *   Summary) pass this; single-await jobs (Tract Dissection, LNM) omit it and
 *   are driven purely by `active`/`done`.
 * - `onCancel` (optional): shown while running (!done). Only One-Click
 *   Summary's backend job supports cancellation today.
 * - `onDismiss` (optional): shown once done or errored, to close the box.
 * - `progress` (optional, 0..1): when a finite number is passed, a thin
 *   horizontal filled bar is rendered under the header — the additive
 *   progress-bar affordance for the pollable Tract Dissection / LNM jobs. Omit
 *   it (single-await callers) and nothing extra renders.
 */
export const RunningIndicator = ({
  title,
  active,
  done = false,
  error = null,
  message,
  onCancel,
  cancelling = false,
  onDismiss,
  steps,
  progress,
}) => {
  if (!active) return null;
  const hasBar = typeof progress === "number" && Number.isFinite(progress) && !done && !error;
  const pct = hasBar ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : 0;
  return (
    <div
      // bottom-24 (not bottom-4): the app's toast stack (sonner) also lives
      // bottom-left (item 94) and grows upward from the bottom edge — this
      // box sits above it so they never overlap.
      className="fixed bottom-24 left-4 z-50 w-72 rounded-[10px] border border-edge bg-popover px-4 py-3 shadow-elev-2"
      data-testid="running-indicator"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
          {error ? <XCircle size={13} className="text-destructive" />
            : done ? <CheckCircle2 size={13} className="text-ok" />
            : <Loader2 size={13} className="animate-spin text-muted-foreground" />}
          {title}
        </div>
        {(done || error) && onDismiss && (
          <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground text-[12px]" data-testid="running-indicator-dismiss">✕</button>
        )}
        {!done && onCancel && (
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="text-[12px] font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
            data-testid="running-indicator-cancel"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      {hasBar && (
        <div className="mb-2" data-testid="running-indicator-progress">
          <div className="h-1.5 w-full bg-panel-hover border border-border rounded-sm overflow-hidden">
            <div
              className="h-full bg-foreground transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {steps && steps.length > 0 && (
        <div className="space-y-1">
          {steps.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[12px]">
              {s.state === "done" ? <CheckCircle2 size={11} className="text-ok" />
                : s.state === "active" ? <Loader2 size={11} className="animate-spin text-muted-foreground" />
                : s.state === "error" ? <XCircle size={11} className="text-destructive" />
                : <Circle size={11} className="text-subtle" />}
              <span className={s.state === "pending" ? "text-subtle" : "text-foreground"}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {message && !done && (
        <div className="mt-2 text-[11.5px] text-muted-foreground truncate">{message}</div>
      )}
    </div>
  );
};

export default RunningIndicator;
