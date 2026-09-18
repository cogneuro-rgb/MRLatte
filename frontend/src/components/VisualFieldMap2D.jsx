import React, { useState, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { donutArcPath } from "@/lib/svgArc";
import { Slider } from "@/components/ui/slider";
import { ThresholdFooter } from "./PolarAngleDisc";

// Polar-angle-360 color stops at evenly-spaced angles (matching COLORMAP_STOPS in PolarAngleDisc).
const PA_STOPS = [
  { a: 0,   r: 255, g: 0,   b: 0   },
  { a: 45,  r: 255, g: 165, b: 0   },
  { a: 90,  r: 255, g: 255, b: 0   },
  { a: 135, r: 60,  g: 220, b: 60  },
  { a: 180, r: 0,   g: 0,   b: 255 },
  { a: 225, r: 0,   g: 180, b: 200 },
  { a: 270, r: 0,   g: 255, b: 255 },
  { a: 315, r: 200, g: 100, b: 255 },
  { a: 360, r: 255, g: 0,   b: 0   },
];

function interpolatePA(angleDeg) {
  const a = ((angleDeg % 360) + 360) % 360;
  let i = PA_STOPS.findIndex((s) => s.a > a) - 1;
  if (i < 0) i = 0;
  if (i >= PA_STOPS.length - 1) i = PA_STOPS.length - 2;
  const s0 = PA_STOPS[i];
  const s1 = PA_STOPS[i + 1];
  const t = (a - s0.a) / (s1.a - s0.a);
  const r = Math.round(s0.r + t * (s1.r - s0.r));
  const g = Math.round(s0.g + t * (s1.g - s0.g));
  const b = Math.round(s0.b + t * (s1.b - s0.b));
  return `rgb(${r},${g},${b})`;
}

// SVG path for a pie-slice (center → arc → back to center).
// Angles: 0° = top, clockwise (same convention as donutArcPath / PolarAngleDisc).
function polarToXY(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function pieSlicePath(cx, cy, r, startDeg, endDeg) {
  const span = Math.min(endDeg - startDeg, 359.999);
  const eDeg = startDeg + span;
  const largeArc = span > 180 ? 1 : 0;
  const [x1, y1] = polarToXY(cx, cy, r, startDeg);
  const [x2, y2] = polarToXY(cx, cy, r, eDeg);
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

const CX = 135;
const CY = 150;
const DISC_R = 108;
const SVG_W = 270;
const SVG_H = 300;

// Pre-compute background wedge colors (one per angle bin at 5° resolution).
const BG_COLORS_72 = Array.from({ length: 72 }, (_, ai) =>
  interpolatePA(ai * 5 + 2.5)
);

// ── Shared rasterization ────────────────────────────────────────────────────
// Rasterize an SVG markup string onto a white canvas at 3× scale. Returns the
// canvas (or null). Both the download and the data-URL paths build on this so
// they always produce identical pixels. Per the CLAUDE.md blob-URL rule, every
// createObjectURL is revoked in a try/finally.
function rasterizeVfMapSvgToCanvas(svgString) {
  return new Promise((resolve) => {
    if (!svgString) { resolve(null); return; }
    const scale = 3; // upscale for a crisp raster
    const W = SVG_W * scale;
    const H = SVG_H * scale;
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      let canvas = null;
      try {
        canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(svgUrl); resolve(null); };
    img.src = svgUrl;
  });
}

async function rasterizeVfMapSvg(svgString) {
  const canvas = await rasterizeVfMapSvgToCanvas(svgString);
  return canvas ? canvas.toDataURL("image/png") : null;
}

function serializeSvg(svgEl) {
  return svgEl ? new XMLSerializer().serializeToString(svgEl) : null;
}

// Serialize the live rose-plot SVG, rasterize it onto a white canvas, and
// trigger a PNG download. Mirrors the white-background export of the Classic
// view (exportPolarAngleDiscPng in PolarAngleDisc.jsx).
async function exportVisualFieldMap2DPng(svgEl, baseLabel) {
  const canvas = await rasterizeVfMapSvgToCanvas(serializeSvg(svgEl));
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(baseLabel || "cortical_retinotopy").replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.png`;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, "image/png");
}

// Data-URL from a live, mounted SVG element (exact Export-PNG pixels, including
// the user's current max-ecc / threshold).
export function visualFieldMap2DToDataURL(svgEl) {
  return rasterizeVfMapSvg(serializeSvg(svgEl));
}

// Data-URL built purely from params — no mounted component required. Used when
// the retinotopy panel is collapsed (its SVG ref is unmounted) so the One-Click
// Summary / HTML report can still embed the 2D map. Renders the same
// VisualFieldMap2DSvg used on screen via renderToStaticMarkup.
export function visualFieldMap2DDataURL(params) {
  const svgString = renderToStaticMarkup(<VisualFieldMap2DSvg {...params} />);
  return rasterizeVfMapSvg(svgString);
}

// ── Pure SVG (the raster/export source of truth) ────────────────────────────
// Renders ONLY the polar-plot <svg>. Kept free of internal state so it can be
// rendered both on screen (via the interactive VisualFieldMap2D) and off-DOM
// (via renderToStaticMarkup in visualFieldMap2DDataURL). The "Total / within"
// stats bar lives in the interactive wrapper, NOT here — matching Export PNG.
function VisualFieldMap2DSvg({
  gridResult,
  active = false,
  selectedCount = 0,
  thresholdMode,
  thresholdMin,
  maxEcc = 30,
  svgRef = null,
}) {
  const { grid, nAngle = 72, nEcc = 90, angleBinSize = 5 } = gridResult || {};

  const pixPerDeg = DISC_R / maxEcc;
  const maxEccBins = Math.min(maxEcc, nEcc);

  // Collect (ai, ei) pairs with counts above the threshold within the current
  // maxEcc. "min" mode requires per-cell count >= thresholdMin; otherwise any
  // nonzero cell counts ("any overlap").
  const minVoxels = thresholdMode === "min" ? Math.max(1, thresholdMin | 0) : 1;
  const deficitCells = useMemo(() => {
    if (!grid || !active || selectedCount === 0) return [];
    const cells = [];
    for (let ai = 0; ai < nAngle; ai++) {
      for (let ei = 0; ei < maxEccBins; ei++) {
        if (grid[ai * nEcc + ei] >= minVoxels) cells.push(ai * 1000 + ei);
      }
    }
    return cells;
  }, [grid, nAngle, nEcc, maxEccBins, active, selectedCount, minVoxels]);

  const dimClass = active ? "" : "opacity-30";

  // Eccentricity ring steps (every 5° up to maxEcc)
  const ringSteps = useMemo(() => {
    const steps = [];
    for (let e = 5; e <= maxEcc; e += 5) steps.push(e);
    return steps;
  }, [maxEcc]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className={`w-full ${dimClass}`}
      style={{ maxHeight: 300 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* White background */}
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="#ffffff" />

      {/* Background: 72 pie-slice wedges */}
      {BG_COLORS_72.map((color, ai) => (
        <path
          key={ai}
          d={pieSlicePath(CX, CY, DISC_R, ai * angleBinSize, (ai + 1) * angleBinSize)}
          fill={color}
          opacity={0.9}
        />
      ))}

      {/* Deficit cells: black annular wedges */}
      {deficitCells.map((packed) => {
        const ai = Math.floor(packed / 1000);
        const ei = packed % 1000;
        const rInner = ei * pixPerDeg;
        const rOuter = Math.min((ei + 1) * pixPerDeg, DISC_R);
        return (
          <path
            key={packed}
            d={donutArcPath(
              CX, CY, rOuter, rInner,
              ai * angleBinSize, (ai + 1) * angleBinSize
            )}
            fill="black"
            opacity={0.88}
          />
        );
      })}

      {/* Eccentricity rings */}
      {ringSteps.map((e) => {
        const r = e * pixPerDeg;
        // Label angle: 30° from top (matching Python script)
        const [lx, ly] = polarToXY(CX, CY, r, 30);
        return (
          <g key={e}>
            <circle
              cx={CX} cy={CY} r={r}
              fill="none" stroke="#555555" strokeWidth={0.7} opacity={0.55}
            />
            <text
              x={lx} y={ly - 2}
              fill="#333333" fontSize={6.5} textAnchor="middle" dominantBaseline="auto"
              style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "round" }}
            >
              {e}°
            </text>
          </g>
        );
      })}

      {/* Cardinal direction labels */}
      {/* 0° / Upper VM — top */}
      <text x={CX} y={CY - DISC_R - 14} fill="#222222" fontSize={8} textAnchor="middle" fontWeight="bold">0°</text>
      <text x={CX} y={CY - DISC_R - 6}  fill="#555555" fontSize={6.5} textAnchor="middle">Upper VM</text>
      {/* 90° / Right HM — right */}
      <text x={CX + DISC_R + 6}  y={CY - 4} fill="#222222" fontSize={8} textAnchor="start" fontWeight="bold">90°</text>
      <text x={CX + DISC_R + 6}  y={CY + 5} fill="#555555" fontSize={6.5} textAnchor="start">Right HM</text>
      {/* 180° / Lower VM — bottom */}
      <text x={CX} y={CY + DISC_R + 10} fill="#222222" fontSize={8} textAnchor="middle" fontWeight="bold">180°</text>
      <text x={CX} y={CY + DISC_R + 18} fill="#555555" fontSize={6.5} textAnchor="middle">Lower VM</text>
      {/* 270° / Left HM — left */}
      <text x={CX - DISC_R - 6}  y={CY - 4} fill="#222222" fontSize={8} textAnchor="end" fontWeight="bold">270°</text>
      <text x={CX - DISC_R - 6}  y={CY + 5} fill="#555555" fontSize={6.5} textAnchor="end">Left HM</text>

      {/* Diagonal tick labels */}
      {[45, 135, 225, 315].map((deg) => {
        const [tx, ty] = polarToXY(CX, CY, DISC_R + 10, deg);
        return (
          <text key={deg} x={tx} y={ty} fill="#666666" fontSize={6.5}
            textAnchor={deg < 180 ? "start" : "end"} dominantBaseline="middle">
            {deg}°
          </text>
        );
      })}

      {/* Hemifield labels */}
      {(() => {
        const [rx, ry] = polarToXY(CX, CY, DISC_R * 1.38, 90);
        const [lx2, ly2] = polarToXY(CX, CY, DISC_R * 1.38, 270);
        return (
          <>
            <text x={rx} y={ry} fill="#d35400" fontSize={8} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">RIGHT VF</text>
            <text x={lx2} y={ly2} fill="#2266cc" fontSize={8} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">LEFT VF</text>
          </>
        );
      })()}

      {/* Miniature color wheel — bottom left */}
      <g transform="translate(18,268)">
        {BG_COLORS_72.map((color, ai) => (
          <path
            key={ai}
            d={pieSlicePath(0, 0, 16, ai * angleBinSize, (ai + 1) * angleBinSize)}
            fill={color}
            opacity={0.9}
          />
        ))}
        <text x={0}   y={-19} fill="#555555" fontSize={5} textAnchor="middle">0</text>
        <text x={0}   y={-19} fill="#555555" fontSize={4} textAnchor="middle" dy={5}>UVM</text>
        <text x={19}  y={2}   fill="#555555" fontSize={4} textAnchor="start"  dominantBaseline="middle">90</text>
        <text x={19}  y={6}   fill="#555555" fontSize={3.5} textAnchor="start">RHM</text>
        <text x={0}   y={21}  fill="#555555" fontSize={4} textAnchor="middle">180</text>
        <text x={0}   y={25}  fill="#555555" fontSize={3.5} textAnchor="middle">LVM</text>
        <text x={-19} y={2}   fill="#555555" fontSize={4} textAnchor="end"    dominantBaseline="middle">270</text>
        <text x={-19} y={6}   fill="#555555" fontSize={3.5} textAnchor="end">LHM</text>
        <text x={0}   y={-26} fill="#444444" fontSize={4.5} textAnchor="middle" fontWeight="bold">Polar</text>
        <text x={0}   y={-22} fill="#444444" fontSize={4} textAnchor="middle">angle</text>
      </g>

      {/* Legend — bottom right */}
      <rect x={SVG_W - 110} y={SVG_H - 18} width={8} height={8} fill="black" opacity={0.88} />
      <text x={SVG_W - 99} y={SVG_H - 12} fill="#555555" fontSize={7} dominantBaseline="middle">
        Predicted VF deficit
      </text>
    </svg>
  );
}

export const VisualFieldMap2D = forwardRef(function VisualFieldMap2D({
  gridResult,
  active = false,
  selectedCount = 0,
  label = "",
  summaryText,
  thresholdMode,
  thresholdMin,
  onThresholdModeChange,
  onThresholdMinChange,
  baseLabel = "",
}, ref) {
  const [maxEcc, setMaxEcc] = useState(30);
  const svgRef = useRef(null);
  useImperativeHandle(ref, () => ({ getSvgEl: () => svgRef.current }));

  const { grid, nAngle = 72, nEcc = 90 } = gridResult || {};

  const maxEccBins = Math.min(maxEcc, nEcc);

  const totalVx = useMemo(() => {
    if (!grid) return 0;
    let s = 0;
    for (let i = 0; i < grid.length; i++) s += grid[i];
    return s;
  }, [grid]);

  const withinVx = useMemo(() => {
    if (!grid) return 0;
    let s = 0;
    for (let ai = 0; ai < nAngle; ai++) {
      for (let ei = 0; ei < maxEccBins; ei++) s += grid[ai * nEcc + ei];
    }
    return s;
  }, [grid, nAngle, nEcc, maxEccBins]);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Stats bar */}
      {active && selectedCount > 0 && (
        <div className="font-mono text-[9px] text-muted-foreground text-center leading-tight">
          Total: {totalVx.toLocaleString()} vx&nbsp;&nbsp;|&nbsp;&nbsp;within {maxEcc}°:{" "}
          {withinVx.toLocaleString()} vx
        </div>
      )}
      {(!active || selectedCount === 0) && (
        <div className="font-mono text-[9px] text-subtle text-center">
          select a lesion to see VF deficit
        </div>
      )}

      {/* Polar plot SVG (pure, shared with the export/summary raster) */}
      <VisualFieldMap2DSvg
        gridResult={gridResult}
        active={active}
        selectedCount={selectedCount}
        thresholdMode={thresholdMode}
        thresholdMin={thresholdMin}
        maxEcc={maxEcc}
        svgRef={svgRef}
      />

      {/* Max-eccentricity slider */}
      <div className="flex items-center gap-2 px-1">
        <span className="font-mono text-[9px] text-subtle uppercase tracking-[0.15em] shrink-0">max ecc</span>
        <Slider
          value={[maxEcc]}
          min={5}
          max={90}
          step={5}
          onValueChange={(v) => setMaxEcc(v[0])}
          className="cursor-pointer flex-1"
        />
        <span className="font-mono text-[9px] text-muted-foreground tabular-nums w-6 text-right">{maxEcc}°</span>
      </div>

      {/* Threshold control (Any overlap / Min voxels) + affected-ranges summary */}
      <ThresholdFooter
        thresholdMode={thresholdMode}
        thresholdMin={thresholdMin}
        onThresholdModeChange={onThresholdModeChange}
        onThresholdMinChange={onThresholdMinChange}
        summaryText={summaryText}
        testIdPrefix="vfmap"
      />

      {/* Export PNG (white background) */}
      <div className="flex justify-center pt-1">
        <button
          type="button"
          className="py-1 px-2 text-[9px] uppercase tracking-[0.15em] border transition-colors bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
          onClick={() => exportVisualFieldMap2DPng(svgRef.current, baseLabel || label)}
          data-testid="vfmap-export-btn"
        >
          Export PNG
        </button>
      </div>
    </div>
  );
});
