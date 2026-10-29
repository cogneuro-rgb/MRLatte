import React, { useState, useEffect, useRef } from "react";
import { colormapGradient, colormapSample } from "@/lib/colormaps";

// The colours voxels actually get across [lo, hi] (bottom→top), given the
// colour-scaling window [cMin, cMax]: each value's colour is its position in
// the colour window, clamped to the colormap's ends.
export function visibleRangeGradient(colormap, lo, hi, cMin, cMax, { invert = false, steps = 32 } = {}) {
  const cSpan = cMax - cMin;
  const stops = [];
  for (let i = 0; i < steps; i++) {
    const p = i / (steps - 1);
    const v = lo + p * (hi - lo);
    let t = cSpan > 0 ? (v - cMin) / cSpan : (v < cMin ? 0 : 1);
    t = Math.max(0, Math.min(1, t));
    stops.push(`${colormapSample(colormap, invert ? 1 - t : t)} ${(p * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
}

/**
 * Horizontal strip of vertical colorbars rendered as an HTML overlay on the
 * left edge of the viewer canvas. Each bar spans its layer's visibility window
 * (the values shown), coloured as those values are drawn.
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
  const rootRef = useRef(null);
  const [barHeight, setBarHeight] = useState(160);
  const hasEntries = entries.length > 0;

  // Keep window pinned to the newest 3 when entries are added or removed.
  useEffect(() => {
    setStartIdx(Math.max(0, entries.length - 3));
  }, [entries.length]);

  // Bars are min(160px, 30% of the viewer's height), never under 48px, so at
  // 200% zoom they don't cover a third of the image. The viewer is the stack's
  // positioned container; the stack only mounts while there are entries.
  useEffect(() => {
    const host = rootRef.current?.offsetParent || rootRef.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    const update = () => setBarHeight(Math.max(48, Math.min(160, Math.round(host.clientHeight * 0.3))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hasEntries]);

  if (!entries.length) return null;

  const visible = entries.slice(startIdx, startIdx + 3);
  const canGoOlder = startIdx > 0;
  const canGoNewer = startIdx + 3 < entries.length;

  return (
    <div
      ref={rootRef}
      className="absolute top-3 left-3 z-10 flex flex-col items-start gap-1 pointer-events-none select-none"
      data-testid="colorbar-stack"
    >
      {/* Bar row — newest is rightmost */}
      <div className="flex flex-row gap-3">
        {visible.map((e) => {
          // The bar spans the VISIBILITY window [calMin, calMax] — the values
          // actually shown — and its labels are those values. Only in "show
          // outside thresholds" mode (visible voxels at both ends, not one
          // window) does it span the colour range, with the hidden middle dimmed.
          const hasWindow = typeof e.calMin === "number" && typeof e.calMax === "number" && e.calMax > e.calMin;
          const byVisibility = hasWindow && !e.invertThreshold;
          // Colour-scaling window (value→colour). A layer without its own colour
          // range (retinotopy, older overlays) is coloured across its visibility
          // window, as niivue draws it; otherwise fall back to the global range.
          const colorLo = e.colorMin ?? (byVisibility ? e.calMin : e.globalMin ?? e.calMin ?? 0);
          const colorHi = e.colorMax ?? (byVisibility ? e.calMax : e.globalMax ?? e.calMax ?? 1);
          const cMin = byVisibility ? e.calMin : colorLo;
          const cMax = byVisibility ? e.calMax : colorHi;
          const cRange = cMax - cMin;
          const gradient = byVisibility
            ? visibleRangeGradient(e.colormap, e.calMin, e.calMax, colorLo, colorHi, { invert: !!e.colormapInverted })
            : colormapGradient(e.colormap, {
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
          for (const v of byVisibility ? [] : [e.calMin, e.calMax]) {
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
          const hasCutoffs = !byVisibility && typeof e.calMin === "number" && typeof e.calMax === "number";
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
                className="font-mono text-[10.5px] text-[#D9D4CC]"
                data-testid={`colorbar-max-${e.id}`}
              >
                {Number(cMax).toFixed(2)}
              </div>

              {/* Gradient bar + visibility ticks */}
              <div
                className="keep-colours relative overflow-hidden rounded-[3px] border border-white/15 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                style={{ width: "28px", height: `${barHeight}px`, background: gradient }}
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
                className="font-mono text-[10.5px] text-[#D9D4CC]"
                data-testid={`colorbar-min-${e.id}`}
              >
                {Number(cMin).toFixed(2)}
              </div>

              {/* Layer name */}
              <div
                className="w-[44px] truncate text-center text-[10.5px] text-[#BDB6AB]"
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
            className={`px-1 text-[11px] transition-colors ${
              canGoOlder ? "text-[#BDB6AB] hover:text-[#F3EFE8]" : "text-[#4A463F] cursor-default"
            }`}
            title="Show older colorbars"
            data-testid="colorbar-older"
          >
            ◂ Older
          </button>
          <button
            onClick={() => setStartIdx((i) => Math.min(entries.length - 3, i + 1))}
            disabled={!canGoNewer}
            className={`px-1 text-[11px] transition-colors ${
              canGoNewer ? "text-[#BDB6AB] hover:text-[#F3EFE8]" : "text-[#4A463F] cursor-default"
            }`}
            title="Show newer colorbars"
            data-testid="colorbar-newer"
          >
            Newer ▸
          </button>
        </div>
      )}
    </div>
  );
};

export default ColorBarStack;
