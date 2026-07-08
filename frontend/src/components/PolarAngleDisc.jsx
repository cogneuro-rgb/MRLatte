import React from "react";
import { donutArcPath } from "@/lib/svgArc";

// Curated CSS gradients matching niivue colormap names. Used by PolarAngleDisc.
const COLORMAP_GRADIENTS = {
  // Matches the polar_angle_360 LUT registered in NiivueViewer.jsx —
  // wraps from UVM(red) → RHM(yellow) → LVM(blue) → LHM(cyan) → UVM(red).
  polar_angle_360: "conic-gradient(from 0deg, #ff0000, #ffa500, #ffff00, #3cdc3c, #0000ff, #00b4c8, #00ffff, #c864ff, #ff0000)",
  hsv: "conic-gradient(from 0deg, #ff0000, #ff8000, #ffff00, #80ff00, #00ff00, #00ff80, #00ffff, #0080ff, #0000ff, #8000ff, #ff00ff, #ff0080, #ff0000)",
  jet: "conic-gradient(from 0deg, #00008f, #0000ff, #0080ff, #00ffff, #80ff80, #ffff00, #ff8000, #ff0000, #8f0000, #ff0000, #ff8000, #ffff00, #00008f)",
  turbo: "conic-gradient(from 0deg, #30123b, #4145ab, #4675ed, #38aafe, #1ed0a3, #51e125, #b9eb35, #fdcf36, #fb8e22, #d8410a, #7a0403, #30123b)",
  warm: "conic-gradient(from 0deg, #1a0000, #5c0000, #b30000, #ff4500, #ffa500, #ffff00, #ffffff, #ffff00, #ffa500, #ff4500, #b30000, #5c0000, #1a0000)",
  cool: "conic-gradient(from 0deg, #00ffff, #00bfff, #007fff, #003fff, #0000ff, #4000ff, #8000ff, #bf00ff, #ff00ff, #ff00bf, #ff007f, #ff003f, #00ffff)",
  plasma: "conic-gradient(from 0deg, #0d0887, #5b02a3, #9a179b, #cb4779, #ed7953, #fb9f3a, #fdca26, #f0f921, #fdca26, #fb9f3a, #ed7953, #cb4779, #0d0887)",
  viridis: "conic-gradient(from 0deg, #440154, #482878, #3e4989, #31688e, #26828e, #1f9e89, #35b779, #6ece58, #b5de2b, #fde725, #b5de2b, #6ece58, #440154)",
  inferno: "conic-gradient(from 0deg, #000004, #1b0c41, #4a0c6b, #781c6d, #a52c60, #cf4446, #ed6925, #fb9b06, #f7d13d, #fcffa4, #f7d13d, #fb9b06, #000004)",
  magma: "conic-gradient(from 0deg, #000004, #180f3d, #440f76, #721f81, #9e2f7f, #cd4071, #f1605d, #fd9668, #feca8d, #fcfdbf, #feca8d, #fd9668, #000004)",
  gray: "conic-gradient(from 0deg, #000, #444, #888, #ccc, #fff, #ccc, #888, #444, #000)",
  red: "conic-gradient(from 0deg, #000, #5c0000, #a00000, #ff0000, #ff4444, #ff8888, #ffcccc, #ff8888, #ff4444, #ff0000, #a00000, #5c0000, #000)",
  green: "conic-gradient(from 0deg, #000, #003300, #006600, #00aa00, #00ff00, #66ff66, #ccffcc, #66ff66, #00ff00, #00aa00, #006600, #003300, #000)",
  blue: "conic-gradient(from 0deg, #000, #00001f, #00005f, #0000aa, #0000ff, #6666ff, #ccccff, #6666ff, #0000ff, #0000aa, #00005f, #00001f, #000)",
  winter: "conic-gradient(from 0deg, #0000ff, #0033cc, #006699, #009966, #00cc33, #00ff00, #00cc33, #009966, #006699, #0033cc, #0000ff)",
  actc: "conic-gradient(from 0deg, #00008f, #0040ff, #00bfff, #00ffbf, #40ff00, #ffbf00, #ff4000, #8f0000, #ff4000, #ffbf00, #40ff00, #00ffbf, #00008f)",
  random: "conic-gradient(from 0deg, #ff3b30, #ff9500, #ffcc00, #34c759, #5ac8fa, #007aff, #5856d6, #af52de, #ff2d55, #ff3b30)",
};

