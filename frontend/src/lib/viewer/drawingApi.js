import { toast } from "sonner";
import { NVImage, NVUtilities, PEN_TYPE } from "@niivue/niivue";
import { interpolateSlices } from "@/lib/drawInterpolate";
import { rleEncode, rleDecode } from "@/lib/drawHistory";

/**
 * Drawing API: enable/disable, tool mode, undo/redo, morph, sphere-paint,
 * interpolation, load/save of the editable scratch drawing.
 *
 * Backs the corresponding entries of NiivueViewer's imperative handle
 * (everything under "===== Drawing API =====" except the click-to-segment
 * trio, which lives in lib/viewer/segmentation.js). Method names, signatures
 * and behaviour are unchanged — this is a relocation.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses
 *                       nvRef, drawHistory, lastDraws, brushRadiusRef,
 *                       toolModeRef, drawStartCb, drawCommitCb,
 *                       drawingActiveCb, historyCb, activeOrientationRef.
 * @param {object} deps  component-scope collaborators that are not refs.
 * @param {(v: boolean) => void} deps.setDrawingActive
 * @param {() => void} deps.snapshotForUndo
 * @param {() => void} deps.emitHistory
 * @param {() => any} deps.interpolatablePair
 * @param {(axCorSag: number) => any[]} deps.distinctSliceEntriesForOrientation
 * @param {(centerMM: number[], radiusMM: number, labelValue: number) => boolean} deps.rasterizeSphere
 */
