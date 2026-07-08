import React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Slider } from "@/components/ui/slider";

const COLORMAPS = [
  "gray",
  "hsv",
  "polar_angle",
  "warm",
  "cool",
  "actc",
  "random",
  "red",
  "green",
  "blue",
  "winter",
  "plasma",
  "viridis",
  "inferno",
  "magma",
  "turbo",
  "jet",
  "visfAtlas",
];

export const LayerControl = ({
  layer,
  visible,
  opacity,
  colormap,
  onToggle,
  onOpacityChange,
  onColormapChange,
  onRemove,
  removable = false,
  accentClass = "bg-white",
}) => {
  return (
    <div
      className={`group border border-[#27272A] bg-[#0a0a0a] hover:bg-[#111111] transition-colors ${
        visible ? "border-l-2 border-l-white" : ""
      }`}
      data-testid={`layer-${layer.id}`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          onClick={() => onToggle(layer.id)}
          className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center transition-colors ${
            visible
              ? "text-white hover:text-zinc-300"
              : "text-zinc-600 hover:text-zinc-400"
          }`}
          data-testid={`toggle-${layer.id}`}
          aria-label={visible ? "Hide layer" : "Show layer"}
        >
          {visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div
              className={`truncate text-[13px] font-medium ${
                visible ? "text-zinc-100" : "text-zinc-500"
              }`}
            >
              {layer.name}
            </div>
            {removable && (
              <button
                onClick={() => onRemove?.(layer.id)}
                className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:text-[#FF3B30] transition-colors"
                data-testid={`remove-${layer.id}`}
              >
                remove
              </button>
            )}
          </div>
          {layer.description && (
            <div className="truncate font-mono text-[10px] text-zinc-500 mt-0.5">
              {layer.description}
            </div>
          )}
        </div>
      </div>

      {visible && (
        <div className="px-3 pb-3 pt-1 space-y-2.5">
          {/* Opacity slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                opacity
              </span>
              <span className="font-mono text-[10px] text-zinc-300 tabular-nums">
                {Math.round(opacity * 100)}%
              </span>
            </div>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => onOpacityChange(layer.id, v[0] / 100)}
              className="cursor-pointer"
              data-testid={`opacity-${layer.id}`}
            />
          </div>

          {/* Colormap selector */}
          {onColormapChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                  colormap
                </span>
                <span className="font-mono text-[10px] text-zinc-300">
                  {colormap}
                </span>
              </div>
              <select
                value={colormap}
                onChange={(e) => onColormapChange(layer.id, e.target.value)}
                className="w-full bg-[#050505] border border-[#27272A] text-zinc-200 font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-zinc-500 cursor-pointer"
                data-testid={`colormap-${layer.id}`}
              >
                {COLORMAPS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LayerControl;
