import React, { useRef, useCallback } from "react";

/**
 * Compact line chart: voxel intensity vs. frame, for the 4D frame stepper's
 * graph toggle. Hand-rolled SVG (matches ColorBarStack's own gradient bars —
 * no charting dependency for a single polyline). Click/drag scrubs the frame,
 * same effect as dragging FrameStepper's slider.
 *
 * Colors are fixed (not theme tokens), matching every other canvas overlay
 * here — this sits on NiiVue's always-dark canvas regardless of app theme.
 */
export default function TimeseriesGraph({ values, frame, nFrames, onScrub, width = 280, height = 90 }) {
  const svgRef = useRef(null);

  const scrubAt = useCallback((clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !(nFrames > 1)) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onScrub(Math.round(frac * (nFrames - 1)));
  }, [nFrames, onScrub]);

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  };
  const handlePointerMove = (e) => {
    if (e.buttons !== 1) return; // only while the primary button is held
    scrubAt(e.clientX);
  };

  if (!values || values.length < 2) return null;

  const padY = 8;
  const plotH = height - padY * 2;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;

  let points = "";
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * width;
    const y = padY + plotH - ((values[i] - min) / range) * plotH;
    points += `${x.toFixed(1)},${y.toFixed(1)} `;
  }

  const frameX = nFrames > 1 ? (frame / (nFrames - 1)) * width : 0;

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className="block cursor-crosshair touch-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      data-testid="timeseries-graph"
    >
      <polyline points={points} fill="none" stroke="#e4e4e7" strokeWidth="1.25" />
      <line x1={frameX} x2={frameX} y1={0} y2={height} stroke="#f87171" strokeWidth="1" />
      <text x={4} y={11} fontSize="9" fill="#a1a1aa" fontFamily="monospace">{max.toFixed(1)}</text>
      <text x={4} y={height - 3} fontSize="9" fill="#a1a1aa" fontFamily="monospace">{min.toFixed(1)}</text>
    </svg>
  );
}
