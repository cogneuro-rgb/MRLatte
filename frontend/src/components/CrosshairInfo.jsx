import React from "react";
import { MapPin, Activity, AlertTriangle } from "lucide-react";

/**
 * CrosshairInfo — current crosshair location, voxel values, and atlas labels.
 *
 * Props:
 *   mm     : [x, y, z] in MNI mm
 *   vox    : [i, j, k] voxel indices in base volume
 *   values : Array<{ name: string, value: number }> — per loaded volume
 *   labels : { [layerName]: string } — categorical atlas hits
 */
export const CrosshairInfo = ({ mm, vox, values = [], labels = {}, eloquent = null }) => {
  const labelEntries = Object.entries(labels).filter(([, v]) => v);
  const visibleValues = (values || []).filter((v) => typeof v.value === "number");

  const fmt = (n) => {
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a === 0) return "0";
    if (a < 0.01 || a >= 10000) return n.toExponential(2);
    return Number(n).toFixed(a < 1 ? 3 : 2);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 border border-[#27272A] bg-[#0a0a0a]"
      data-testid="crosshair-info"
    >
      <div className="flex items-center gap-2">
        <MapPin size={11} className="text-zinc-500" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">mni</span>
        <span className="font-mono text-[11px] text-zinc-200 tabular-nums" data-testid="crosshair-mm">
          {mm
            ? `${mm[0].toFixed(1).padStart(6)}, ${mm[1].toFixed(1).padStart(6)}, ${mm[2].toFixed(1).padStart(6)}`
            : "—"}
        </span>
      </div>
      {vox && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">vox</span>
          <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
            {vox.map((v) => Math.round(v)).join(", ")}
          </span>
        </div>
      )}
      {visibleValues.length > 0 && (
        <div className="flex items-center gap-3" data-testid="crosshair-values">
          <Activity size={11} className="text-zinc-500" />
          {visibleValues.map((v, i) => (
            <div key={`${v.name}-${i}`} className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
                {v.name}
              </span>
              <span
                className="font-mono text-[11px] text-white px-1.5 py-0.5 border border-[#27272A] bg-[#111111] tabular-nums"
                data-testid={`crosshair-val-${v.name}`}
              >
                {fmt(v.value)}
              </span>
            </div>
          ))}
        </div>
      )}
      {eloquent && eloquent.eloquent && eloquent.distanceMM <= 5 && (
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 border ${
            eloquent.distanceMM === 0
              ? "border-[#FF3B30] text-[#FF6B60] bg-[#2a0e0c]"
              : "border-amber-600 text-amber-400 bg-[#2a1f08]"
          }`}
          data-testid="crosshair-eloquent"
          title={`Eloquent structure: ${eloquent.name}`}
        >
          <AlertTriangle size={11} />
          <span className="font-mono text-[10px] tracking-[0.1em] truncate max-w-[260px]">
            {eloquent.distanceMM === 0 ? "IN" : `≈${eloquent.distanceMM} mm to`} {eloquent.name}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 basis-full w-full" data-testid="crosshair-labels">
        {labelEntries.length > 0 ? (
          labelEntries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500 flex-shrink-0">
                {k}
              </span>
              <span
                className="font-mono text-[11px] text-white px-1.5 py-0.5 border border-[#27272A] bg-[#111111] truncate max-w-[280px]"
                title={v}
              >
                {v}
              </span>
            </div>
          ))
        ) : (
          <span className="invisible font-mono text-[11px] px-1.5 py-0.5">·</span>
        )}
      </div>
    </div>
  );
};

export default CrosshairInfo;