export function createDrawingApi(ctx, {
  setDrawingActive,
  snapshotForUndo,
  emitHistory,
  interpolatablePair,
  distinctSliceEntriesForOrientation,
  rasterizeSphere,
}) {
  const {
    nvRef, drawHistory, lastDraws, brushRadiusRef, toolModeRef, brushModeRef,
    drawStartCb, drawCommitCb, drawingActiveCb, historyCb, drawChangeCb, activeOrientationRef,
  } = ctx;

  // Item 101 self-healing fallback: the primary fix lives in
  // volumeApi.js::replaceBaseVolume (reallocates the drawing whenever the
  // base's grid actually changes size), but if drawBitmap ever ends up
  // mismatched against nv.back's CURRENT dims through some other path,
  // attempt ONE createEmptyDrawing() re-sync before the caller gives up and
  // shows "Drawing grid unavailable". A bitmap that's already the wrong size
  // for the active grid is unusable regardless, so reallocating loses
  // nothing that wasn't already broken. Returns true once nx/ny/nz genuinely
  // match drawBitmap.length (whether or not a resync was needed).
  const resyncDrawingGridIfStale = (nv, nx, ny, nz) => {
    if (nv.drawBitmap && nv.drawBitmap.length === nx * ny * nz) return true;
    try { nv.createEmptyDrawing(); } catch (_e) { return false; }
    if (!nv.drawBitmap || nv.drawBitmap.length !== nx * ny * nz) return false;
    drawHistory.current = [];
    lastDraws.current = [];
    try { emitHistory(); } catch (_e) {}
    return true;
  };

  return {
    // ===== Drawing API =====
    // Crosshair visibility while drawing is governed by the same crosshair
    // toggle/style as the rest of the app (Dashboard's setCrosshair /
    // setCrosshairStyle) — this no longer overrides it independently.
    setDrawingEnabled: (enabled) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.setDrawingEnabled(enabled);
      setDrawingActive(!!enabled);
      nv.drawScene();
    },
    // Draw-coordination callbacks (see refs above).
    setDrawStartCallback: (cb) => { drawStartCb.current = cb; },
    setDrawCommitCallback: (cb) => { drawCommitCb.current = cb; },
    // Fires whenever the draw bitmap changes. Its own slot (not drawCommitCb,
    // which DrawingPanel owns) so a second subscriber can't displace the panel's.
    setDrawChangeCallback: (cb) => { drawChangeCb.current = cb; },
    // The in-progress drawing exposed as a read-only volume-like object, so
    // analyses that take a lesion volume (retinotopy overlap, atlas overlap)
    // can run on the scratch bitmap before it's ever saved as a layer.
    //
    // Geometry is BORROWED from the base volume rather than derived: niivue
    // allocates drawBitmap against nv.back's grid and refuses to load a drawing
    // whose dims differ, so the bitmap is always exactly the base's voxel grid.
    // That makes `img: drawBitmap` + the base's dims/matRAS a faithful volume —
    // and identical in convention to how a saved lesion layer is read back.
    //
    // Carries the same caveat volumeAnalysis.js documents above voxToMM: img is
    // in NATIVE voxel order while dimsRAS/matRAS describe niivue's RAS-reoriented
    // frame, so the pairing is only exact for a base already in RAS (the MNI
    // template and every atlas-space scan the analyses target). A saved lesion
    // layer is read back through the identical pairing, so the drawing is no
    // less correct than the layer it becomes on Save — but neither is right for
    // an oddly-oriented native scan.
    //
    // Returns null when there is no drawing or every voxel is zero, so callers
    // can treat "nothing drawn yet" and "no drawing" the same way.
    getDrawingAsVolume: () => {
      const nv = nvRef.current;
      const base = nv?.back || nv?.volumes?.[0];
      if (!nv?.drawBitmap || !base) return null;
      const dims = base.dimsRAS || base.dims;
      if (!dims) return null;
      const n = (dims[1] || 0) * (dims[2] || 0) * (dims[3] || 0);
      if (!n || nv.drawBitmap.length < n) return null;
      if (!nv.drawBitmap.some((v) => v !== 0)) return null;
      return {
        img: nv.drawBitmap,
        dims: base.dims,
        dimsRAS: base.dimsRAS,
        matRAS: base.matRAS,
        hdr: base.hdr,
      };
    },
    // Shape-morph fill/void-carve of every slice between the last two
    // same-orientation, same-tool strokes (item 70: Pen fills its label,
    // Cutout carves a 0 void using the erased footprint captured at commit
    // time). Registers an undo bitmap first, so drawUndo() reverts it.
    interpolateDrawnSlices: () => {
      const nv = nvRef.current;
      if (!nv || !nv.drawBitmap) {
        toast.error("Nothing drawn yet");
        return false;
      }
      const pair = interpolatablePair();
      if (!pair) {
        toast.error("Draw the same view, with the same tool (Pen or Cutout), on two different slices first");
        return false;
      }
      const dims = nv.back?.dims;
      const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
      if (!nx || !ny || !nz || !resyncDrawingGridIfStale(nv, nx, ny, nz)) {
        toast.error("Drawing grid unavailable");
        return false;
      }
      const mode = pair.tool === "cutout" ? "void" : "fill";
      // Snapshot BEFORE calling interpolateSlices (so undo has the correct
      // pre-mutation state to restore), but only actually push it to the undo
      // stack once we know a mutation happened — interpolateSlices no longer
      // touches the bitmap at all when the two shapes don't connect all the
      // way across the gap (SMALL-FIXES follow-up), so a rejected fill must
      // leave no undo entry either.
      const preSnapshot = rleEncode(nv.drawBitmap);
      const result = interpolateSlices({
        bitmap: nv.drawBitmap,
        dims: [nx, ny, nz],
        axCorSag: pair.axCorSag,
        sliceA: pair.sliceA,
        sliceB: pair.sliceB,
        label: pair.label,
        mode,
        maskA: mode === "void" ? pair.footprintA : null,
        maskB: mode === "void" ? pair.footprintB : null,
      });
      if (result.disconnected) {
        toast.error(mode === "void" ? "Erased shapes don't connect across this gap" : "Drawings don't connect across this gap", {
          description: mode === "void"
            ? "The erased footprints on these slices don't overlap enough to morph into each other — nothing changed."
            : "The shapes on these slices don't overlap enough to morph into each other — nothing changed.",
        });
        return false;
      }
      drawHistory.current.push(preSnapshot);
      emitHistory();
      try { nv.refreshDrawing(true); } catch (_e) { /* redraw is best-effort */ }
      if (result.filled > 0) {
        toast.success(
          `${mode === "void" ? "Carved a void through" : "Interpolated"} ${result.filled} slice${result.filled === 1 ? "" : "s"}`,
          { description: "Undo to revert" }
        );
      } else {
        toast.info("Slices are adjacent — nothing to fill between them");
      }
      return true;
    },
    // Fill/void-carve between EVERY pair of adjacent same-orientation drawn
    // slices (item 62/70) — distinct from interpolateDrawnSlices, which only
    // fills between the last two. Orientation = the app's active/last-
    // interacted tile (activeOrientationRef), not necessarily the most recent
    // stroke's. A gap between two DIFFERENT tools (one Pen slice, one Cutout
    // slice) is skipped and reported, same convention as a disconnected gap —
    // the two aren't comparable (a label shape vs. an erased footprint).
    interpolateAllDrawnSlices: () => {
      const nv = nvRef.current;
      if (!nv || !nv.drawBitmap) {
        toast.error("Nothing drawn yet");
        return false;
      }
      const axCorSag = activeOrientationRef.current;
      if (axCorSag == null || axCorSag < 0 || axCorSag > 2) {
        toast.error("No active orientation");
        return false;
      }
      const entries = distinctSliceEntriesForOrientation(axCorSag);
      if (entries.length < 2) {
        toast.error("Draw at least two slices in this view first");
        return false;
      }
      const dims = nv.back?.dims;
      const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
      if (!nx || !ny || !nz || !resyncDrawingGridIfStale(nv, nx, ny, nz)) {
        toast.error("Drawing grid unavailable");
        return false;
      }
      // Snapshot BEFORE the batch (undo needs the pre-mutation state), but
      // only push it to the undo stack if at least one pair actually mutated
      // the bitmap — interpolateSlices no longer touches the bitmap at all
      // for a pair that doesn't connect (SMALL-FIXES follow-up). Validated
      // PER PAIR so one bad gap doesn't block the rest of the batch.
      const preSnapshot = rleEncode(nv.drawBitmap);
      let totalFilled = 0;
      let mutated = false;
      const skipped = [];
      const toolMismatch = [];
      for (let i = 0; i < entries.length - 1; i++) {
        const a = entries[i], b = entries[i + 1];
        const toolA = a.tool || "pen", toolB = b.tool || "pen";
        if (toolA !== toolB) {
          toolMismatch.push([a.slice, b.slice]);
          continue;
        }
        const mode = toolA === "cutout" ? "void" : "fill";
        const result = interpolateSlices({
          bitmap: nv.drawBitmap,
          dims: [nx, ny, nz],
          axCorSag,
          sliceA: a.slice,
          sliceB: b.slice,
          label: a.label,
          mode,
          maskA: mode === "void" ? a.footprint : null,
          maskB: mode === "void" ? b.footprint : null,
        });
        if (result.disconnected) {
          skipped.push([a.slice, b.slice]);
          continue;
        }
        if (result.filled > 0) mutated = true;
        totalFilled += result.filled;
      }
      if (mutated) {
        drawHistory.current.push(preSnapshot);
        emitHistory();
        try { nv.refreshDrawing(true); } catch (_e) { /* redraw is best-effort */ }
      }
      const skipParts = [];
      if (skipped.length) {
        skipParts.push(`${skipped.length} gap${skipped.length === 1 ? "" : "s"} don't connect (${skipped.map(([a, b]) => `${a}↔${b}`).join(", ")})`);
      }
      if (toolMismatch.length) {
        skipParts.push(`${toolMismatch.length} gap${toolMismatch.length === 1 ? "" : "s"} mix Pen/Cutout (${toolMismatch.map(([a, b]) => `${a}↔${b}`).join(", ")})`);
      }
      const skipDesc = skipParts.length ? ` Skipped: ${skipParts.join("; ")}.` : "";
      if (totalFilled > 0) {
        toast.success(
          `Interpolated ${totalFilled} slice${totalFilled === 1 ? "" : "s"} across ${entries.length} drawn slices`,
          { description: (skipDesc ? `Undo to revert.${skipDesc}` : "Undo to revert") }
        );
      } else if (skipParts.length) {
        toast.error("No slices interpolated", { description: `All gaps were rejected.${skipDesc}` });
      } else {
        toast.info("Drawn slices are all adjacent — nothing to fill between them");
      }
      return true;
    },
    // Radius in voxels (1..30) — converted to mm internally (see
    // brushRadiusMM) for the true-3D Brush (paint) sphere stamps and 2D circle
    // stamps. No longer affects Pen.
    // Item 5: extended max from 10 → 30.
    setBrushRadius: (r) => {
      brushRadiusRef.current = Math.max(1, Math.min(30, Math.round(Number(r)) || 1));
    },
    // Which left-click tool is selected: "pen" | "brush".
    // Eraser and Cutout are removed as separate tools — right-click now erases
    // using the appropriate mode (pen-cutout for pen, sphere/circle for brush).
    setToolMode: (mode) => {
      toolModeRef.current = mode === "brush" ? "brush" : "pen";
    },
    // Brush painting/erase mode: "3D" (true-3D sphere stamp) | "2D" (flat disc
    // stamp on the current slice). Written by DrawingPanel's 2D/3D toggle.
    setBrushMode: (mode) => {
      if (brushModeRef) brushModeRef.current = mode === "2D" ? "2D" : "3D";
    },
    // True when there's no editable drawing yet, or every voxel in it is zero
    // (getDrawingBytes() returns a non-empty NIfTI even for an all-zero
    // bitmap, so callers must check this instead of a byte-length guard —
    // item 60).
    isDrawingEmpty: () => {
      const nv = nvRef.current;
      if (!nv?.drawBitmap) return true;
      return !nv.drawBitmap.some((v) => v !== 0);
    },

    setPenValue: (value, filled = false) => nvRef.current?.setPenValue(value, filled),
    setPenType: () => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.penType = PEN_TYPE.PEN;
    },
    setDrawOpacity: (opacity) => {
      const nv = nvRef.current;
      if (!nv) return;
      nv.drawOpacity = opacity;
      nv.drawScene();
    },
    // Undo/redo run off our own snapshot stacks (drawHistory), not niivue's ring.
    drawUndo: () => {
      const nv = nvRef.current;
      if (!nv?.drawBitmap) return;
      const snap = drawHistory.current.undo(rleEncode(nv.drawBitmap));
      if (!snap) return; // nothing to undo
      nv.drawBitmap.set(rleDecode(snap));
      try { nv.refreshDrawing(true); } catch (_e) {}
      emitHistory();
    },
    drawRedo: () => {
      const nv = nvRef.current;
      if (!nv?.drawBitmap) return;
      const snap = drawHistory.current.redo(rleEncode(nv.drawBitmap));
      if (!snap) return; // nothing to redo
      nv.drawBitmap.set(rleDecode(snap));
      try { nv.refreshDrawing(true); } catch (_e) {}
      emitHistory();
    },
    // Subscribe to paint-mode changes (fires for EVERY path that flips it, so the
    // Draw panel's button can never disagree with the canvas — see item 51).
    setDrawingActiveCallback: (cb) => {
      drawingActiveCb.current = cb;
      cb?.(nvRef.current?.opts?.drawingEnabled ?? false); // push current state on subscribe
    },
    setHistoryCallback: (cb) => {
      historyCb.current = cb;
      emitHistory(); // push initial state so buttons render correctly
    },
    // Load an uploaded lesion/ROI NIfTI as the EDITABLE drawing bitmap (rather
    // than a read-only overlay volume), so it can be erased/extended with the
    // pen/eraser and saved back out. Uses niivue's own loadDrawing, which
    // requires the file's voxel grid to exactly match the base volume's (no
    // resampling) — mismatches are rejected with a clear toast rather than
    // silently misaligning. Undoable: the pre-load bitmap (or an all-zero
    // baseline, for a first-time load) is pushed to our own RLE undo history
    // (niivue's native drawUndoBitmaps ring is a separate, shallower stack the
    // app's Undo/Redo buttons don't read — see drawHistory.js header comment).
    loadDrawingFromVolume: async (file) => {
      const nv = nvRef.current;
      if (!nv || !nv.volumes[0]) return false;
      try {
        const dims = nv.back?.dims;
        const totalVox = dims ? dims[1] * dims[2] * dims[3] : 0;
        const preSnapshot = nv.drawBitmap
          ? rleEncode(nv.drawBitmap)
          : { len: totalVox, runs: totalVox ? [0, totalVox] : [] };

        const volume = await NVImage.loadFromFile({ file, name: file.name });
        const ok = nv.loadDrawing(volume);
        if (!ok) {
          toast.error("Lesion doesn't match the base scan's grid", {
            description: "Dimensions must match the base volume exactly to edit it as a drawing.",
          });
          return false;
        }
        drawHistory.current.push(preSnapshot);
        lastDraws.current = [];
        emitHistory();
        nv.setDrawingEnabled(true);
        setDrawingActive(true);
        nv.drawScene();
        toast.success("Lesion loaded into draw mode", { description: file.name });
        return true;
      } catch (err) {
        toast.error(`Failed to load ${file.name} as drawing`, { description: err?.message });
        return false;
      }
    },

    drawClear: () => {
      const nv = nvRef.current;
      if (!nv) return;
      try {
        if (!nv.drawBitmap) return;
        snapshotForUndo(); // clear is undoable
        nv.drawBitmap.fill(0);
        nv.refreshDrawing(true);
        emitHistory();
      } catch (_e) {}
    },
    saveDrawing: async (filename = "drawn_lesion.nii.gz") => {
      const nv = nvRef.current;
      if (!nv) return false;
      try {
        await nv.saveImage({ filename, isSaveDrawing: true });
        return true;
      } catch (err) {
        toast.error("Failed to save drawing", { description: err?.message });
        return false;
      }
    },
    // Return the gzipped NIfTI bytes of the current drawing without triggering a
    // download; used to upload the lesion to the server. NiiVue's saveImage only
    // gzips when the filename argument ends in ".gz" — passing filename: "" (to
    // avoid a download) also skips compression, silently returning RAW bytes.
    // Compress explicitly so callers always get real gzip regardless of the
    // eventual filename (backend NIfTI readers trust the .nii.gz extension).
    getDrawingBytes: async () => {
      const nv = nvRef.current;
      if (!nv) return null;
      try {
        const bytes = await nv.saveImage({ filename: "", isSaveDrawing: true });
        if (!(bytes instanceof Uint8Array)) return null;
        const compressed = await NVUtilities.compress(bytes, "gzip");
        return new Uint8Array(compressed);
      } catch (err) {
        toast.error("Failed to read drawing", { description: err?.message });
        return null;
      }
    },

    // Expose the in-memory scratch drawing as a lightweight volume-like object
    // ({ img, dimsRAS, matRAS }) compatible with lib/measure + lib/volumeAnalysis
    // helpers — lets measurements run on an unsaved drawing.
    getDrawingAsVolume: () => {
      const nv = nvRef.current;
      if (!nv?.drawBitmap || !nv.back) return null;
      return {
        img: nv.drawBitmap,
        dimsRAS: nv.back.dimsRAS,
        dims: nv.back.dims,
        matRAS: nv.back.matRAS,
      };
    },

    // Non-destructive morphological ops on the in-memory scratch drawing
    // (nv.drawBitmap). op ∈ "dilate" | "erode" | "smooth". Each op registers an
    // undo bitmap first, so drawUndo() reverts it. Labels are preserved: dilate
    // grows into background using the max neighbouring label; erode removes any
    // foreground voxel touching background; smooth is a 3×3×3 majority filter.
    drawMorph: (op = "dilate") => {
      const nv = nvRef.current;
      if (!nv || !nv.drawBitmap) {
        toast.error("Nothing drawn yet");
        return false;
      }
      const dims = nv.back?.dims;
      const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
      if (!nx || !ny || !nz || !resyncDrawingGridIfStale(nv, nx, ny, nz)) {
        toast.error("Drawing grid unavailable");
        return false;
      }
      // Read AFTER the resync check above — a resync reallocates a fresh
      // drawBitmap object, so capturing this before would leave `src`
      // pointing at the stale (now-detached) array.
      const src = nv.drawBitmap;
      const idx = (i, j, k) => i + nx * (j + ny * k);

      // Foreground bounding box. Morphology only affects voxels within one step
      // of the drawn mask, so we scan that sub-volume instead of all nx·ny·nz
      // voxels — a hand-drawn lesion leaves ~99% of an 11M-voxel grid empty, and
      // scanning it all was the heaviest measured op in the app (~6.5 s).
      let minI = nx, minJ = ny, minK = nz, maxI = -1, maxJ = -1, maxK = -1;
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++) {
          const base = nx * (j + ny * k);
          for (let i = 0; i < nx; i++) {
            if (src[base + i]) {
              if (i < minI) minI = i; if (i > maxI) maxI = i;
              if (j < minJ) minJ = j; if (j > maxJ) maxJ = j;
              if (k < minK) minK = k; if (k > maxK) maxK = k;
            }
          }
        }
      if (maxI < 0) { toast.error("Nothing drawn yet"); return false; }

      // dilate/smooth can grow into the 1-voxel shell around the mask; erode only
      // ever removes existing foreground, so its own bbox suffices (pad 0).
      const pad = op === "erode" ? 0 : 1;
      const i0 = Math.max(0, minI - pad), i1 = Math.min(nx - 1, maxI + pad);
      const j0 = Math.max(0, minJ - pad), j1 = Math.min(ny - 1, maxJ + pad);
      const k0 = Math.max(0, minK - pad), k1 = Math.min(nz - 1, maxK + pad);

      const out = new Uint8Array(src.length);
      const nb6 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

      snapshotForUndo(); emitHistory(); // morphology op is undoable

      if (op === "dilate") {
        out.set(src);
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
              const p = idx(i, j, k);
              if (src[p]) continue; // keep existing foreground
              let best = 0;
              for (const [di, dj, dk] of nb6) {
                const ii = i + di, jj = j + dj, kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                const v = src[idx(ii, jj, kk)];
                if (v > best) best = v;
              }
              out[p] = best;
            }
      } else if (op === "erode") {
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
              const p = idx(i, j, k);
              if (!src[p]) continue;
              let keep = true;
              for (const [di, dj, dk] of nb6) {
                const ii = i + di, jj = j + dj, kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz || !src[idx(ii, jj, kk)]) {
                  keep = false;
                  break;
                }
              }
              out[p] = keep ? src[p] : 0;
            }
      } else { // smooth: 3×3×3 majority vote (fills holes, removes speckle)
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i <= i1; i++) {
              let count = 0, best = 0;
              const votes = {};
              for (let dk = -1; dk <= 1; dk++)
                for (let dj = -1; dj <= 1; dj++)
                  for (let di = -1; di <= 1; di++) {
                    const ii = i + di, jj = j + dj, kk = k + dk;
                    if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                    const v = src[idx(ii, jj, kk)];
                    if (v) {
                      count++;
                      votes[v] = (votes[v] || 0) + 1;
                      if (votes[v] > (votes[best] || 0)) best = v;
                    }
                  }
              out[idx(i, j, k)] = count >= 14 ? best : 0;
            }
      }

      src.set(out);
      try { nv.refreshDrawing(true); } catch (_e) { /* redraw is best-effort */ }
      return true;
    },

    // Rasterize a solid sphere into the scratch drawing (nv.drawBitmap) on the
    // BASE scan's own voxel grid. centerMM = world mm, radiusMM = mm, labelValue
    // = pen label (1..6). Uses the base affine (mm2frac → frac2vox), so it lands
    // at the given mm regardless of MNI registration and shares the one drawing
    // + undo history with freehand strokes (item 39: ROIs go into the drawing).
    // The radius test is in mm using the base pixel spacing, so it stays round
    // on anisotropic voxels (assumes an axis-aligned base, as the rest of the
    // drawing pipeline does). Undoable.
    drawSphere: (centerMM, radiusMM, labelValue = 1) => {
      const nv = nvRef.current;
      if (!nv || !nv.drawBitmap || !nv.back) { toast.error("Enable drawing first"); return false; }
      const dims = nv.back.dims;
      const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
      if (!nx || !ny || !nz || !resyncDrawingGridIfStale(nv, nx, ny, nz)) {
        toast.error("Drawing grid unavailable"); return false;
      }
      const r = Number(radiusMM);
      if (!Number.isFinite(r) || r <= 0) { toast.error("Radius must be a positive number (mm)."); return false; }
      let cvox = null;
      try { cvox = nv.frac2vox(nv.mm2frac(centerMM)); } catch (_e) { cvox = null; }
      if (!cvox || cvox.length < 3 || cvox.some((v) => !Number.isFinite(v))) {
        toast.error("Center is outside the volume."); return false;
      }
      // ROI spheres always paint, never erase (labelValue is clamped >= 1),
      // unlike the shared rasterizeSphere() primitive itself, which also
      // backs the true-3D Brush tool and right-drag erase (labelValue 0)
      // — see stampSphereAlongPath.
      const lab = Math.max(1, Math.min(255, Math.round(labelValue) || 1));
      snapshotForUndo(); // sphere is undoable, mirrors a freehand stroke
      const painted = rasterizeSphere(centerMM, r, lab);
      if (!painted) { toast.error("Sphere fell outside the volume."); return false; }
      try { nv.refreshDrawing(true); } catch (_e) { /* redraw is best-effort */ }
      emitHistory();
      return true;
    },
  };
}