// Hex color stops for canvas conic gradient, keyed by colormap name.
// Parallel to COLORMAP_GRADIENTS — one array entry per stop in the conic-gradient string.
const COLORMAP_STOPS = {
  polar_angle_360: ["#ff0000","#ffa500","#ffff00","#3cdc3c","#0000ff","#00b4c8","#00ffff","#c864ff","#ff0000"],
  hsv:    ["#ff0000","#ff8000","#ffff00","#80ff00","#00ff00","#00ff80","#00ffff","#0080ff","#0000ff","#8000ff","#ff00ff","#ff0080","#ff0000"],
  jet:    ["#00008f","#0000ff","#0080ff","#00ffff","#80ff80","#ffff00","#ff8000","#ff0000","#8f0000","#ff0000","#ff8000","#ffff00","#00008f"],
  turbo:  ["#30123b","#4145ab","#4675ed","#38aafe","#1ed0a3","#51e125","#b9eb35","#fdcf36","#fb8e22","#d8410a","#7a0403","#30123b"],
  warm:   ["#1a0000","#5c0000","#b30000","#ff4500","#ffa500","#ffff00","#ffffff","#ffff00","#ffa500","#ff4500","#b30000","#5c0000","#1a0000"],
  cool:   ["#00ffff","#00bfff","#007fff","#003fff","#0000ff","#4000ff","#8000ff","#bf00ff","#ff00ff","#ff00bf","#ff007f","#ff003f","#00ffff"],
  plasma: ["#0d0887","#5b02a3","#9a179b","#cb4779","#ed7953","#fb9f3a","#fdca26","#f0f921","#fdca26","#fb9f3a","#ed7953","#cb4779","#0d0887"],
  viridis:["#440154","#482878","#3e4989","#31688e","#26828e","#1f9e89","#35b779","#6ece58","#b5de2b","#fde725","#b5de2b","#6ece58","#440154"],
  inferno:["#000004","#1b0c41","#4a0c6b","#781c6d","#a52c60","#cf4446","#ed6925","#fb9b06","#f7d13d","#fcffa4","#f7d13d","#fb9b06","#000004"],
  magma:  ["#000004","#180f3d","#440f76","#721f81","#9e2f7f","#cd4071","#f1605d","#fd9668","#feca8d","#fcfdbf","#feca8d","#fd9668","#000004"],
  gray:   ["#000000","#444444","#888888","#cccccc","#ffffff","#cccccc","#888888","#444444","#000000"],
  red:    ["#000000","#5c0000","#a00000","#ff0000","#ff4444","#ff8888","#ffcccc","#ff8888","#ff4444","#ff0000","#a00000","#5c0000","#000000"],
  green:  ["#000000","#003300","#006600","#00aa00","#00ff00","#66ff66","#ccffcc","#66ff66","#00ff00","#00aa00","#006600","#003300","#000000"],
  blue:   ["#000000","#00001f","#00005f","#0000aa","#0000ff","#6666ff","#ccccff","#6666ff","#0000ff","#0000aa","#00005f","#00001f","#000000"],
  winter: ["#0000ff","#0033cc","#006699","#009966","#00cc33","#00ff00","#00cc33","#009966","#006699","#0033cc","#0000ff"],
  actc:   ["#00008f","#0040ff","#00bfff","#00ffbf","#40ff00","#ffbf00","#ff4000","#8f0000","#ff4000","#ffbf00","#40ff00","#00ffbf","#00008f"],
  random: ["#ff3b30","#ff9500","#ffcc00","#34c759","#5ac8fa","#007aff","#5856d6","#af52de","#ff2d55","#ff3b30"],
};

