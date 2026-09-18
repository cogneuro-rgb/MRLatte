import React from "react";
import { MapPin, Activity } from "lucide-react";

/**
 * CrosshairInfo — current crosshair location, voxel values, and atlas labels.
 *
 * Props:
 *   mm     : [x, y, z] in MNI mm
 *   vox    : [i, j, k] voxel indices in base volume
 *   values : Array<{ name: string, value: number }> — per loaded volume
 *   labels : { [layerName]: string } — categorical atlas hits
 */
export const CrosshairInfo = ({ mm, vox, values = [], labels = {} }) => {
  const labelEntries = Object.entries(labels).filter(([, v]) => v);
  const visibleValues = (values || []).filter((v) => typeof v.value === "number");

  const fmt = (n) => {
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a === 0) return "0";
    if (a < 0.01 || a >= 10000) return n.toExponential(2);
    return Number(n).toFixed(a < 1 ? 3 : 2);
  };

  // Fixed-height, non-wrapping rows (horizontal scroll instead of wrap) so the
  // bar's total height never changes as atlas labels/values appear or
  // disappear while the crosshair moves — a variable-height bar here pushes
  // the canvas below it up/down on every move, reading as "jitter".
  return (
    <div
      className="flex flex-col gap-1 px-4 py-2 border border-border bg-panel"
      data-testid="crosshair-info"
    >
      <div className="flex items-center gap-x-6 h-7 overflow-x-auto overflow-y-hidden flex-nowrap thin-scroll">
        <div className="flex items-center gap-2 flex-shrink-0 whitespace-nowrap">
          <MapPin size={11} className="text-muted-foreground" />
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">mni</span>
          <span className="font-mono text-[11px] text-foreground tabular-nums" data-testid="crosshair-mm">
            {mm
              ? `${mm[0].toFixed(1).padStart(6)}, ${mm[1].toFixed(1).padStart(6)}, ${mm[2].toFixed(1).padStart(6)}`
              : "—"}
          </span>
        </div>
        {vox && (
          <div className="flex items-center gap-2 flex-shrink-0 whitespace-nowrap">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">vox</span>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {vox.map((v) => Math.round(v)).join(", ")}
            </span>
          </div>
        )}
        {visibleValues.length > 0 && (
          <div className="flex items-center gap-3 flex-shrink-0 whitespace-nowrap" data-testid="crosshair-values">
            <Activity size={11} className="text-muted-foreground flex-shrink-0" />
            {visibleValues.map((v, i) => (
              <div key={`${v.name}-${i}`} className="flex items-center gap-1.5 flex-shrink-0">
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
                  {v.name}
                </span>
                <span
                  className="font-mono text-[11px] text-foreground px-1.5 py-0.5 border border-border bg-panel-hover tabular-nums"
                  data-testid={`crosshair-val-${v.name}`}
                >
                  {fmt(v.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div
        className="flex items-center gap-x-3 h-7 overflow-x-auto overflow-y-hidden flex-nowrap thin-scroll"
        data-testid="crosshair-labels"
      >
        {labelEntries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground flex-shrink-0">
              {k}
            </span>
            <span
              className="font-mono text-[11px] text-foreground px-1.5 py-0.5 border border-border bg-panel-hover truncate max-w-[280px]"
              title={v}
            >
              {v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CrosshairInfo;
