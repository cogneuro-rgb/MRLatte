// Build an SVG path string for a donut-wedge (annular sector).
//
// Angles are in degrees, measured clockwise from 12 o'clock so they line up
// with the polar-angle conic-gradient (`from 0deg, …`) used by PolarAngleDisc:
//
//   0°   = top
//   90°  = right
//   180° = bottom
//   270° = left

function polarToXY(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

export function donutArcPath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  // Guard against zero-width or wrap-crossing input. Callers should split
  // wrap ranges into two non-wrapping segments before calling.
  const span = endDeg - startDeg;
  if (span <= 0) return "";
  const sweepSpan = Math.min(span, 359.999);
  const eDeg = startDeg + sweepSpan;
  const largeArc = sweepSpan > 180 ? 1 : 0;

  const [ox1, oy1] = polarToXY(cx, cy, rOuter, startDeg);
  const [ox2, oy2] = polarToXY(cx, cy, rOuter, eDeg);
  const [ix2, iy2] = polarToXY(cx, cy, rInner, eDeg);
  const [ix1, iy1] = polarToXY(cx, cy, rInner, startDeg);

  return [
    `M ${ox1.toFixed(3)} ${oy1.toFixed(3)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${ox2.toFixed(3)} ${oy2.toFixed(3)}`,
    `L ${ix2.toFixed(3)} ${iy2.toFixed(3)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${ix1.toFixed(3)} ${iy1.toFixed(3)}`,
    "Z",
  ].join(" ");
}
