import React, { useState, useRef, useEffect } from "react";
import { Crosshair, MapPin, ChevronDown, Plus, Trash2, LocateFixed } from "lucide-react";
import { activeToggleCls, panelSelectCls } from "@/lib/buttonVariants";

/**
 * Topbar "go to MNI coordinate" dropdown. A button that opens a panel with:
 *   • a freeform coordinate field that parses "12, 45, 64" / "45 43 75" /
 *     "-3.5 2 10" (any 3 signed decimals, comma- or space-separated),
 *   • a small saved-coordinate library (optionally labelled), persisted to
 *     localStorage so it survives reloads.
 * Every jump routes through onGo(x, y, z), which Dashboard sends to the
 * viewer's setCrosshairMM — the shared crosshair-navigation primitive used by
 * the atlas region buttons, the visfAtlas auto-jump and workspace restore.
 *
 * Owns all its own draft/open/library state so typing never re-renders the
 * (large) Dashboard.
 */
const LS_KEY = "mrlatte.mniLibrary";

// Pull the first three signed decimals out of freeform text; null if <3.
export function parseCoords(text) {
  const nums = (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  return nums.length >= 3 ? [nums[0], nums[1], nums[2]] : null;
}

export default function GotoMniInput({ onGo, current }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (_e) { return []; }
  });
  const rootRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(saved)); } catch (_e) {}
  }, [saved]);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const parsed = parseCoords(text);
  const go = (coord) => { if (coord) onGo?.(coord[0], coord[1], coord[2]); };
  const hasCurrent = Array.isArray(current) && current.length >= 3 && current.every(Number.isFinite);
  const fillCurrent = () => {
    if (hasCurrent) setText(current.slice(0, 3).map((v) => Number(v.toFixed(1))).join(", "));
  };
  const saveCurrent = () => {
    if (!parsed) return;
    const name = label.trim() || `${parsed[0]}, ${parsed[1]}, ${parsed[2]}`;
    setSaved((p) => [...p, { id: Date.now(), label: name, coord: parsed }]);
    setLabel("");
  };
  const remove = (id) => setSaved((p) => p.filter((s) => s.id !== id));

  return (
    <div className="relative" ref={rootRef} data-testid="goto-mni">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] border transition-colors ${activeToggleCls(open)}`}
        title="Go to / save an MNI coordinate"
        data-testid="goto-mni-toggle"
      >
        <MapPin size={12} /><span>MNI</span><ChevronDown size={11} />
      </button>

      {open && (
        <div
          className="absolute left-0 z-50 mt-1 w-64 border border-border bg-panel p-2 shadow-lg"
          data-testid="goto-mni-panel"
        >
          {/* Coordinate entry */}
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") go(parsed); }}
              placeholder="x, y, z   e.g. 12, 45, 64"
              aria-label="MNI coordinate"
              data-testid="goto-mni-input"
              className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              onClick={() => go(parsed)}
              disabled={!parsed}
              title={parsed ? "Go to coordinate" : "Enter three numbers"}
              data-testid="goto-mni-go"
              className="flex items-center border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <Crosshair size={12} />
            </button>
            <button
              onClick={fillCurrent}
              disabled={!hasCurrent}
              title={hasCurrent ? "Fill with current crosshair position" : "No crosshair position yet"}
              data-testid="goto-mni-current"
              className="flex items-center border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <LocateFixed size={12} />
            </button>
          </div>

          {/* Save to library */}
          <div className="mt-1 flex items-center gap-1">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCurrent(); }}
              placeholder="label (optional)"
              aria-label="Coordinate label"
              data-testid="goto-mni-label"
              className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              onClick={saveCurrent}
              disabled={!parsed}
              title={parsed ? "Save this coordinate" : "Enter a coordinate above first"}
              data-testid="goto-mni-save"
              className="flex items-center gap-1 border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              <Plus size={12} />Save
            </button>
          </div>

          {/* Saved library */}
          {saved.length > 0 && (
            <div className="mt-2 max-h-48 overflow-y-auto border-t border-border pt-1" data-testid="goto-mni-library">
              {saved.map((s) => (
                <div key={s.id} className="flex items-center gap-1">
                  <button
                    onClick={() => go(s.coord)}
                    title={`Go to ${s.coord.join(", ")}`}
                    data-testid={`goto-mni-saved-${s.id}`}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 px-1 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-panel-hover hover:text-foreground"
                  >
                    <span className="truncate">{s.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{s.coord.join(", ")}</span>
                  </button>
                  <button
                    onClick={() => remove(s.id)}
                    title="Delete"
                    data-testid={`goto-mni-del-${s.id}`}
                    className="flex items-center px-1 py-1 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
