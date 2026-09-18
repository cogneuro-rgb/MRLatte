import React, { useMemo, useState } from "react";
import { Crosshair, Eye, EyeOff, Palette, Download, RotateCcw } from "lucide-react";
import { matchRegions } from "@/lib/atlasLabels";

/**
 * Region list for one atlas: filter, navigate, isolate, recolour, export.
 *
 * Rows come from the registry's canonical regions ([{value, name, color,
 * centroidMM}]), so a region carries its own colour and — for a catalog or
 * migrated atlas — a precomputed centroid, letting navigation skip the
 * client-side volume scan entirely.
 *
 * Four actions per row:
 *   navigate  jump the crosshair to the region (onNavigate)
 *   isolate   show only the checked regions (onIsolate)
 *   colour    override the region's colour (onColors)
 *   export    turn the selection into an ROI mask layer (onRegionMask)
 */
export default function AtlasLabelList({
  atlasId,
  regions,
  isolated,
  onNavigate,
  onIsolate,
  onColors,
  onRegionMask,
}) {
  const [filter, setFilter] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState(() => new Set());

  const rows = useMemo(() => {
    const out = (regions || []).filter((r) => r.value > 0 && r.name);
    return [...out].sort((a, b) => a.name.localeCompare(b.name));
  }, [regions]);

  const shown = useMemo(() => matchRegions(rows, filter), [rows, filter]);

  if (!rows.length) return null;

  const isolatedSet = isolated instanceof Set ? isolated : null;
  const toggle = (value) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const applyIsolate = () => {
    onIsolate?.(atlasId, picked.size ? [...picked] : null);
  };
  const clearIsolate = () => {
    setPicked(new Set());
    onIsolate?.(atlasId, null);
  };

  return (
    <div className="mt-1 border border-border" data-testid={`atlas-labels-${atlasId}`}>
      <div className="flex items-center gap-1 border-b border-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${rows.length} regions…`}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          data-testid={`atlas-labels-filter-${atlasId}`}
        />
        <button
          onClick={() => setSelecting((v) => !v)}
          title={selecting ? "Done selecting" : "Select regions to isolate or export"}
          className={`shrink-0 px-2 py-1 text-[11px] transition-colors ${
            selecting ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid={`atlas-labels-select-${atlasId}`}
        >
          {selecting ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </div>

      {selecting && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
          <span className="text-[10px] text-muted-foreground">{picked.size} selected</span>
          <button
            onClick={applyIsolate}
            disabled={!picked.size}
            className="px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            title="Show only these regions"
            data-testid={`atlas-isolate-${atlasId}`}
          >
            Isolate
          </button>
          <button
            onClick={clearIsolate}
            disabled={!isolatedSet}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            title="Show every region again"
            data-testid={`atlas-isolate-clear-${atlasId}`}
          >
            <RotateCcw size={10} /> All
          </button>
          <button
            onClick={() => onRegionMask?.(atlasId, [...picked])}
            disabled={!picked.size}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            title="Add the selected regions as an ROI mask layer"
            data-testid={`atlas-region-mask-${atlasId}`}
          >
            <Download size={10} /> ROI
          </button>
        </div>
      )}

      <div className="max-h-48 overflow-y-auto">
        {shown.map((r) => {
          const dimmed = isolatedSet && !isolatedSet.has(r.value);
          return (
            <div
              key={r.value}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors hover:bg-panel-hover ${
                dimmed ? "opacity-40" : ""
              }`}
            >
              {selecting && (
                <input
                  type="checkbox"
                  checked={picked.has(r.value)}
                  onChange={() => toggle(r.value)}
                  className="shrink-0"
                  aria-label={`Select ${r.name}`}
                  data-testid={`atlas-label-pick-${atlasId}-${r.value}`}
                />
              )}
              <label
                className="relative shrink-0 cursor-pointer"
                title={`Colour of ${r.name}`}
              >
                <span
                  className="block h-3 w-3 border border-border"
                  style={{
                    background: r.color
                      ? `rgb(${r.color[0]},${r.color[1]},${r.color[2]})`
                      : "transparent",
                  }}
                >
                  {!r.color && <Palette size={10} className="opacity-50" />}
                </span>
                <input
                  type="color"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  value={r.color ? rgbToHex(r.color) : "#888888"}
                  onChange={(e) => onColors?.(atlasId, { [r.value]: hexToRgb(e.target.value) })}
                  data-testid={`atlas-label-color-${atlasId}-${r.value}`}
                />
              </label>
              <button
                onClick={() => onNavigate?.(atlasId, r.value)}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
                title={`Go to ${r.name}`}
                data-testid={`atlas-label-nav-${atlasId}-${r.value}`}
              >
                <span className="truncate">{r.name}</span>
                <Crosshair size={12} className="shrink-0 opacity-60" />
              </button>
            </div>
          );
        })}
        {!shown.length && (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">No match</div>
        )}
      </div>
    </div>
  );
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [136, 136, 136];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
