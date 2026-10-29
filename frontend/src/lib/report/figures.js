// Report figures drawn from the volumes themselves — not screenshots of the
// viewer, so they don't depend on (or disturb) what is on screen, need no
// optional module, and embed in the report file as PNG data URLs that still
// show when it is opened later, anywhere.
//
// Every volume is sampled nearest-neighbour in WORLD mm through its own
// native sform (`hdr.affine`, row-major, native voxel order — the frame
// lib/volumeAnalysis.js::regionCentroidMM explains), so a lesion on its own
// grid, a 2 mm network map and the 1 mm template line up without resampling.
//
// Orientation: neurological — the patient's left on the image's left — and
// labelled L/R on every axial and coronal tile. Sagittal tiles run posterior
// (left) to anterior (right), as in the viewer.

import { invertMat4 } from "@/lib/volumeAnalysis";

/** World-mm sampler for an NVImage-like volume ({ img, hdr: { dims, affine,
 * scl_slope, scl_inter } }). `at(x, y, z)` returns the scaled value or NaN
 * outside the grid. Returns null if the volume has no usable affine. */
export function volumeSampler(vol) {
  const hdr = vol?.hdr;
  const A = hdr?.affine;
  if (!vol?.img || !Array.isArray(A) || !hdr?.dims) return null;
  const nx = hdr.dims[1], ny = hdr.dims[2], nz = hdr.dims[3] || 1;
  const inv = invertMat4([...A[0], ...A[1], ...A[2], ...(A[3] || [0, 0, 0, 1])]);
  if (!inv) return null;
  const s = hdr.scl_slope, t = hdr.scl_inter;
  const slope = Number.isFinite(s) && s !== 0 ? s : 1;
  const inter = Number.isFinite(t) ? t : 0;
  const img = vol.img;
  return {
    nx, ny, nz,
    at(x, y, z) {
      // Row-major inverse: [i j k] = inv · [x y z 1].
      const i = Math.round(inv[0] * x + inv[1] * y + inv[2] * z + inv[3]);
      const j = Math.round(inv[4] * x + inv[5] * y + inv[6] * z + inv[7]);
      const k = Math.round(inv[8] * x + inv[9] * y + inv[10] * z + inv[11]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return NaN;
      return img[i + nx * (j + ny * k)] * slope + inter;
    },
  };
}

/** World-mm bounding box [[x0,y0,z0],[x1,y1,z1]] and centroid of the voxels
 * whose scaled value passes `test`, or null if none do. `step` subsamples
 * large volumes (every step-th voxel per axis). */
export function extentMM(vol, test, step = 1) {
  const hdr = vol?.hdr;
  const A = hdr?.affine;
  if (!vol?.img || !Array.isArray(A) || !hdr?.dims) return null;
  const nx = hdr.dims[1], ny = hdr.dims[2], nz = hdr.dims[3] || 1;
  const s = hdr.scl_slope, t = hdr.scl_inter;
  const slope = Number.isFinite(s) && s !== 0 ? s : 1;
  const inter = Number.isFinite(t) ? t : 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  let n = 0;
  for (let k = 0; k < nz; k += step) {
    for (let j = 0; j < ny; j += step) {
      for (let i = 0; i < nx; i += step) {
        if (!test(vol.img[i + nx * (j + ny * k)] * slope + inter)) continue;
        for (let r = 0; r < 3; r++) {
          const w = A[r][0] * i + A[r][1] * j + A[r][2] * k + A[r][3];
          if (w < lo[r]) lo[r] = w;
          if (w > hi[r]) hi[r] = w;
          sum[r] += w;
        }
        n++;
      }
    }
  }
  if (!n) return null;
  return { min: lo, max: hi, centroid: sum.map((v) => v / n), count: n };
}

/** `n` slice positions (mm) spread across [lo, hi]: the centres of n equal
 * bands, so a thin lesion still gets n distinct slices through it. */
export function slicePositions(lo, hi, n) {
  if (!(hi > lo)) return Array.from({ length: n }, () => lo);
  const d = (hi - lo) / n;
  return Array.from({ length: n }, (_, i) => Math.round((lo + (i + 0.5) * d) * 2) / 2);
}

// Which world axes run across (u) and down (v) a tile, and which is fixed.
// v runs top→bottom, so it is the axis that DEcreases down the image.
// Whole millimetres, without a "-0".
const mm = (v) => Math.round(v) || 0;

const PLANES = {
  axial: { u: 0, v: 1, w: 2, vDown: -1, ends: ["L", "R"], name: "z" },
  coronal: { u: 0, v: 2, w: 1, vDown: -1, ends: ["L", "R"], name: "y" },
  sagittal: { u: 1, v: 2, w: 0, vDown: -1, ends: ["P", "A"], name: "x" },
};

/** Pixel → world-mm mapping for one tile: `plane` cut at `at` mm, covering the
 * world box `bounds` ({ min, max }) at `pxPerMM`. Pure; drawTile uses it. */
export function tileGeometry(plane, at, bounds, pxPerMM) {
  const p = PLANES[plane];
  const u0 = bounds.min[p.u], u1 = bounds.max[p.u];
  const v0 = bounds.min[p.v], v1 = bounds.max[p.v];
  const w = Math.max(1, Math.round((u1 - u0) * pxPerMM));
  const h = Math.max(1, Math.round((v1 - v0) * pxPerMM));
  return {
    w, h, plane, at, ends: p.ends,
    label: `${p.name} = ${mm(at)} mm`,
    toMM(px, py) {
      const xyz = [0, 0, 0];
      xyz[p.u] = u0 + (px + 0.5) / pxPerMM;
      xyz[p.v] = v1 - (py + 0.5) / pxPerMM;       // top of the tile = highest v
      xyz[p.w] = at;
      return xyz;
    },
  };
}

function hexRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paint one tile into `ctx` at (ox, oy). `base` = { sampler, lo, hi }
 * greyscale window; each overlay = { sampler, test, color, alpha, outline }. */
function drawTile(ctx, ox, oy, geo, base, overlays) {
  const { w, h } = geo;
  const image = ctx.createImageData(w, h);
  const px = image.data;
  const masks = overlays.map(() => new Uint8Array(w * h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [mx, my, mz] = geo.toMM(x, y);
      const o = (y * w + x);
      const b = base.sampler.at(mx, my, mz);
      const g = Number.isFinite(b) ? Math.max(0, Math.min(255, ((b - base.lo) / (base.hi - base.lo)) * 255)) : 0;
      px[o * 4] = px[o * 4 + 1] = px[o * 4 + 2] = g;
      px[o * 4 + 3] = 255;
      overlays.forEach((ov, n) => { if (ov.test(ov.sampler.at(mx, my, mz))) masks[n][o] = 1; });
    }
  }
  overlays.forEach((ov, n) => {
    const m = masks[n];
    const [r, g, b] = hexRgb(ov.color);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (!m[o]) continue;
        // An edge pixel: inside the overlay with a neighbour outside it.
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
          || !m[o - 1] || !m[o + 1] || !m[o - w] || !m[o + w];
        const a = edge ? 1 : (ov.outline ? 0 : ov.alpha);
        if (!a) continue;
        px[o * 4] = px[o * 4] * (1 - a) + r * a;
        px[o * 4 + 1] = px[o * 4 + 1] * (1 - a) + g * a;
        px[o * 4 + 2] = px[o * 4 + 2] * (1 - a) + b * a;
      }
    }
  });
  ctx.putImageData(image, ox, oy);
}

