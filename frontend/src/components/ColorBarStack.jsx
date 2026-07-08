import React, { useState, useEffect } from "react";
import { colormapGradient } from "@/lib/colormaps";

/**
 * Horizontal strip of vertical colorbars rendered as an HTML overlay on the
 * left edge of the viewer canvas.
 *
 * Props:
 *   entries — array of { id, name, colormap, calMin, calMax, globalMin, globalMax }
 *
 * Behaviour:
 *   - Shows up to 3 bars at a time.
 *   - Newest entry is on the right; oldest on the left.
 *   - When entries.length > 3, ◄ / ► navigation arrows appear below the bars
 *     so the user can scroll through older entries.
 *   - The window automatically advances to show the 3 most-recently-added
 *     bars whenever a new entry is pushed.
 */
export const ColorBarStack = ({ entries = [] }) => {
  const [startIdx, setStartIdx] = useState(0);

  // Keep window pinned to the newest 3 when entries are added or removed.
  useEffect(() => {
    setStartIdx(Math.max(0, entries.length - 3));
  }, [entries.length]);

  if (!entries.length) return null;

  const visible = entries.slice(startIdx, startIdx + 3);
  const canGoOlder = startIdx > 0;
  const canGoNewer = startIdx + 3 < entries.length;

  return (
    <div
      className="absolute top-3 left-3 z-10 flex flex-col items-start gap-1 pointer-events-none select-none"
      data-testid="colorbar-stack"
    >
      {/* Bar row — newest is rightmost */}
      <div className="flex flex-row gap-3">
        {visible.map((e) => {
          const range = (e.globalMax ?? 1) - (e.globalMin ?? 0);
          const frac0 = range > 0 ? ((e.calMin ?? 0) - (e.globalMin ?? 0)) / range : 0;
          const frac1 = range > 0 ? ((e.calMax ?? 1) - (e.globalMin ?? 0)) / range : 1;
          const gradient = colormapGradient(e.colormap, {
            frac0,
            frac1,
            direction: "to top",
            steps: 32,
          });

          return (
            <div
              key={e.id}
              className="flex flex-col items-center gap-1"
              data-testid={`colorbar-${e.id}`}
            >
              {/* Max label */}
              <div
                className="font-mono text-[9px] text-zinc-300 tabular-nums"
                data-testid={`colorbar-max-${e.id}`}
              >
                {Number(e.calMax ?? 0).toFixed(2)}
              </div>

              {/* Gradient bar */}
              <div
                className="border border-[#27272A] shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                style={{ width: "28px", height: "160px", background: gradient }}
              />

              {/* Min label */}
              <div
                className="font-mono text-[9px] text-zinc-300 tabular-nums"
                data-testid={`colorbar-min-${e.id}`}
              >
                {Number(e.calMin ?? 0).toFixed(2)}
              </div>

              {/* Layer name */}
              <div
                className="font-mono text-[8px] text-zinc-500 w-[28px] truncate text-center"
                title={e.name}
              >
                {e.name}
              </div>
            </div>
          );
        })}
      </div>

      {/* Navigation row — only rendered when there are more than 3 entries */}
      {entries.length > 3 && (
        <div className="flex flex-row gap-2 pt-0.5 pointer-events-auto">
          <button
            onClick={() => setStartIdx((i) => Math.max(0, i - 1))}
            disabled={!canGoOlder}
            className={`font-mono text-[9px] uppercase tracking-[0.15em] transition-colors px-1 ${
              canGoOlder ? "text-zinc-400 hover:text-white" : "text-zinc-700 cursor-default"
            }`}
            title="Show older colorbars"
            data-testid="colorbar-older"
          >
            ◄ older
          </button>
          <button
            onClick={() => setStartIdx((i) => Math.min(entries.length - 3, i + 1))}
            disabled={!canGoNewer}
            className={`font-mono text-[9px] uppercase tracking-[0.15em] transition-colors px-1 ${
              canGoNewer ? "text-zinc-400 hover:text-white" : "text-zinc-700 cursor-default"
            }`}
            title="Show newer colorbars"
            data-testid="colorbar-newer"
          >
            newer ►
          </button>
        </div>
      )}
    </div>
  );
};

export default ColorBarStack;
