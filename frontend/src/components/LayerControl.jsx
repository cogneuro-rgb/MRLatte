import React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { EditableNumber } from "@/components/ui/editable-number";

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
      className={`group border border-border bg-panel hover:bg-panel-hover transition-colors rounded-lg ${
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
                className="text-[12px] font-medium text-muted-foreground hover:text-destructive transition-colors"
                data-testid={`remove-${layer.id}`}
              >
                remove
              </button>
            )}
          </div>
          {layer.description && (
            <div className="truncate font-mono text-[11px] text-muted-foreground mt-0.5">
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
              <span className="cap text-subtle">
                opacity
              </span>
              <EditableNumber value={opacity * 100} min={0} max={100} integer onCommit={(v) => onOpacityChange(layer.id, v / 100)} label="Opacity, %"
                className="font-mono text-[11px] text-foreground tabular-nums">
                {Math.round(opacity * 100)}%
              </EditableNumber>
            </div>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => onOpacityChange(layer.id, v[0] / 100)}
              className="cursor-pointer"
              aria-label="Opacity"
              data-testid={`opacity-${layer.id}`}
            />
          </div>

          {/* Colormap selector */}
          {onColormapChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="cap text-subtle">
                  colormap
                </span>
                <span className="font-mono text-[11px] text-foreground">
                  {colormap}
                </span>
              </div>
              <select
                value={colormap}
                onChange={(e) => onColormapChange(layer.id, e.target.value)}
                className="w-full bg-background border border-edge text-foreground font-mono text-[12px] px-2 py-1 focus:outline-none cursor-pointer"
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
