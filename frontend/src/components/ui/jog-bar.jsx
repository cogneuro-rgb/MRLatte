import React, { useEffect, useRef, useState } from "react";

// A "jog" control, in place of a slider, for nudging a value that has no
// natural end (a position, an angle). The middle is still. Press and hold
// anywhere on the bar and the value keeps moving for as long as you hold:
// the further from the middle, the faster, and moving the pointer while
// holding changes the speed. Releasing stops it. Hovering shows the speed a
// press would give. Arrow keys still step by `step`.
//
// While held, `onLive(value)` is called every frame (preview); on release
// `onCommit(value)` is called once (the moment to save anything expensive).
// `wrap(value)`, if given, replaces the min/max stop (angles: keep going round).

const DEAD_ZONE = 0.07;        // fraction of the half-width around the middle that does nothing
// Speed rises exponentially from the middle: slow and fine over most of the
// bar, very fast only near the ends. With K = 5: a quarter of the way out
// gives ~2 % of top speed, halfway ~8 %, three quarters ~28 %.
const K = 5;

export function jogSpeed(frac, maxSpeed) {
  const a = Math.abs(frac);
  if (a <= DEAD_ZONE) return 0;
  const t = Math.min(1, (a - DEAD_ZONE) / (1 - DEAD_ZONE));
  return Math.sign(frac) * maxSpeed * Math.expm1(K * t) / Math.expm1(K);
}

const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

export function JogBar({
  value, maxSpeed, unit = "", min = -Infinity, max = Infinity, step = 1, wrap,
  onLive, onCommit, title, className = "", testId,
}) {
  const settle = (v) => (wrap ? wrap(v) : Math.max(min, Math.min(max, v)));
  const barRef = useRef(null);
  const held = useRef(null);            // { frac, value, last, raf } while pressed
  const [hoverFrac, setHoverFrac] = useState(null);
  const [heldFrac, setHeldFrac] = useState(null);

  const fracAt = (clientX) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.max(-1, Math.min(1, ((clientX - r.left) / r.width) * 2 - 1));
  };

  const tick = (now) => {
    const h = held.current;
    if (!h) return;
    const dt = Math.min(0.1, (now - h.last) / 1000);   // a stalled frame must not jump
    h.last = now;
    const v = settle(h.value + jogSpeed(h.frac, maxSpeed) * dt);
    if (v !== h.value) {
      h.value = v;
      h.moved = true;
      onLive?.(Math.round(v * 100) / 100);
    }
    h.raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    const h = held.current;
    if (!h) return;
    cancelAnimationFrame(h.raf);
    held.current = null;
    setHeldFrac(null);
    if (h.moved) onCommit?.(Math.round(h.value * 100) / 100);
  };

  useEffect(() => () => { if (held.current) cancelAnimationFrame(held.current.raf); }, []);

  const shownFrac = heldFrac ?? hoverFrac;
  const shownSpeed = shownFrac == null ? null : jogSpeed(shownFrac, maxSpeed);

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-valuenow={value}
      aria-valuetext={`${fmt(value)} ${unit}`.trim()}
      title={title}
      data-testid={testId}
      className={`relative h-4 cursor-ew-resize select-none touch-none rounded-sm border border-border bg-background focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
        const frac = fracAt(e.clientX);
        held.current = { frac, value: Number(value) || 0, last: performance.now(), raf: 0, moved: false };
        setHeldFrac(frac);
        held.current.raf = requestAnimationFrame(tick);
      }}
      onPointerMove={(e) => {
        const frac = fracAt(e.clientX);
        if (held.current) { held.current.frac = frac; setHeldFrac(frac); } else setHoverFrac(frac);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onPointerLeave={() => { if (!held.current) setHoverFrac(null); }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const d = (e.key === "ArrowRight" ? step : -step) * (e.shiftKey ? 10 : 1);
        onCommit?.(settle(Math.round(((Number(value) || 0) + d) * 100) / 100));
      }}
    >
      {/* speed shading: darker towards the ends, the middle is still */}
      <div className="absolute inset-0 rounded-sm opacity-60"
        style={{ background: "linear-gradient(90deg, hsl(var(--muted-foreground) / .45), transparent 47%, transparent 53%, hsl(var(--muted-foreground) / .45))" }} />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-muted-foreground/70" />
      {shownFrac != null && (
        <div
          className={`absolute top-0 bottom-0 w-0.5 ${heldFrac != null ? "bg-amber-500" : "bg-foreground/60"}`}
          style={{ left: `${((shownFrac + 1) / 2) * 100}%` }}
        />
      )}
      {shownSpeed != null && (
        <div className="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-muted-foreground"
          data-testid={testId ? `${testId}-speed` : undefined}>
          {shownSpeed === 0 ? "still" : `${shownSpeed > 0 ? "+" : "−"}${fmt(Math.abs(shownSpeed))} ${unit}/s`}
        </div>
      )}
    </div>
  );
}

export default JogBar;