function buildPolarAngleDiscCanvas({
  colormap, arcSegments, summaryText, baseLabel,
  eccenColormap, eccenArcSegments, eccenSummaryText, eccenInverted,
}) {
  const W = 480, H = 850;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#111111';
  ctx.fillText('Predicted Visual Field Defect', W / 2, 20);

  const cx = W / 2;
  const cy = 270; // shifted down 50px to clear the title
  const rOuter = 160;
  const rInner = 16; // small centre dot

  // Conic gradient disc (start at North = UVM = 0°)
  const stops = COLORMAP_STOPS[colormap] || COLORMAP_STOPS.hsv;
  const grad = ctx.createConicGradient(-Math.PI / 2, cx, cy);
  stops.forEach((color, i) => {
    grad.addColorStop(i / (stops.length - 1), color);
  });
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Overlay arcs (lesion mask, if any)
  const overlayArcs = Array.isArray(arcSegments) ? arcSegments : [];
  if (overlayArcs.length > 0) {
    ctx.fillStyle = 'rgba(58,58,58,0.92)';
    overlayArcs.forEach(([s, e]) => {
      const startRad = ((s - 90) * Math.PI) / 180;
      const endRad = ((e + 1 - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, startRad, endRad);
      ctx.arc(cx, cy, rInner, endRad, startRad, true);
      ctx.closePath();
      ctx.fill();
    });
  }

  // White inner circle — covers the centre of the disc (and any arc bleed) with white
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Tick labels outside the disc
  const ticks = [
    { angle: 0, label: 'UVM', deg: '0°' },
    { angle: 90, label: 'RHM', deg: '90°' },
    { angle: 180, label: 'LVM', deg: '180°' },
    { angle: 270, label: 'LHM', deg: '270°' },
  ];
  ticks.forEach(({ angle, label, deg }) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    const lx = cx + Math.cos(rad) * (rOuter + 26);
    const ly = cy + Math.sin(rad) * (rOuter + 26);
    ctx.textAlign = 'center';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, lx, ly + 2);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#555555';
    ctx.textBaseline = 'top';
    ctx.fillText(deg, lx, ly + 4);
  });

  // Polar angle footer
  let fy = cy + rOuter + 44;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '11px monospace';
  ctx.fillStyle = '#444444';
  ctx.fillText('LH cortex · right hemifield (0–180°)', cx, fy);
  fy += 18;
  ctx.fillText('RH cortex · left hemifield (180–360°)', cx, fy);
  fy += 22;

  if (summaryText) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#555555';
    const maxW = 440;
    const words = summaryText.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, cx, fy);
        fy += 16;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) { ctx.fillText(line, cx, fy); fy += 16; }
    fy += 6;
  }

  // ── Eccentricity bar section ──────────────────────────────────────────────

  fy += 10;
  // Divider
  ctx.strokeStyle = '#dddddd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, fy);
  ctx.lineTo(W - 40, fy);
  ctx.stroke();
  fy += 14;

  // Section header
  ctx.textAlign = 'left';
  ctx.font = '11px monospace';
  ctx.fillStyle = '#444444';
  ctx.fillText('Eccentricity · ' + (eccenColormap || 'warm'), 40, fy);
  if (eccenInverted) {
    ctx.textAlign = 'right';
    ctx.font = '10px monospace';
    ctx.fillStyle = '#888888';
    ctx.fillText('inverted', W - 40, fy);
  }
  fy += 18;

  // Horizontal gradient bar
  const barX = 40, barW = W - 80, barH = 18;
  let eccenStops = (ECCEN_STOPS[eccenColormap] || ECCEN_STOPS.warm).slice();
  if (eccenInverted) eccenStops = eccenStops.slice().reverse();
  const linGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  eccenStops.forEach((color, i) => {
    linGrad.addColorStop(i / (eccenStops.length - 1), color);
  });
  ctx.fillStyle = linGrad;
  ctx.fillRect(barX, fy, barW, barH);

  // Overlay segments on the eccentricity bar
  // Bins are inclusive integer pairs [s, e]; render as half-open range s..(e+1).
  const eccenSegs = Array.isArray(eccenArcSegments) ? eccenArcSegments : [];
  if (eccenSegs.length > 0) {
    ctx.fillStyle = 'rgba(58,58,58,0.92)';
    eccenSegs.forEach(([s, e]) => {
      const segX = barX + (s / ECCEN_MAX_DEG) * barW;
      const segW = ((e + 1) / ECCEN_MAX_DEG) * barW - (s / ECCEN_MAX_DEG) * barW;
      ctx.fillRect(segX, fy, Math.max(1, segW), barH);
    });
  }
  fy += barH + 6;

  // Tick labels at proportionally correct positions (0°=0%, 20°=22%, 40°=44%, 60°=67%)
  const eccenTicks = [
    { deg: 0,  label: '0°' },
    { deg: 20, label: '20°' },
    { deg: 40, label: '40°' },
    { deg: 60, label: '60°+' },
  ];
  ctx.font = '10px monospace';
  ctx.fillStyle = '#666666';
  eccenTicks.forEach(({ deg, label }) => {
    const tx = barX + (deg / ECCEN_MAX_DEG) * barW;
    if (deg === 0) {
      ctx.textAlign = 'left';
    } else if (deg === 60) {
      ctx.textAlign = 'right';
    } else {
      ctx.textAlign = 'center';
    }
    ctx.fillText(label, tx, fy);
  });
  fy += 16;

  if (eccenSummaryText) {
    ctx.textAlign = 'center';
    ctx.font = '10px monospace';
    ctx.fillStyle = '#555555';
    const maxW = 440;
    const words = eccenSummaryText.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, cx, fy);
        fy += 16;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) { ctx.fillText(line, cx, fy); fy += 16; }
    fy += 6;
  }

  // ── Timestamp ─────────────────────────────────────────────────────────────
  fy += 4;
  ctx.textAlign = 'center';
  ctx.font = '10px monospace';
  ctx.fillStyle = '#888888';
  ctx.fillText((baseLabel || 'NeuroVue') + ' · ' + new Date().toLocaleString(), cx, fy);

  return canvas;
}

