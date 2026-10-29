import React, { useRef } from "react";
import { Link2, Package } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

const mb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Save Workspace: links (default) or everything embedded.
 *
 *  links    — where each scan is on disk plus all settings and adjustments: a
 *             small file that opens where those paths exist (this computer, or
 *             a shared drive). The unsaved drawing, and anything with no file
 *             on disk, is still included.
 *  embedded — a copy of every scan inside the file: opens anywhere, larger.
 *
 * `canLink` is false in the browser build (no file paths there).
 * `alwaysEmbedded`: names of what goes in either way; `embedBytes`: rough size
 * of the self-contained file.
 */
export function SaveWorkspaceDialog({ open, onClose, onChoose, canLink, alwaysEmbedded = [], embedBytes = 0 }) {
  const defaultRef = useRef(null);
  const option = "w-full text-left border px-3 py-2.5 transition-colors flex gap-3 items-start";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-md w-[92vw] bg-panel border border-edge text-foreground"
        onOpenAutoFocus={(e) => { e.preventDefault(); defaultRef.current?.focus(); }}
        data-testid="save-workspace-dialog"
      >
        <DialogHeader>
          <DialogTitle>Save workspace</DialogTitle>
          <DialogDescription className="text-[12px] text-muted-foreground">
            Everything you see is saved either way: layers, settings, adjustments, notes, the crosshair.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <button
            ref={canLink ? defaultRef : undefined}
            disabled={!canLink}
            onClick={() => onChoose("link")}
            className={`${option} border-foreground bg-panel-hover hover:bg-panel-active disabled:opacity-40 disabled:border-border disabled:bg-transparent`}
            data-testid="save-workspace-link"
          >
            <Link2 size={15} className="mt-0.5 shrink-0" />
            <span className="space-y-0.5">
              <span className="block text-[13px] font-medium">Small — link to the files <span className="font-normal text-muted-foreground">(recommended)</span></span>
              <span className="block text-[11.5px] text-muted-foreground leading-snug">
                {canLink
                  ? "Saves where each scan is, not a copy. Opens wherever those files are at the same place (this computer, a shared drive). If a file has moved, MRLatte says which."
                  : "Needs the MRLatte desktop app (the browser can't see where files are)."}
              </span>
            </span>
          </button>
          <button
            ref={canLink ? undefined : defaultRef}
            onClick={() => onChoose("embed")}
            className={`${option} border-border hover:bg-panel-hover`}
            data-testid="save-workspace-embed"
          >
            <Package size={15} className="mt-0.5 shrink-0" />
            <span className="space-y-0.5">
              <span className="block text-[13px] font-medium">Self-contained — embed everything{embedBytes > 0 && <span className="font-normal text-muted-foreground"> (about {mb(embedBytes)})</span>}</span>
              <span className="block text-[11.5px] text-muted-foreground leading-snug">
                A copy of every scan inside the file. Opens on any computer; larger.
              </span>
            </span>
          </button>
        </div>

        {canLink && alwaysEmbedded.length > 0 && (
          <div className="text-[11.5px] text-muted-foreground leading-snug" data-testid="save-workspace-embedded-anyway">
            Included in either case (no file to link to): {alwaysEmbedded.join(", ")}.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default SaveWorkspaceDialog;
