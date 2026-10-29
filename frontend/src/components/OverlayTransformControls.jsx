import React, { createContext, useContext, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { JogBar } from "@/components/ui/jog-bar";
import { Disclosure } from "@/components/ui/disclosure";
import {
  IDENTITY_TRANSFORM, TRANSFORM_LIMITS, isIdentityTransform, normalizeTransform, wrapAngle,
  repivot, pivotForDisplayedPoint,
} from "@/lib/overlayTransform";

// Supplied by the Dashboard: the viewer (for computing a layer's turn pivot)
// and the crosshair in world mm (the "crosshair" pivot). Without it the block
// still works and turns about the layer's default pivot.
export const TransformPivotContext = createContext(null);

const PIVOT_LABELS = { centre: "Centre", mass: "Mass", crosshair: "Crosshair" };
const PIVOT_TITLES = {
  centre: "Turn and resize about the centre of the visible voxels (the middle of their bounding box)",
  mass: "Turn and resize about the centre of mass of the visible voxels",
  crosshair: "Turn and resize about the crosshair",
};

// Per-layer pivot helpers over the viewer. "drawing" is the Draw panel's
// drawing; "mni152" the base; anything else an overlay id.
function pivotSourceFor(ctx, layerId) {
  const viewer = ctx?.viewerRef?.current;
  if (!viewer) return null;
  const drawing = layerId === "drawing";
  return {
    compute: (mode) => (drawing ? viewer.getDrawingPivot?.(mode) : viewer.getLayerPivot?.(layerId, mode)) || null,
    signature: (mode) => (drawing
      ? viewer.getDrawingPivotSignature?.(mode, ctx.crosshairMM)
      : viewer.getLayerPivotSignature?.(layerId, mode, ctx.crosshairMM)) ?? null,
    // What a transform with no stored pivot turns about.
    fallback: () => (drawing ? viewer.getDrawingPivot?.("centre") : viewer.getLayerGridCentre?.(layerId)) || null,
    crosshair: ctx.crosshairMM,
  };
}

// Top speed of each jog bar, reached only at its very end (the speed curve is
// in jog-bar.jsx); the number box beside each one sets an exact value. Turns
// have no limit: they wrap round (wrapAngle), so holding keeps turning.
const SPEED = { move: 100, turn: 180, size: 200 };     // mm/s, degrees/s, %/s
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

// One number box. Keeps its own text while focused so half-typed values ("-",
// "1.") aren't clobbered; commits on Enter, blur, or an arrow-key step.
const NumberBox = ({ value, step, min, max, wrap, onCommit, testId, "aria-label": ariaLabel }) => {
  const settle = (v) => (wrap ? wrap(v) : clamp(v, min, max));
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = (raw) => {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) onCommit(settle(n));
    else setText(String(value));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={text}
      onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { setFocused(false); commit(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { commit(e.currentTarget.value); e.currentTarget.blur(); }
        else if (e.key === "Escape") { setText(String(value)); e.currentTarget.blur(); }
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const cur = Number.isFinite(parseFloat(text)) ? parseFloat(text) : value;
          const next = settle(round2(cur + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1)));
          setText(String(next));
          onCommit(next);
        }
      }}
      className="h-[22px] w-[50px] shrink-0 rounded-[5px] border border-edge bg-background px-1.5 text-right font-mono text-[11.5px] text-foreground"
      data-testid={testId}
    />
  );
};