function exportPolarAngleDiscPng(params) {
  const canvas = buildPolarAngleDiscCanvas(params);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = 'polar_angle.png';
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, 'image/png');
}

export function polarAngleDiscToDataURL(params) {
  return buildPolarAngleDiscCanvas(params).toDataURL('image/png');
}

const OVERLAY_FILL = "#3a3a3a";
const OVERLAY_OPACITY = 0.92;

export const ThresholdFooter = ({
  thresholdMode, thresholdMin, onThresholdModeChange, onThresholdMinChange,
  summaryText, testIdPrefix,
}) => {
  const showFooter =
    typeof onThresholdModeChange === "function" ||
    typeof onThresholdMinChange === "function" ||
    !!summaryText;
  if (!showFooter) return null;

  const mode = thresholdMode === "min" ? "min" : "any";
  const btn = (active) =>
    `py-1 px-2 text-[9px] uppercase tracking-[0.15em] border transition-colors ${
      active
        ? "bg-white text-black border-white"
        : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
    }`;

  return (
    <div className="w-full flex flex-col gap-1.5 px-2">
      {onThresholdModeChange && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={btn(mode === "any")}
            onClick={() => onThresholdModeChange("any")}
            data-testid={`${testIdPrefix}-thresh-any`}
          >
            Any overlap
          </button>
          <button
            type="button"
            className={btn(mode === "min")}
            onClick={() => onThresholdModeChange("min")}
            data-testid={`${testIdPrefix}-thresh-min`}
          >
            Min voxels
          </button>
          {mode === "min" && (
            <input
              type="number"
              min={1}
              step={1}
              value={Number.isFinite(thresholdMin) ? thresholdMin : 3}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onThresholdMinChange?.(Number.isFinite(n) ? Math.max(1, n) : 1);
              }}
              className="w-16 bg-[#0a0a0a] border border-[#27272A] text-[10px] text-zinc-200 px-1.5 py-1 font-mono"
              data-testid={`${testIdPrefix}-thresh-min-input`}
            />
          )}
        </div>
      )}
      {summaryText && (
        <div
          className="font-mono text-[10px] text-zinc-400 leading-snug"
          data-testid={`${testIdPrefix}-summary`}
        >
          {summaryText}
        </div>
      )}
    </div>
  );
};

