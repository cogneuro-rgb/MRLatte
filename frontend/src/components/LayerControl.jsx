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
  accentClass = "bg-foreground",
}) => {
  return (
    <div
      className={`group border border-border bg-panel hover:bg-panel-hover transition-colors ${
        visible ? "border-l-2 border-l-foreground" : ""
      }`}
      data-testid={`layer-${layer.id}`}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          onClick={() => onToggle(layer.id)}
          className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center transition-colors ${
            visible
              ? "text-foreground"
              : "text-subtle hover:text-muted-foreground"
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
                visible ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {layer.name}
            </div>
            {removable && (
              <button
                onClick={() => onRemove?.(layer.id)}
                className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
                data-testid={`remove-${layer.id}`}
              >
                remove
              </button>
            )}
          </div>
          {layer.description && (
            <div className="truncate font-mono text-[10px] text-muted-foreground mt-0.5">
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
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                opacity
              </span>
              <span className="font-mono text-[10px] text-foreground tabular-nums">
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
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                  colormap
                </span>
                <span className="font-mono text-[10px] text-foreground">
                  {colormap}
                </span>
              </div>
              <select
                value={colormap}
                onChange={(e) => onColormapChange(layer.id, e.target.value)}
                className="w-full bg-background border border-border text-foreground font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-muted-foreground cursor-pointer"
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
