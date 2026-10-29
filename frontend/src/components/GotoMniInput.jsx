import React, { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { Crosshair, MapPin, ChevronDown, Plus, Trash2, LocateFixed } from "lucide-react";
import { panelSelectCls } from "@/lib/buttonVariants";
import { getMniLibrary, setMniLibrary, subscribeMniLibrary } from "@/lib/mniLibrary";

/**
 * Topbar "go to MNI coordinate" dropdown. A button that opens a panel with:
 *   • a freeform coordinate field that parses "12, 45, 64" / "45 43 75" /
 *     "-3.5 2 10" (any 3 signed decimals, comma- or space-separated),
 *   • a small saved-coordinate library (optionally labelled) for this session,
 *     saved with workspaces (lib/mniLibrary.js).
 * Every jump routes through onGo(x, y, z), which Dashboard sends to the
 * viewer's setCrosshairMM — the shared crosshair-navigation primitive used by
 * the atlas region buttons, the visfAtlas auto-jump and workspace restore.
 *
 * Owns all its own draft/open/library state so typing never re-renders the
 * (large) Dashboard.
 */

// Within this distance (mm, per axis) a coordinate counts as "where the
// crosshair is": a typed coordinate snaps to the nearest voxel centre, and the
// default template's voxels are 0.74 mm apart.
const AT_CROSSHAIR_MM = 0.6;
export function atCrosshair(coord, current) {
  return !!coord && Array.isArray(current) && current.length >= 3
    && [0, 1, 2].every((i) => Number.isFinite(current[i]) && Math.abs(coord[i] - current[i]) <= AT_CROSSHAIR_MM);
}

// Pull the first three signed decimals out of freeform text; null if <3.
export function parseCoords(text) {
  const nums = (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  return nums.length >= 3 ? [nums[0], nums[1], nums[2]] : null;
}

export default function GotoMniInput({ onGo, current }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const saved = useSyncExternalStore(subscribeMniLibrary, getMniLibrary);
  const setSaved = (fn) => setMniLibrary(fn(getMniLibrary()));
  const rootRef = useRef(null);

  // Close on outside click / Escape while open — but not on a click in the
  // viewer, so the crosshair can be moved with the menu open (and the box
  // turns green when it lands on the typed coordinate).
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (e.target?.closest?.('[data-testid="niivue-viewer"]')) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const parsed = parseCoords(text);
  const parsedHere = atCrosshair(parsed, current);
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
        className="tb-b"
        aria-expanded={open}
        aria-pressed={open}
        title="Go to / save an MNI coordinate"
        data-testid="goto-mni-toggle"
      >
        <MapPin size={14} /><span>MNI</span><ChevronDown size={12} />
      </button>

      {open && (
        <div
          className="popover absolute right-0 z-50 mt-1.5 w-72 p-2.5"
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
              data-at-crosshair={parsedHere || undefined}
              title={parsedHere ? "The crosshair is at this coordinate" : undefined}
              className={`field min-w-0 flex-1 ${
                parsedHere ? "!border-ok text-ok" : ""
              }`}
            />
            <button
              onClick={() => go(parsed)}
              disabled={!parsed}
              title={parsed ? "Go to coordinate" : "Enter three numbers"}
              data-testid="goto-mni-go"
              className="btn-mini h-7 px-2"
            >
              <Crosshair size={12} />
            </button>
            <button
              onClick={fillCurrent}
              disabled={!hasCurrent}
              title={hasCurrent ? "Fill with current crosshair position" : "No crosshair position yet"}
              data-testid="goto-mni-current"
              className="btn-mini h-7 px-2"
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
              className="field min-w-0 flex-1"
            />
            <button
              onClick={saveCurrent}
              disabled={!parsed}
              title={parsed ? "Save this coordinate" : "Enter a coordinate above first"}
              data-testid="goto-mni-save"
              className="btn-mini h-7 px-2"
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
                    data-at-crosshair={atCrosshair(s.coord, current) || undefined}
                    className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-[5px] px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-panel-hover ${
                      atCrosshair(s.coord, current) ? "text-ok" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{s.label}</span>
                    <span className="shrink-0 text-[11.5px]">{s.coord.join(", ")}</span>
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