export const PolarAngleDisc = ({
  active = true,
  size = 152,
  colormap = "hsv",
  arcSegments,
  summaryText,
  thresholdMode,
  thresholdMin,
  onThresholdModeChange,
  onThresholdMinChange,
  baseLabel = "",
  // Eccentricity data forwarded to the combined export PNG.
  eccenColormap,
  eccenArcSegments,
  eccenSummaryText,
  eccenInverted = false,
}) => {
  const radius = size / 2;
  const ticks = [
    { angle: 0, label: "UVM", deg: "0°" },
    { angle: 90, label: "RHM", deg: "90°" },
    { angle: 180, label: "LVM", deg: "180°" },
    { angle: 270, label: "LHM", deg: "270°" },
  ];
  const gradient = COLORMAP_GRADIENTS[colormap] || COLORMAP_GRADIENTS.hsv;
  // Per the plan: when the retinotopy layer is OFF (active=false), the legend
  // falls back to the whole-wheel dim look and overlay arcs are suppressed.
  const overlayArcs = active && Array.isArray(arcSegments) ? arcSegments : [];
  const rOuter = radius;
  const rInner = radius * 0.45;

  return (
    <div className="flex flex-col items-center gap-2 py-2" data-testid="polar-angle-disc">
      <div className={`relative flex items-center justify-center ${active ? "disc-active" : ""}`}
        style={{ width: size + 56, height: size + 40 }}>
        <div className="absolute rounded-full"
          style={{
            width: size, height: size, top: 20, left: 28,
            background: gradient,
            filter: active ? "saturate(1.1)" : "saturate(0.4) brightness(0.6)",
            transition: "all 300ms ease",
          }} />
        {overlayArcs.length > 0 && (
          <svg
            className="absolute pointer-events-none"
            width={size}
            height={size}
            style={{ top: 20, left: 28 }}
            data-testid="polar-overlay-arcs"
          >
            {/* Bins are inclusive integer angles (e.g., [45, 46] = bins 45 & 46).
                Render as arc from s° to (e+1)° so a single bin gets a 1°-wide arc. */}
            {overlayArcs.map(([s, e], idx) => (
              <path
                key={`${s}-${e}-${idx}`}
                d={donutArcPath(radius, radius, rOuter, rInner, s, e + 1)}
                fill={OVERLAY_FILL}
                fillOpacity={OVERLAY_OPACITY}
              />
            ))}
          </svg>
        )}
        <div className="absolute rounded-full bg-[#050505]"
          style={{ width: size * 0.45, height: size * 0.45, top: 20 + size * 0.275, left: 28 + size * 0.275 }} />
        <div className="absolute z-10 text-center"
          style={{ top: 20 + size * 0.32, left: 28 + size * 0.225, width: size * 0.55 }}>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">polar</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">angle</div>
          <div className="font-mono text-[8px] tracking-[0.15em] text-zinc-600 mt-0.5">{colormap}</div>
        </div>
        {ticks.map((t) => {
          const rad = ((t.angle - 90) * Math.PI) / 180;
          const cx = (size + 56) / 2 + Math.cos(rad) * (radius + 6);
          const cy = (size + 40) / 2 + Math.sin(rad) * (radius + 6);
          return (
            <div key={t.angle}
              className="absolute flex flex-col items-center leading-none"
              style={{ left: cx, top: cy, transform: "translate(-50%, -50%)" }}>
              <span className="font-mono text-[10px] text-zinc-200">{t.label}</span>
              <span className="font-mono text-[8px] text-zinc-500 mt-0.5">{t.deg}</span>
            </div>
          );
        })}
      </div>
      <div className="font-mono text-[9px] text-zinc-600 uppercase tracking-[0.2em] text-center px-4 leading-relaxed">
        LH cortex · right hemifield (0–180°) <br/> RH cortex · left hemifield (180–360°)
      </div>
      <ThresholdFooter
        thresholdMode={thresholdMode}
        thresholdMin={thresholdMin}
        onThresholdModeChange={onThresholdModeChange}
        onThresholdMinChange={onThresholdMinChange}
        summaryText={summaryText}
        testIdPrefix="polar"
      />
      <button
        type="button"
        className="py-1 px-2 text-[9px] uppercase tracking-[0.15em] border transition-colors bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
        onClick={() => exportPolarAngleDiscPng({
          colormap, arcSegments, summaryText, baseLabel,
          eccenColormap, eccenArcSegments, eccenSummaryText, eccenInverted,
        })}
        data-testid="polar-export-btn"
      >
        Export PNG
      </button>
    </div>
  );
};

