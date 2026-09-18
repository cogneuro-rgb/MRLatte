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
 *
 * Colors here are deliberately fixed (not theme tokens): this renders as an
 * absolutely-positioned overlay on the NiiVue canvas, which stays a fixed
 * dark backdrop regardless of app theme (see NiivueViewer's `backColor` /
 * bg-black) — theme-adaptive text would go dark-on-dark in light mode.
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
          // The bar spans the COLOUR-scaling range (value→colour), so it shows
          // the full colormap from colorMin (bottom) to colorMax (top). Falls
          // back to the global/cal range for overlays predating dual thresholds.
          const cMin = e.colorMin ?? e.globalMin ?? e.calMin ?? 0;
          const cMax = e.colorMax ?? e.globalMax ?? e.calMax ?? 1;
          const cRange = cMax - cMin;
          const gradient = colormapGradient(e.colormap, {
            frac0: 0,
            frac1: 1,
            direction: "to top",
            steps: 32,
            invert: !!e.colormapInverted, // item 55 follow-up
          });
          // Visibility-cutoff ticks: where the [calMin, calMax] window falls
          // inside the colour range, mark it (mrview draws the transparency
          // threshold as a line on the colorbar). Fraction measured from the
          // bottom; skip cutoffs at/outside the ends (they're just the edge).
          const tickFrac = (v) => (cRange > 0 ? (v - cMin) / cRange : 0);
          const ticks = [];
          for (const v of [e.calMin, e.calMax]) {
            if (typeof v !== "number") continue;
            const f = tickFrac(v);
            if (f > 0.001 && f < 0.999) ticks.push(f);
          }
          // Dim whichever bands are actually HIDDEN on the canvas — same
          // invariant as the layer-panel threshold strip (item 118): bright =
          // visible. Normally voxels OUTSIDE [calMin, calMax] are hidden, so
          // the bar dims below calMin and above calMax, bright in between.
          // When invertThreshold is on ("show outside thresholds"), voxels
          // INSIDE the window are hidden instead, so the dim band flips to
          // the middle.
          const hasCutoffs = typeof e.calMin === "number" && typeof e.calMax === "number";
          const loFrac = hasCutoffs ? Math.min(1, Math.max(0, tickFrac(e.calMin))) : 0;
          const hiFrac = hasCutoffs ? Math.min(1, Math.max(0, tickFrac(e.calMax))) : 1;
          const invertThreshold = !!e.invertThreshold;

          return (
            <div
              key={e.id}
              className="flex flex-col items-center gap-1"
              data-testid={`colorbar-${e.id}`}
            >
              {/* Max label */}
              <div
                className="font-mono text-[9px] text-zinc-100 tabular-nums"
                data-testid={`colorbar-max-${e.id}`}
              >
                {Number(cMax).toFixed(2)}
              </div>

              {/* Gradient bar + visibility ticks */}
              <div
                className="relative border border-white/15 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                style={{ width: "28px", height: "160px", background: gradient }}
              >
                {hasCutoffs && (invertThreshold ? (
                  <div
                    className="absolute left-0 right-0 bg-black/65 pointer-events-none"
                    style={{
                      bottom: `${loFrac * 100}%`,
                      height: `${Math.max(0, hiFrac - loFrac) * 100}%`,
                    }}
                  />
                ) : (
                  <>
                    <div
                      className="absolute left-0 right-0 bottom-0 bg-black/65 pointer-events-none"
                      style={{ height: `${loFrac * 100}%` }}
                    />
                    <div
                      className="absolute left-0 right-0 top-0 bg-black/65 pointer-events-none"
                      style={{ height: `${Math.max(0, 1 - hiFrac) * 100}%` }}
                    />
                  </>
                ))}
                {ticks.map((f, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 h-px bg-white/85"
                    style={{ bottom: `${f * 100}%`, boxShadow: "0 0 1px rgba(0,0,0,0.9)" }}
                  />
                ))}
              </div>

              {/* Min label */}
              <div
                className="font-mono text-[9px] text-zinc-100 tabular-nums"
                data-testid={`colorbar-min-${e.id}`}
              >
                {Number(cMin).toFixed(2)}
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
              canGoOlder ? "text-zinc-400 hover:text-zinc-100" : "text-zinc-700 cursor-default"
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
              canGoNewer ? "text-zinc-400 hover:text-zinc-100" : "text-zinc-700 cursor-default"
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
