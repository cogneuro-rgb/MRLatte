import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { colormapGradient } from "@/lib/colormaps";

/**
 * Colour-map chooser: a field showing the current map, opening a grid of
 * tiles, one per map, each painted with the map itself. `invert` flips every
 * tile the way "Invert colour map" flips the rendered volume.
 *
 * The grid opens under the field as a popover spanning the nearest
 * positioned ancestor (the layer card), so it has the card's full width,
 * scrolls with the sidebar and never needs a portal. Esc or a click outside
 * closes it; picking a tile closes it and hands the name to `onChange`.
 */
export function ColormapPicker({ value, options, onChange, invert = false, testId }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const gridRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Land on the current tile, so arrow keys and Enter work straight away.
    gridRef.current?.querySelector('[aria-pressed="true"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Arrow keys move between tiles, six to a row.
  const onGridKey = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
    if (!step) return;
    e.preventDefault();
    const tiles = [...gridRef.current.querySelectorAll("button")];
    const i = tiles.indexOf(document.activeElement);
    tiles[Math.max(0, Math.min(tiles.length - 1, i + step))]?.focus();
  };

  return (
    <div ref={rootRef} className="min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="field flex w-full items-center gap-2 text-left"
        data-testid={testId}
      >
        <span
          className="keep-colours h-3 w-[22px] flex-none rounded-[3px]"
          style={{ background: colormapGradient(value, { direction: "to right", invert }) }}
        />
        <span className="flex-1 truncate font-mono text-[12px]">{value}</span>
        <ChevronDown size={13} className={`flex-none text-subtle transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={gridRef}
          role="group"
          aria-label="Colour maps"
          onKeyDown={onGridKey}
          className="absolute inset-x-1.5 z-30 mt-1.5 grid grid-cols-6 gap-0.5 rounded-[10px] border border-edge bg-popover p-1.5 shadow-elev-2"
        >
          {options.map((name) => {
            const on = name === value;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                title={name}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={`flex min-w-0 flex-col items-center gap-1.5 rounded-[10px] px-0.5 pb-1.5 pt-2 transition-colors ${
                  on ? "bg-panel-active shadow-[inset_0_0_0_1px_hsl(var(--edge))]" : "hover:bg-panel-hover"
                }`}
                data-testid={testId ? `${testId}-${name}` : undefined}
              >
                <span
                  className="keep-colours aspect-square w-full max-w-[44px] rounded-[11px] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_2px_6px_rgb(0_0_0/0.35)]"
                  style={{ background: colormapGradient(name, { direction: "135deg", invert }) }}
                />
                <span className={`max-w-full truncate text-[11px] ${on ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ColormapPicker;
