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
 *   aside  : optional node pinned to the right end of the first row (the
 *            viewer status), outside its horizontal scroll
 */
export const CrosshairInfo = ({ mm, vox, values = [], labels = {}, aside }) => {
  const labelEntries = Object.entries(labels).filter(([, v]) => v);
  const visibleValues = (values || []).filter((v) => typeof v.value === "number");

  const fmt = (n) => {
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a === 0) return "0";
    if (a < 0.01 || a >= 10000) return n.toExponential(2);
    return Number(n).toFixed(a < 1 ? 3 : 2);
  };

  const chip = "rounded-[5px] border border-border bg-card px-[7px] py-px text-[11.5px] text-foreground";

  // Fixed-height, non-wrapping rows (horizontal scroll instead of wrap) so the
  // bar's total height never changes as atlas labels/values appear or
  // disappear while the crosshair moves — a variable-height bar here pushes
  // the canvas above it up/down on every move, reading as "jitter".
  return (
    <div
      role="status"
      aria-label="Crosshair"
      className="flex flex-col gap-1 border-t border-border bg-panel px-3.5 py-1.5"
      data-testid="crosshair-info"
    >
      <div className="flex h-6 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-5 overflow-x-auto overflow-y-hidden thin-scroll">
          <div className="flex flex-shrink-0 items-center gap-[7px] whitespace-nowrap">
            <MapPin size={12} className="text-subtle" />
            <span className="cap text-subtle">MNI</span>
            <span className="font-mono text-[12px] text-foreground" data-testid="crosshair-mm">
              {mm
                ? `${mm[0].toFixed(1).padStart(6)}, ${mm[1].toFixed(1).padStart(6)}, ${mm[2].toFixed(1).padStart(6)}`
                : "—"}
            </span>
          </div>
          {vox && (
            <div className="flex flex-shrink-0 items-center gap-[7px] whitespace-nowrap">
              <span className="cap text-subtle">Vox</span>
              <span className="font-mono text-[12px] text-muted-foreground">
                {vox.map((v) => Math.round(v)).join(", ")}
              </span>
            </div>
          )}
          {visibleValues.length > 0 && (
            <div className="flex flex-shrink-0 items-center gap-3 whitespace-nowrap" data-testid="crosshair-values">
              <Activity size={12} className="flex-shrink-0 text-subtle" />
              {visibleValues.map((v, i) => (
                <div key={`${v.name}-${i}`} className="flex flex-shrink-0 items-center gap-1.5">
                  <span className="cap text-subtle">
                    {v.name}
                  </span>
                  <span
                    className={`${chip} font-mono`}
                    data-testid={`crosshair-val-${v.name}`}
                  >
                    {fmt(v.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {aside}
      </div>
      <div
        className="flex h-6 flex-nowrap items-center gap-x-3.5 overflow-x-auto overflow-y-hidden thin-scroll"
        data-testid="crosshair-labels"
      >
        {labelEntries.map(([k, v]) => (
          <div key={k} className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap">
            <span className="cap flex-shrink-0 text-subtle">
              {k}
            </span>
            <span
              className={`${chip} max-w-[280px] truncate`}
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