const ECCEN_GRADIENTS = {
  warm: "linear-gradient(to right, #1a0000, #5c0000, #b30000, #ff4500, #ffa500, #ffff00, #ffffff)",
  cool: "linear-gradient(to right, #00ffff, #007fff, #0000ff, #8000ff, #ff00ff)",
  hsv: "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
  plasma: "linear-gradient(to right, #0d0887, #5b02a3, #9a179b, #cb4779, #ed7953, #fb9f3a, #fdca26, #f0f921)",
  viridis: "linear-gradient(to right, #440154, #482878, #3e4989, #31688e, #26828e, #1f9e89, #35b779, #6ece58, #b5de2b, #fde725)",
  turbo: "linear-gradient(to right, #30123b, #4145ab, #4675ed, #38aafe, #1ed0a3, #51e125, #b9eb35, #fdcf36, #fb8e22, #d8410a, #7a0403)",
  jet: "linear-gradient(to right, #00008f, #0000ff, #0080ff, #00ffff, #80ff80, #ffff00, #ff8000, #ff0000, #8f0000)",
  gray: "linear-gradient(to right, #000, #888, #fff)",
};

// Hex color stops for canvas linearGradient, keyed by colormap name.
// Parallel to ECCEN_GRADIENTS — used when drawing the eccentricity bar on the export canvas.
const ECCEN_STOPS = {
  warm:   ["#1a0000","#5c0000","#b30000","#ff4500","#ffa500","#ffff00","#ffffff"],
  cool:   ["#00ffff","#007fff","#0000ff","#8000ff","#ff00ff"],
  hsv:    ["#ff0000","#ffff00","#00ff00","#00ffff","#0000ff","#ff00ff","#ff0000"],
  plasma: ["#0d0887","#5b02a3","#9a179b","#cb4779","#ed7953","#fb9f3a","#fdca26","#f0f921"],
  viridis:["#440154","#482878","#3e4989","#31688e","#26828e","#1f9e89","#35b779","#6ece58","#b5de2b","#fde725"],
  turbo:  ["#30123b","#4145ab","#4675ed","#38aafe","#1ed0a3","#51e125","#b9eb35","#fdcf36","#fb8e22","#d8410a","#7a0403"],
  jet:    ["#00008f","#0000ff","#0080ff","#00ffff","#80ff80","#ffff00","#ff8000","#ff0000","#8f0000"],
  gray:   ["#000000","#888888","#ffffff"],
};

