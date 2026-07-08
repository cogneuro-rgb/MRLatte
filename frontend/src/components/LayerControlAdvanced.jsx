import React, { useEffect, useRef, useState, useCallback } from "react";
import { Eye, EyeOff, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { RangeSlider } from "@/components/ui/range-slider";
import { colormapGradient } from "@/lib/colormaps";

const COLORMAPS = [
  "gray", "hsv", "polar_angle", "warm", "cool", "actc", "random", "red", "green",
  "blue", "winter", "plasma", "viridis", "inferno", "magma", "turbo", "jet",
  "visfAtlas",
];

/**
 * Editable threshold label — click to edit as a textbox.
 */
const ThresholdValue = ({ value, onCommit, testId, align = "left" }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  // Seed the textbox ONLY when entering edit mode. Re-running on every
  // `value` change would clobber the user's typed digits whenever the
  // parent re-renders mid-edit (e.g. after a debounced overlayMeta refresh).
  useEffect(() => {
    if (!editing) return;
    setText(value != null ? String(Number(value).toFixed(3).replace(/\.?0+$/, "")) : "");
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    const n = parseFloat(text);
    if (!isNaN(n)) onCommit(n);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className={`w-16 bg-[#050505] border border-zinc-500 text-zinc-100 font-mono text-[10px] px-1 py-0.5 focus:outline-none focus:border-white tabular-nums ${
          align === "right" ? "text-right" : "text-left"
        }`}
        data-testid={`${testId}-input`}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={`font-mono text-[10px] text-zinc-300 hover:text-white hover:underline tabular-nums px-1 ${
        align === "right" ? "text-right" : "text-left"
      }`}
      data-testid={testId}
    >
      {value != null ? Number(value).toFixed(2) : "—"}
    </button>
  );
};

export const LayerControlAdvanced = ({
  layer,
  visible,
  opacity,
  colormap,
  // Threshold props (optional — when omitted, this layer behaves as
  // categorical / binary and skips the dual-threshold UI):
  globalMin,
  globalMax,
  calMin,
  calMax,
  isSigned,           // shows mask-zero toggle when true
  ignoreZeroVoxels,
  invertThreshold,    // when true, voxels OUTSIDE [calMin, calMax] are visible
  removable = false,
  showColormap = true,
  // Per-layer label-atlas selector (used by activation maps so the crosshair
  // info shows the region name from whichever atlas the user picks).
  labelAtlasOptions,    // [{id, name}]
  labelAtlasId,         // current selection
  onLabelAtlasChange,   // (layerId, atlasId)
  // callbacks
  onToggle,
  onOpacityChange,
  onColormapChange,
  onCalRangeChange,
  onIgnoreZeroChange,
  onInvertThresholdChange,
  onRemove,
}) => {
  // Controls whether the advanced section (threshold, colormap, atlas) is shown.
  // Collapses by default to keep the sidebar compact when many layers are loaded.
  const [expanded, setExpanded] = useState(false);

  const hasThresholds =
    typeof globalMin === "number" &&
    typeof globalMax === "number" &&
    globalMax > globalMin;

  // Normalise cal_min/max within [globalMin, globalMax]
  const lo = hasThresholds ? Math.max(globalMin, Math.min(globalMax, calMin ?? globalMin)) : 0;
  const hi = hasThresholds ? Math.max(globalMin, Math.min(globalMax, calMax ?? globalMax)) : 1;
  const sortedLo = Math.min(lo, hi);
  const sortedHi = Math.max(lo, hi);

  const SLIDER_STEPS = 200;
  const range = hasThresholds ? globalMax - globalMin : 1;
  const toSlider = (v) => ((v - globalMin) / range) * SLIDER_STEPS;
  const fromSlider = (s) => globalMin + (s / SLIDER_STEPS) * range;

  const handleSliderChange = useCallback(
    (vals) => {
      const a = fromSlider(vals[0]);
      const b = fromSlider(vals[1]);
      onCalRangeChange?.(layer.id, Math.min(a, b), Math.max(a, b));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globalMin, globalMax, onCalRangeChange, layer.id]
  );

  const handleLoText = (v) => onCalRangeChange?.(layer.id, Math.min(v, sortedHi), Math.max(v, sortedHi));
  const handleHiText = (v) => onCalRangeChange?.(layer.id, Math.min(sortedLo, v), Math.max(sortedLo, v));

  const activeGrad = colormapGradient(colormap, { frac0: 0, frac1: 1, direction: "to right" });

  return (
    <div
      className={`group border border-[#27272A] bg-[#0a0a0a] hover:bg-[#111111] transition-colors ${
        visible ? "border-l-2 border-l-white" : ""
      }`}
      data-testid={`layer-${layer.id}`}
    >
      {/* Header row: visibility toggle | name | expand chevron | remove */}
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          onClick={() => onToggle?.(layer.id)}
          className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center transition-colors ${
            visible ? "text-white hover:text-zinc-300" : "text-zinc-600 hover:text-zinc-400"
          }`}
          data-testid={`toggle-${layer.id}`}
          aria-label={visible ? "Hide layer" : "Show layer"}
        >
          {visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className={`truncate text-[12px] font-medium ${visible ? "text-zinc-100" : "text-zinc-500"}`}>
              {layer.name}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {removable && (
                <button
                  onClick={() => onRemove?.(layer.id)}
                  className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-[#FF3B30] transition-colors"
                  data-testid={`remove-${layer.id}`}
                >
                  <Trash2 size={10} />
                </button>
              )}
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-zinc-500 hover:text-white transition-colors"
                data-testid={`expand-${layer.id}`}
                aria-label={expanded ? "Collapse controls" : "Expand controls"}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            </div>
          </div>
          {layer.description && (
            <div className="truncate font-mono text-[10px] text-zinc-500 mt-0.5">{layer.description}</div>
          )}
        </div>
      </div>

      {/* Opacity slider — always visible when layer is on (compact row) */}
      {visible && onOpacityChange && (
        <div className="px-3 pb-2 pt-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-600 w-12 flex-shrink-0">opacity</span>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => onOpacityChange(layer.id, v[0] / 100)}
              className="cursor-pointer flex-1"
              data-testid={`opacity-${layer.id}`}
            />
            <span className="font-mono text-[10px] text-zinc-400 tabular-nums w-8 text-right">{Math.round(opacity * 100)}%</span>
          </div>
        </div>
      )}

      {/* Expanded advanced controls */}
      {expanded && visible && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-[#1a1a1a]">

          {/* Threshold dual-handle slider with live colormap gradient */}
          {hasThresholds && onCalRangeChange && (
            <div className="space-y-1.5" data-testid={`threshold-block-${layer.id}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">threshold</span>
                <div className="flex items-center gap-1.5">
                  <ThresholdValue
                    value={sortedLo}
                    onCommit={handleLoText}
                    testId={`threshold-lo-${layer.id}`}
                    align="left"
                  />
                  <span className="font-mono text-[10px] text-zinc-600">–</span>
                  <ThresholdValue
                    value={sortedHi}
                    onCommit={handleHiText}
                    testId={`threshold-hi-${layer.id}`}
                    align="right"
                  />
                </div>
              </div>
              <div
                className="relative h-4 rounded-none"
                style={{ background: activeGrad }}
              >
                <RangeSlider
                  value={[toSlider(sortedLo), toSlider(sortedHi)]}
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  onValueChange={handleSliderChange}
                  minStepsBetweenThumbs={0}
                  className="absolute inset-0 cursor-pointer"
                  data-testid={`threshold-${layer.id}`}
                />
              </div>
              <div className="flex items-center justify-between text-[9px] text-zinc-600 font-mono tabular-nums">
                <span>{Number(globalMin).toFixed(2)}</span>
                <span>{Number(globalMax).toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Threshold direction toggle (inside ↔ outside) */}
          {hasThresholds && onInvertThresholdChange && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                show {invertThreshold ? "outside" : "inside"} thresholds
              </span>
              <button
                onClick={() => onInvertThresholdChange(layer.id, !invertThreshold)}
                className={`relative inline-flex h-4 w-8 transition-colors border ${
                  invertThreshold ? "bg-white border-white" : "bg-transparent border-[#27272A]"
                }`}
                data-testid={`invert-threshold-${layer.id}`}
              >
                <span className={`inline-block h-3 w-3 transition-transform ${
                  invertThreshold ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"
                }`} />
              </button>
            </div>
          )}

          {/* Mask-zero toggle for signed data */}
          {isSigned && onIgnoreZeroChange && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                mask zero voxels
              </span>
              <button
                onClick={() => onIgnoreZeroChange(layer.id, !ignoreZeroVoxels)}
                className={`relative inline-flex h-4 w-8 transition-colors border ${
                  ignoreZeroVoxels ? "bg-white border-white" : "bg-transparent border-[#27272A]"
                }`}
                data-testid={`mask-zero-${layer.id}`}
              >
                <span className={`inline-block h-3 w-3 transition-transform ${
                  ignoreZeroVoxels ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"
                }`} />
              </button>
            </div>
          )}

          {/* Colormap selector */}
          {showColormap && onColormapChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">colormap</span>
                <span className="font-mono text-[10px] text-zinc-300">{colormap}</span>
              </div>
              <select
                value={colormap}
                onChange={(e) => onColormapChange(layer.id, e.target.value)}
                className="w-full bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-zinc-500 cursor-pointer"
                data-testid={`colormap-${layer.id}`}
              >
                {COLORMAPS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {/* Label-atlas selector */}
          {labelAtlasOptions && labelAtlasOptions.length > 0 && onLabelAtlasChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">label atlas</span>
                <span className="font-mono text-[10px] text-zinc-300">
                  {labelAtlasOptions.find((a) => a.id === labelAtlasId)?.short || "—"}
                </span>
              </div>
              <select
                value={labelAtlasId || ""}
                onChange={(e) => onLabelAtlasChange(layer.id, e.target.value || null)}
                className="w-full bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-zinc-500 cursor-pointer"
                data-testid={`label-atlas-${layer.id}`}
              >
                <option value="">— none —</option>
                {labelAtlasOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LayerControlAdvanced;
