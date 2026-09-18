import React, { useState } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { ChevronLeft, ChevronRight, LineChart } from "lucide-react";
import TimeseriesGraph from "@/components/TimeseriesGraph";

// Shared outer width for both the pill and the graph panel below — giving
// them the SAME declared width means the flex column's independent
// per-child centering lands both at the same left/right edges, with no
// manual position math needed. Bigger than the pill's old auto-fit width
// (~280px) per request; the slider (below) grows to fill the pill via
// flex-1 rather than a fixed px width, so it stays proportionate.
const PANEL_WIDTH = 360;
const GRAPH_HEIGHT = 130;
const PANEL_PAD_X = 16; // px, matches the graph panel's px-2 (8px * 2)

/**
 * 4D frame-stepping control (prev/next + scrub slider + "Frame X / N"), plus
 * an optional timeseries graph (intensity at the crosshair voxel vs. frame)
 * toggled by the chart button to the label's right. Renders nothing for a
 * plain 3D volume (nFrames <= 1).
 *
 * Colors are deliberately fixed (not theme tokens), matching ColorBarStack:
 * this sits as an absolutely-positioned overlay on the NiiVue canvas, which
 * stays a fixed dark backdrop regardless of app theme.
 *
 * Placement note: the app's normal bottom-controls bar is hidden in focus
 * mode, but the 4D quick-open route turns focus mode ON — so this can't live
 * there (it would be invisible exactly when it's needed). It's rendered as
 * its own canvas overlay instead, and stays visible through focus mode.
 */
export default function FrameStepper({ frame, nFrames, onStepFrame, onSetFrame, timeseriesData }) {
  const [graphOpen, setGraphOpen] = useState(false);
  if (!(nFrames > 1)) return null;

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2"
      data-testid="frame-stepper-wrap"
    >
      {graphOpen && (
        <div
          className="bg-black/70 border border-white/15 rounded-lg px-2 py-2"
          style={{ width: PANEL_WIDTH }}
          data-testid="frame-stepper-graph-panel"
        >
          {timeseriesData ? (
            <TimeseriesGraph
              values={timeseriesData}
              frame={frame}
              nFrames={nFrames}
              onScrub={onSetFrame}
              width={PANEL_WIDTH - PANEL_PAD_X}
              height={GRAPH_HEIGHT}
            />
          ) : (
            <div
              style={{ width: PANEL_WIDTH - PANEL_PAD_X, height: GRAPH_HEIGHT }}
              className="flex items-center justify-center font-mono text-[10px] text-zinc-500"
            >
              Move the crosshair onto the volume
            </div>
          )}
        </div>
      )}

      <div
        className="flex items-center gap-2.5 bg-black/55 border border-white/15 rounded-full px-3 py-1.5 select-none"
        style={{ width: PANEL_WIDTH }}
        data-testid="frame-stepper"
      >
        <button
          onClick={() => onStepFrame(-1)}
          className="text-zinc-300 hover:text-white transition-colors"
          title="Previous frame"
          data-testid="frame-stepper-prev"
        >
          <ChevronLeft size={16} />
        </button>

        <SliderPrimitive.Root
          className="relative flex items-center flex-1 h-4 touch-none select-none"
          min={0}
          max={nFrames - 1}
          step={1}
          value={[frame]}
          onValueChange={([v]) => onSetFrame(v)}
          data-testid="frame-stepper-slider"
        >
          <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-white/20">
            <SliderPrimitive.Range className="absolute h-full bg-zinc-100" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-3 w-3 rounded-full bg-zinc-100 shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70" />
        </SliderPrimitive.Root>

        <button
          onClick={() => onStepFrame(1)}
          className="text-zinc-300 hover:text-white transition-colors"
          title="Next frame"
          data-testid="frame-stepper-next"
        >
          <ChevronRight size={16} />
        </button>

        <div className="font-mono text-[10px] text-zinc-200 tabular-nums whitespace-nowrap" data-testid="frame-stepper-label">
          Frame {frame + 1} / {nFrames}
        </div>

        <button
          onClick={() => setGraphOpen((v) => !v)}
          className={`transition-colors ${graphOpen ? "text-white" : "text-zinc-400 hover:text-white"}`}
          title="Toggle timeseries graph"
          data-testid="frame-stepper-graph-toggle"
        >
          <LineChart size={14} />
        </button>
      </div>
    </div>
  );
}