// label · [end letter] jog bar [end letter] · number box · reset. Holding the
// bar moves the volume live and commits on release; the box commits at once.
// `ends` names the two directions for the move bars (e.g. ["L", "R"]).
// `name` ("Move x") is what a screen reader calls the bar and the box; the visible
// `label` is only the axis letter.
const Row = ({ label, name, title, value, step, speed, unit, min, max, wrap, ends, resetTo, onLive, onCommit, testId }) => (
  <div className="flex items-center gap-1.5 pt-1.5" title={title}>
    <span className="cap w-3 shrink-0 text-subtle">{label}</span>
    <span className="w-2.5 shrink-0 text-center text-[11px] text-subtle" data-testid={ends ? `${testId}-end-neg` : undefined}>{ends?.[0] || ""}</span>
    <JogBar
      value={value}
      maxSpeed={speed}
      unit={unit}
      min={min}
      max={max}
      wrap={wrap}
      step={step}
      onLive={onLive}
      onCommit={onCommit}
      title={`${title}. Press and hold: the further from the middle, the faster.`}
      className="flex-1"
      aria-label={name}
      testId={`${testId}-jog`}
    />
    <span className="w-2.5 shrink-0 text-center text-[11px] text-subtle" data-testid={ends ? `${testId}-end-pos` : undefined}>{ends?.[1] || ""}</span>
    <NumberBox value={value} step={step} min={min} max={max} wrap={wrap} onCommit={onCommit} testId={testId}
      aria-label={`${name}, ${unit === "°" ? "degrees" : unit}`} />
    <button
      type="button"
      onClick={() => onCommit(resetTo)}
      disabled={value === resetTo}
      className="icon-btn h-[22px] w-[22px] shrink-0 disabled:opacity-30"
      title={`Reset to ${resetTo}`}
      data-testid={`${testId}-reset`}
    >
      <RotateCcw size={11} />
    </button>
  </div>
);

// `ends`: the anatomical direction at each end of a move bar (RAS: +x right,
// +y anterior, +z superior).
const AXES = [
  { key: "x", ends: ["L", "R"], move: "Left (−) / right (+), in mm", turn: "Tilt forward / back: turn about the left–right axis, in degrees" },
  { key: "y", ends: ["P", "A"], move: "Back (−) / front (+), in mm", turn: "Tilt sideways: turn about the front–back axis, in degrees" },
  { key: "z", ends: ["I", "S"], move: "Down (−) / up (+), in mm", turn: "Turn within the axial plane: about the up–down axis, in degrees" },
];

const Heading = ({ children }) => (
  <div className="pt-1 text-[13px] text-muted-foreground">{children}</div>
);

/**
 * Move / rotate / scale controls for one volume (an overlay or the base).
 * `transform` is absolute (from the volume as loaded); undefined = untouched.
 * `onChange(layerId, transform, { live })` receives the full new transform;
 * `live: true` means a slider is still being dragged.
 * Folded by default (sidebar declutter): the row still says whether the layer
 * was moved, and Reset works from it. `untouchedLabel` is that row's word for
 * "not moved" ("as in the file"; the drawing says "as drawn").
 */
