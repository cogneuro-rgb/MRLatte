// Horizontal mosaic ("lightbox") strip: N evenly spaced slices of one
// orientation laid out in a single row.
//
// niivue draws mosaics from a string (nv.setSliceMosaicString): an orientation
// letter followed by slice positions in WORLD mm, one row unless a ";" starts a
// new one. Tile labels are left off ("L+" would only print L/R/A/P letters in
// every tile); the viewer's own per-tile "Ax 84/182" readout names each
// slice instead (updateTileSliceInfo). A non-empty string takes
// priority over every other layout in niivue's drawScene (sliceType and
// customLayout included), so leaving mosaic mode must set it back to "".

// World-mm axis each orientation steps along: axial → z, coronal → y, sagittal → x.
export const MOSAIC_AXIS_INDEX = { A: 2, C: 1, S: 0 };

export const MOSAIC_COUNT_MIN = 1;
export const MOSAIC_COUNT_MAX = 25;
export const MOSAIC_ROWS_MIN = 1;
export const MOSAIC_ROWS_MAX = 6;
export const MOSAIC_GAP_MIN = 1;
export const MOSAIC_GAP_MAX = 40;

/** Slice positions (mm) for `count` slices `gapMM` apart, centred on `centerMM`. */
export function mosaicPositions(count, gapMM, centerMM) {
  const mid = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => centerMM + (i - mid) * gapMM);
}

/**
 * Keep the strip inside the volume: the centre is clamped so the first and
 * last tiles stay within [minMM, maxMM]. A strip longer than the volume is
 * centred on it instead (its outer tiles then fall off both ends equally).
 */
export function clampMosaicCenter(centerMM, count, gapMM, minMM, maxMM) {
  const half = ((count - 1) / 2) * gapMM;
  if (maxMM - minMM <= 2 * half) return (minMM + maxMM) / 2;
  return Math.min(maxMM - half, Math.max(minMM + half, centerMM));
}

/**
 * `count` slices per row × `rows` rows, all one evenly spaced run read left to
 * right, top to bottom (";" starts a new row in niivue's mosaic syntax).
 * `centerMM` is the centre of the whole run, so callers clamp with
 * count * rows tiles.
 */
export function buildMosaicString(axis, count, gapMM, centerMM, rows = 1) {
  const mm = mosaicPositions(count * rows, gapMM, centerMM).map((v) => +v.toFixed(2));
  const lines = Array.from({ length: rows }, (_, r) => mm.slice(r * count, (r + 1) * count).join(" "));
  return `${axis} ${lines.join(" ; ")}`;
}