// Atlas covers 0°–90° visual eccentricity; bins are integer degrees 0–90.
// Background value 0 is excluded by calMin=0.5 in the atlas config.
const ECCEN_MAX_DEG = 90;

export const EccentricityBar = ({
  active = true,
  colormap = "warm",
  arcSegments,
  summaryText,
  thresholdMode,
  thresholdMin,
  onThresholdModeChange,
  onThresholdMinChange,
  // inverted: flips the colorbar direction (min↔max) in both the legend and 3D view.
  inverted = false,
  onInvertToggle,
}) => {
  const baseGradient = ECCEN_GRADIENTS[colormap] || ECCEN_GRADIENTS.warm;
  // Flip gradient direction by swapping "to right" ↔ "to left" when inverted.
  const gradient = inverted ? baseGradient.replace('to right', 'to left') : baseGradient;
  // Dims the bar and suppresses overlay arcs when the eccentricity atlas is not visible in the 3D view.
  const overlaySegments = active && Array.isArray(arcSegments) ? arcSegments : [];

  const invertBtnCls = `py-1 px-2 text-[9px] uppercase tracking-[0.15em] border transition-colors ${
    inverted
      ? "bg-white text-black border-white"
      : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
  }`;

  // Tick values and their proportional positions along the 0–90° bar.
  const TICKS = [
    { deg: 0,  label: "0°" },
    { deg: 20, label: "20°" },
    { deg: 40, label: "40°" },
    { deg: 60, label: "60°+" },
  ];

  return (
    <div className="flex flex-col gap-2 py-2" data-testid="eccen-legend">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        <span>eccentricity ({colormap})</span>
        <div className="flex items-center gap-1">
          <span>°visual angle</span>
          <button
            type="button"
            className={invertBtnCls}
            onClick={() => onInvertToggle?.()}
            data-testid="eccen-invert-btn"
          >
            Invert Color Bar
          </button>
        </div>
      </div>
      <div className="relative h-3 w-full" data-testid="eccen-bar">
        <div
          className="absolute inset-0"
          style={{ background: gradient, filter: active ? "none" : "saturate(0.3) brightness(0.5)" }}
        />
        {overlaySegments.map(([s, e], idx) => {
          // Bins are inclusive integer pairs; render bin s..e as the half-open span s..(e+1).
          const left = Math.max(0, Math.min(100, (s / ECCEN_MAX_DEG) * 100));
          const right = Math.max(0, Math.min(100, ((e + 1) / ECCEN_MAX_DEG) * 100));
          const width = Math.max(0, right - left);
          if (width <= 0) return null;
          return (
            <div
              key={`${s}-${e}-${idx}`}
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: OVERLAY_FILL,
                opacity: OVERLAY_OPACITY,
              }}
              data-testid="eccen-overlay-seg"
            />
          );
        })}
      </div>
      {/* Tick labels pinned to their proportional positions (0°=0%, 20°=22%, 40°=44%, 60°=67%).
          Previously used justify-between which spaced them evenly at 0/33/67/100% — incorrect. */}
      <div className="relative h-4 font-mono text-[10px] text-zinc-400">
        {TICKS.map(({ deg, label }) => (
          <span
            key={deg}
            className="absolute"
            style={{
              left: `${(deg / ECCEN_MAX_DEG) * 100}%`,
              transform: deg === 0 ? "none" : deg === 60 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {label}
          </span>
        ))}
      </div>
      <ThresholdFooter
        thresholdMode={thresholdMode}
        thresholdMin={thresholdMin}
        onThresholdModeChange={onThresholdModeChange}
        onThresholdMinChange={onThresholdMinChange}
        summaryText={summaryText}
        testIdPrefix="eccen"
      />
    </div>
  );
};