export const OverlayTransformControls = ({ layerId, transform, onChange, untouchedLabel = "as in the file" }) => {
  const t = normalizeTransform(transform || IDENTITY_TRANSFORM);
  const adjusted = !isIdentityTransform(t);
  const L = TRANSFORM_LIMITS;
  const src = pivotSourceFor(useContext(TransformPivotContext), layerId);
  const mode = t.pivotMode || "centre";

  // Where `mode` puts the pivot now, in the layer's own frame (null if it can't).
  const pivotFor = (m, from) => {
    if (!src) return null;
    if (m === "crosshair") return src.crosshair ? pivotForDisplayedPoint(t, src.crosshair, from) : null;
    return src.compute(m);
  };
  // `t` turning about `mode`'s current pivot, same pose (repivot keeps it).
  const withPivot = (base, m) => {
    const from = base.pivot || src?.fallback();
    const p = from ? pivotFor(m, from) : null;
    if (!p) return base;
    return repivot(base, p, from, { pivotMode: m, pivotSig: src.signature(m) });
  };
  const currentSig = src ? src.signature(mode) : null;
  const stale = !!src && adjusted && (!t.pivot || (currentSig != null && t.pivotSig !== currentSig));

  // Every change carries a pivot: the first one picks up the default (centre).
  const emit = (patch, live) => {
    const base = !t.pivot && src ? withPivot(t, mode) : t;
    onChange(layerId, { ...base, ...patch }, live ? { live: true } : undefined);
  };
  const choosePivot = (m) => onChange(layerId, withPivot(t, m));
  const at = (field, i, v) => ({ [field]: t[field].map((old, j) => (j === i ? v : old)) });

  return (
    <Disclosure
      testId={`transform-block-${layerId}`}
      className="border-t border-border"
      bodyClassName="space-y-1"
      title="Position"
      status={adjusted ? (
        <span
          className="font-mono text-[11px] text-warn"
          title="Moved by hand. Analyses, downloads and saved workspaces use the adjusted position."
          data-testid={`transform-adjusted-${layerId}`}
        >
          moved by hand
        </span>
      ) : (
        <span className="text-[12px] text-subtle">{untouchedLabel}</span>
      )}
      action={(
        <button
          onClick={() => onChange(layerId, IDENTITY_TRANSFORM)}
          disabled={!adjusted}
          className="btn-mini"
          title="Put it back where its file says it is"
          data-testid={`transform-reset-${layerId}`}
        >
          Reset
        </button>
      )}
    >
      <Heading>Move (mm)</Heading>
      {AXES.map((a, i) => (
        <Row key={`m${a.key}`} label={a.key} name={`Move ${a.key}`} title={a.move} value={t.translation[i]} step={0.5}
          speed={SPEED.move} unit="mm" min={-L.translation} max={L.translation} ends={a.ends} resetTo={0}
          onLive={(v) => emit(at("translation", i, v), true)} onCommit={(v) => emit(at("translation", i, v))}
          testId={`transform-move-${a.key}-${layerId}`} />
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="flex-1 text-[13px] text-muted-foreground">Turn (°){src ? " about" : ""}</span>
        {src && (
          <>
            <div className="seg" role="group" aria-label="Turn about" data-testid={`transform-pivot-mode-${layerId}`}>
              {Object.keys(PIVOT_LABELS).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => choosePivot(m)}
                  title={PIVOT_TITLES[m]}
                  data-testid={`transform-pivot-mode-${layerId}-${m}`}
                >
                  {PIVOT_LABELS[m]}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => choosePivot(mode)}
              className={`btn-mini ${stale ? "!border-warn !text-warn" : ""}`}
              title={stale
                ? (mode === "crosshair"
                  ? "Out of date: the crosshair has moved. Click to turn about where it is now (the layer stays put)."
                  : "Out of date: the visibility window has changed. Click to recompute the pivot (the layer stays put).")
                : "Recompute the pivot (the layer stays put)"}
              data-stale={stale || undefined}
              data-testid={`transform-pivot-update-${layerId}`}
            >
              Update
            </button>
          </>
        )}
      </div>
      {AXES.map((a, i) => (
        <Row key={`r${a.key}`} label={a.key} name={`Turn ${a.key}`} title={a.turn} value={t.rotation[i]} step={0.5}
          speed={SPEED.turn} unit="°" wrap={wrapAngle} resetTo={0}
          onLive={(v) => emit(at("rotation", i, v), true)} onCommit={(v) => emit(at("rotation", i, v))}
          testId={`transform-turn-${a.key}-${layerId}`} />
      ))}
      <Heading>Size (%)</Heading>
      <Row label="" name="Size" title="Size as a percentage of the original. Grows or shrinks about the volume's own centre."
        value={round2(t.scale * 100)} step={1}
        speed={SPEED.size} unit="%" min={L.scaleMin * 100} max={L.scaleMax * 100} resetTo={100}
        onLive={(v) => emit({ scale: v / 100 }, true)} onCommit={(v) => emit({ scale: v / 100 })}
        testId={`transform-size-${layerId}`} />
      <p className="pt-1.5 text-[12px] leading-4 text-subtle">
        Hold a bar to move; further from the middle is faster. Analyses, downloads and saved workspaces use the adjusted position.
      </p>
    </Disclosure>
  );
};

export default OverlayTransformControls;