/** Robust greyscale window [lo, hi] of a volume (2nd–99.5th percentile of its
 * non-zero voxels, sampled), in scaled units. */
export function displayWindow(vol) {
  const img = vol?.img;
  if (!img?.length) return [0, 1];
  const s = vol.hdr?.scl_slope, t = vol.hdr?.scl_inter;
  const slope = Number.isFinite(s) && s !== 0 ? s : 1;
  const inter = Number.isFinite(t) ? t : 0;
  const stride = Math.max(1, Math.floor(img.length / 200000));
  const vals = [];
  for (let i = 0; i < img.length; i += stride) {
    const v = img[i];
    if (v !== 0 && Number.isFinite(v)) vals.push(v * slope + inter);
  }
  if (!vals.length) return [0, 1];
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/**
 * Compose a figure: rows of tiles over one base scan, with overlays, as a PNG
 * data URL. `rows` = [[{ plane, at }, ...], ...]; `overlays` = [{ vol, test,
 * color, alpha, outline }]. Each row is scaled to the same width. Returns null
 * when there is no canvas (tests) or the base can't be sampled.
 */
export function renderFigure({ base, overlays = [], rows, tilePx = 230, background = "#000000" }) {
  if (typeof document === "undefined") return null;
  const bs = volumeSampler(base);
  if (!bs) return null;
  const [lo, hi] = displayWindow(base);
  // Crop to the head: the base's voxels above a tenth of its window.
  const cut = lo + 0.1 * (hi - lo);
  const head = extentMM(base, (v) => v > cut, 2) || extentMM(base, (v) => v !== 0, 2);
  if (!head) return null;
  const pad = 4;
  const bounds = { min: head.min.map((v) => v - pad), max: head.max.map((v) => v + pad) };
  const ovs = overlays.map((o) => ({ ...o, sampler: volumeSampler(o.vol) })).filter((o) => o.sampler);

  const gap = 6, label = 16;
  const layout = rows.map((row) => {
    // Scale the row so its tiles, laid side by side, are tilePx tall at most
    // and fit the figure's width.
    const geos1 = row.map((t) => tileGeometry(t.plane, t.at, bounds, 1));
    const sumW = geos1.reduce((s, g) => s + g.w, 0);
    const maxH = Math.max(...geos1.map((g) => g.h));
    const width = tilePx * 3 + gap * 2;
    const pxPerMM = Math.min(tilePx / maxH, (width - gap * (row.length - 1)) / sumW);
    // Side labels (L/R, P/A) on the first tile of each plane in a row only:
    // repeated on every tile they read as "R L R L".
    const seen = new Set();
    return row.map((t) => {
      const g = tileGeometry(t.plane, t.at, bounds, pxPerMM);
      g.showEnds = !seen.has(t.plane);
      seen.add(t.plane);
      return g;
    });
  });
  const W = Math.max(...layout.map((geos) => geos.reduce((s, g) => s + g.w, 0) + gap * (geos.length - 1)));
  const H = layout.reduce((s, geos) => s + Math.max(...geos.map((g) => g.h)) + label, 0) + gap * (layout.length - 1);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  for (const geos of layout) {
    const rowW = geos.reduce((s, g) => s + g.w, 0) + gap * (geos.length - 1);
    let x = Math.round((W - rowW) / 2);
    const rowH = Math.max(...geos.map((g) => g.h));
    for (const g of geos) {
      drawTile(ctx, x, y, g, { sampler: bs, lo, hi }, ovs);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "600 11px -apple-system, 'Segoe UI', Arial, sans-serif";
      ctx.textBaseline = "top";
      if (g.showEnds) {
        ctx.textAlign = "left";
        ctx.fillText(g.ends[0], x + 4, y + 4);
        ctx.textAlign = "right";
        ctx.fillText(g.ends[1], x + g.w - 4, y + 4);
      }
      ctx.textAlign = "center";
      ctx.fillStyle = "#9ca3af";
      ctx.font = "11px -apple-system, 'Segoe UI', Arial, sans-serif";
      ctx.fillText(g.label, x + g.w / 2, y + rowH + 2);
      x += g.w + gap;
    }
    y += rowH + label + gap;
  }
  return canvas.toDataURL("image/png");
}

const above = (t) => (v) => v > t;

/** The lesion over the base: three views through its centre, then axial
 * slices across its extent. Returns { src, caption } or null. */
export function lesionFigure(base, lesion, { color = "#ef4444" } = {}) {
  const ext = extentMM(lesion, above(0.5));
  if (!ext) return null;
  const [cx, cy, cz] = ext.centroid;
  const src = renderFigure({
    base,
    overlays: [{ vol: lesion, test: above(0.5), color, alpha: 0.7 }],
    rows: [
      [{ plane: "axial", at: cz }, { plane: "coronal", at: cy }, { plane: "sagittal", at: cx }],
      slicePositions(ext.min[2], ext.max[2], 6).map((z) => ({ plane: "axial", at: z })),
    ],
  });
  return src && {
    src,
    caption: `Lesion (red) on the base scan. Top: through its centre (${mm(cx)}, ${mm(cy)}, ${mm(cz)} mm). `
      + `Bottom: axial slices from ${mm(ext.min[2])} to ${mm(ext.max[2])} mm. Neurological orientation (left is left).`,
  };
}

/** Whole-brain axial slices of one or more maps (e.g. affected tracts, or the
 * positive and negative network), with the lesion outlined. `maps` = [{ vol,
 * test, color, alpha }]. Returns { src, caption } or null. */
export function mapsFigure(base, maps, lesion, caption, { slices = 8 } = {}) {
  const usable = maps.filter((m) => m?.vol);
  if (!usable.length) return null;
  const [lo, hi] = displayWindow(base);
  const head = extentMM(base, above(lo + 0.1 * (hi - lo)), 2);
  if (!head) return null;
  // Skip the bottom fifth (neck, cerebellum base) and the very top.
  const z0 = head.min[2] + 0.22 * (head.max[2] - head.min[2]);
  const z1 = head.max[2] - 0.08 * (head.max[2] - head.min[2]);
  const zs = slicePositions(z0, z1, slices);
  const half = Math.ceil(zs.length / 2);
  const src = renderFigure({
    base,
    overlays: [
      ...usable,
      ...(lesion ? [{ vol: lesion, test: above(0.5), color: "#ffffff", outline: true }] : []),
    ],
    rows: [zs.slice(0, half), zs.slice(half)].map((r) => r.map((z) => ({ plane: "axial", at: z }))),
    tilePx: 200,
  });
  return src && { src, caption };
}
