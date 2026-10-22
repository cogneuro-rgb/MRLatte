import React, { useEffect, useState } from "react";
import { JogBar } from "@/components/ui/jog-bar";
import { IDENTITY_TRANSFORM, TRANSFORM_LIMITS, isIdentityTransform, normalizeTransform, wrapAngle } from "@/lib/overlayTransform";

// Top speed of each jog bar, reached only at its very end (the speed curve is
// in jog-bar.jsx); the number box beside each one sets an exact value. Turns
// have no limit: they wrap round (wrapAngle), so holding keeps turning.
const SPEED = { move: 100, turn: 180, size: 200 };     // mm/s, degrees/s, %/s
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

// One number box. Keeps its own text while focused so half-typed values ("-",
// "1.") aren't clobbered; commits on Enter, blur, or an arrow-key step.
const NumberBox = ({ value, step, min, max, wrap, onCommit, testId }) => {
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
      className="w-12 shrink-0 bg-background border border-border text-foreground font-mono text-[10px] px-1 py-0.5 text-right tabular-nums focus:outline-none focus:border-muted-foreground"
      data-testid={testId}
    />
  );
};

// label · jog bar · number box. Holding the bar moves the volume live and
// commits on release; the box commits at once.
const Row = ({ label, title, value, step, speed, unit, min, max, wrap, onLive, onCommit, testId }) => (
  <div className="flex items-center gap-2 pt-1.5" title={title}>
    <span className="font-mono text-[9px] uppercase text-muted-foreground w-3 shrink-0">{label}</span>
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
      testId={`${testId}-jog`}
    />
    <NumberBox value={value} step={step} min={min} max={max} wrap={wrap} onCommit={onCommit} testId={testId} />
  </div>
);

const AXES = [
  { key: "x", move: "Left (−) / right (+), in mm", turn: "Tilt forward / back: turn about the left–right axis, in degrees" },
  { key: "y", move: "Back (−) / front (+), in mm", turn: "Tilt sideways: turn about the front–back axis, in degrees" },
  { key: "z", move: "Down (−) / up (+), in mm", turn: "Turn within the axial plane: about the up–down axis, in degrees" },
];

const Heading = ({ children }) => (
  <div className="font-mono text-[9px] text-muted-foreground pt-0.5">{children}</div>
);

/**
 * Move / rotate / scale controls for one volume (an overlay or the base).
 * `transform` is absolute (from the volume as loaded); undefined = untouched.
 * `onChange(layerId, transform, { live })` receives the full new transform;
 * `live: true` means a slider is still being dragged.
 */
export const OverlayTransformControls = ({ layerId, transform, onChange }) => {
  const t = normalizeTransform(transform || IDENTITY_TRANSFORM);
  const adjusted = !isIdentityTransform(t);
  const L = TRANSFORM_LIMITS;
  const emit = (patch, live) => onChange(layerId, { ...t, ...patch }, live ? { live: true } : undefined);
  const at = (field, i, v) => ({ [field]: t[field].map((old, j) => (j === i ? v : old)) });

  return (
    <div className="space-y-1" data-testid={`transform-block-${layerId}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">position</span>
          {adjusted && (
            <span
              className="font-mono text-[8px] uppercase tracking-[0.15em] text-amber-500 border border-amber-500/50 px-1 py-0.5"
              title="Moved by hand. Analyses, downloads and saved workspaces use the adjusted position."
              data-testid={`transform-adjusted-${layerId}`}
            >
              adjusted
            </span>
          )}
        </div>
        <button
          onClick={() => onChange(layerId, IDENTITY_TRANSFORM)}
          disabled={!adjusted}
          className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1 py-0.5 transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground"
          title="Put it back where its file says it is"
          data-testid={`transform-reset-${layerId}`}
        >
          reset
        </button>
      </div>

      <Heading>move (mm)</Heading>
      {AXES.map((a, i) => (
        <Row key={`m${a.key}`} label={a.key} title={a.move} value={t.translation[i]} step={0.5}
          speed={SPEED.move} unit="mm" min={-L.translation} max={L.translation}
          onLive={(v) => emit(at("translation", i, v), true)} onCommit={(v) => emit(at("translation", i, v))}
          testId={`transform-move-${a.key}-${layerId}`} />
      ))}
      <Heading>turn (°)</Heading>
      {AXES.map((a, i) => (
        <Row key={`r${a.key}`} label={a.key} title={a.turn} value={t.rotation[i]} step={0.5}
          speed={SPEED.turn} unit="°" wrap={wrapAngle}
          onLive={(v) => emit(at("rotation", i, v), true)} onCommit={(v) => emit(at("rotation", i, v))}
          testId={`transform-turn-${a.key}-${layerId}`} />
      ))}
      <Heading>size (%)</Heading>
      <Row label="" title="Size as a percentage of the original. Grows or shrinks about the volume's own centre."
        value={round2(t.scale * 100)} step={1}
        speed={SPEED.size} unit="%" min={L.scaleMin * 100} max={L.scaleMax * 100}
        onLive={(v) => emit({ scale: v / 100 }, true)} onCommit={(v) => emit({ scale: v / 100 })}
        testId={`transform-size-${layerId}`} />
    </div>
  );
};

export default OverlayTransformControls;
