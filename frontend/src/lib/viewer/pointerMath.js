/**
 * Pure hit-testing / rasterization math shared by the Brush true-3D sphere,
 * 2D-circle pointer pipelines, and right-drag erase (items 66/69/70).
 *
 * Returns bound closures (not a class) so call sites in NiivueViewer keep the
 * exact same local names they had when these were component-scope functions
 * — only where they're DEFINED moved, not how they're called. The actual
 * pointer-event listener wiring (registration order, capture-phase native-
 * mouse blocking, StrictMode-sensitive cleanup) is NOT touched by this
 * extraction and stays inline in NiivueViewer's main effect.
 *
 * @param {object} ctx  viewer context; uses nvRef, toolModeRef, brushRadiusRef,
 *                      brushModeRef.
 */
export function createPointerMath(ctx) {
  const { nvRef, toolModeRef, brushRadiusRef, brushModeRef } = ctx;

  // True while the Brush tool is active (regardless of 2D/3D mode).
  // The brush tool uses our own custom pointer pipeline in both modes, so
  // niivue's native pen pipeline must be blocked whenever this returns true.
  // Previously called isTrue3DTool — kept as an alias for any call sites not
  // yet updated.
  const isCustomStampTool = () => toolModeRef.current === "brush";
  const isTrue3DTool = isCustomStampTool; // back-compat alias

  // Canvas-pixel point → world mm coordinates, via niivue's own
  // canvasPos2frac/frac2mm (handles whichever 2D tile the point is over,
  // regardless of orientation — the true-3D Brush/erase sphere stamps don't
  // care which tile was clicked, only where in space it is). Returns null if
  // the point isn't over a valid tile.
  function mmAtCanvasXY(x, y) {
    const nv = nvRef.current;
    if (!nv) return null;
    try {
      const frac = nv.canvasPos2frac([x, y]);
      if (!frac || frac[0] < 0) return null;
      const mm = nv.frac2mm(frac);
      if (!mm || mm.length < 3 || mm.some((v) => !Number.isFinite(v))) return null;
      return [mm[0], mm[1], mm[2]];
    } catch (_e) {
      return null;
    }
  }

  // Hit-test a canvas point against niivue's own 2D slice tiles
  // (nv.screenSlices) to find which orientation (axCorSag 0/1/2) it falls
  // over and the voxel it corresponds to — mirrors niivue's own native pen
  // hit-test loop (its internal mouseClick) so right-drag erase (item 70) can
  // lock to a single plane across the whole stroke exactly like native
  // Pen/Cutout do. `lockedAxCorSag`, if 0-2, restricts the search to that
  // orientation only (mid-stroke, so a drag that strays over another tile
  // doesn't jump planes). Render/other non-2D tiles are never matched.
  function hitTestPenTarget(x, y, lockedAxCorSag = -1) {
    const nv = nvRef.current;
    if (!nv?.screenSlices?.length) return null;
    for (let i = 0; i < nv.screenSlices.length; i++) {
      const axCorSag = nv.screenSlices[i].axCorSag;
      if (axCorSag == null || axCorSag > 2) continue; // 2D slice tiles only
      if (lockedAxCorSag >= 0 && lockedAxCorSag !== axCorSag) continue;
      let texFrac;
      try { texFrac = nv.screenXY2TextureFrac(x, y, i, true); } catch (_e) { continue; }
      if (!texFrac || texFrac[0] < 0) continue;
      let vox;
      try { vox = nv.frac2vox(texFrac); } catch (_e) { continue; }
      if (!vox || vox.length < 3 || vox.some((v) => !Number.isFinite(v))) continue;
      return { axCorSag, vox: [Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])] };
    }
    return null;
  }

  // Pure raster op: stamp a solid sphere (radiusMM, world mm center) into the
  // drawing bitmap on the BASE scan's own voxel grid. No undo snapshot, no
  // toast, no redraw — callers own all of that. labelValue 0 = erase. Shared
  // by the public drawSphere() API (coordinate-entry ROI sub-tool, one call =
  // one undo entry) and the true-3D Brush / right-drag-erase pointer handlers
  // (many stamps per stroke, one undo entry per whole stroke — items
  // 66/69 redesign). Returns the number of voxels painted.
  function rasterizeSphere(centerMM, radiusMM, labelValue) {
    const nv = nvRef.current;
    if (!nv?.drawBitmap || !nv.back) return 0;
    const dims = nv.back.dims;
    const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
    if (!nx || !ny || !nz || nv.drawBitmap.length !== nx * ny * nz) return 0;
    const r = Number(radiusMM);
    if (!Number.isFinite(r) || r <= 0) return 0;
    const px = Math.abs(nv.back.pixDims?.[1] || 1);
    const py = Math.abs(nv.back.pixDims?.[2] || 1);
    const pz = Math.abs(nv.back.pixDims?.[3] || 1);
    let cvox = null;
    try { cvox = nv.frac2vox(nv.mm2frac(centerMM)); } catch (_e) { cvox = null; }
    if (!cvox || cvox.length < 3 || cvox.some((v) => !Number.isFinite(v))) return 0;
    const ci = Math.round(cvox[0]), cj = Math.round(cvox[1]), ck = Math.round(cvox[2]);
    const ri = Math.ceil(r / px), rj = Math.ceil(r / py), rk = Math.ceil(r / pz);
    const i0 = Math.max(0, ci - ri), i1 = Math.min(nx - 1, ci + ri);
    const j0 = Math.max(0, cj - rj), j1 = Math.min(ny - 1, cj + rj);
    const k0 = Math.max(0, ck - rk), k1 = Math.min(nz - 1, ck + rk);
    const r2 = r * r;
    const lab = Math.max(0, Math.min(255, Math.round(labelValue) || 0));
    const buf = nv.drawBitmap;
    let painted = 0;
    for (let k = k0; k <= k1; k++) {
      const dz = (k - ck) * pz;
      for (let j = j0; j <= j1; j++) {
        const dy = (j - cj) * py;
        const rowBase = nx * (j + ny * k);
        for (let i = i0; i <= i1; i++) {
          const dx = (i - ci) * px;
          if (dx * dx + dy * dy + dz * dz <= r2) { buf[rowBase + i] = lab; painted++; }
        }
      }
    }
    return painted;
  }

  // Pure raster op: stamp a flat 2D disc (radiusVox voxels, integer center
  // vox [cx,cy,cz]) onto a single slice of the drawing bitmap, in the plane
  // given by axCorSag (0=axial xy-plane, 1=coronal xz-plane, 2=sagittal yz-plane).
  // labelValue 0 = erase. Returns number of voxels painted.
  function rasterize2DCircle(centerVox, radiusVox, axCorSag, labelValue) {
    const nv = nvRef.current;
    if (!nv?.drawBitmap || !nv.back) return 0;
    const dims = nv.back.dims;
    const nx = dims?.[1], ny = dims?.[2], nz = dims?.[3];
    if (!nx || !ny || !nz || nv.drawBitmap.length !== nx * ny * nz) return 0;
    const r = Math.max(0, Number(radiusVox));
    if (!Number.isFinite(r)) return 0;
    const [cx, cy, cz] = centerVox.map(Math.round);
    const lab = Math.max(0, Math.min(255, Math.round(labelValue) || 0));
    const buf = nv.drawBitmap;
    const r2 = r * r;
    let painted = 0;
    const iR = Math.ceil(r);
    // du/dv iterate over the two in-plane axes; the third (depth) axis is fixed.
    // axCorSag 0 = axial    → u=x(i), v=y(j), slice z=cz
    // axCorSag 1 = coronal  → u=x(i), v=z(k), slice y=cy
    // axCorSag 2 = sagittal → u=y(j), v=z(k), slice x=cx
    for (let du = -iR; du <= iR; du++) {
      for (let dv = -iR; dv <= iR; dv++) {
        if (du * du + dv * dv > r2) continue;
        let vi, vj, vk;
        if (axCorSag === 0)      { vi = cx + du; vj = cy + dv; vk = cz; }
        else if (axCorSag === 1) { vi = cx + du; vj = cy;       vk = cz + dv; }
        else                     { vi = cx;       vj = cy + du; vk = cz + dv; }
        if (vi < 0 || vi >= nx || vj < 0 || vj >= ny || vk < 0 || vk >= nz) continue;
        buf[vi + nx * (vj + ny * vk)] = lab;
        painted++;
      }
    }
    return painted;
  }

  // Radius (mm) driven by the brush-radius slider (voxel units in the UI),
  // converted using the base volume's mean voxel spacing so it behaves
  // sensibly on anisotropic grids. Shared by Brush-paint and right-drag-erase
  // (both are "true 3D sphere" stamps now, items 66/69).
  function brushRadiusMM() {
    const nv = nvRef.current;
    const px = Math.abs(nv?.back?.pixDims?.[1] || 1);
    const py = Math.abs(nv?.back?.pixDims?.[2] || 1);
    const pz = Math.abs(nv?.back?.pixDims?.[3] || 1);
    return Math.max(0.5, brushRadiusRef.current * ((px + py + pz) / 3));
  }

  // Shared "true 3D" stamp-and-interpolate engine for the Brush tool (item 66
  // redesign) and right-drag erase (item 69 redesign): stamps a sphere at mm,
  // and — if a previous point exists on `strokeState` — linearly interpolates
  // sub-stamps between the two points (spacing ~= radius/2) so fast drags
  // sweep a continuous tube with no gaps. This is PURE swept-path painting: it
  // never fills the interior of a loop (unlike niivue's native isFilledPen)
  // because it only ever touches points actually visited along the path.
  // `strokeState` is a plain { lastMM } object owned by the caller, one per
  // in-progress stroke. Returns true if any voxel was painted.
  function stampSphereAlongPath(strokeState, mm, radiusMM, labelValue) {
    let painted = false;
    const prev = strokeState.lastMM;
    if (prev) {
      const dx = mm[0] - prev[0], dy = mm[1] - prev[1], dz = mm[2] - prev[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const step = Math.max(radiusMM * 0.5, 0.1);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        const p = [prev[0] + dx * t, prev[1] + dy * t, prev[2] + dz * t];
        if (rasterizeSphere(p, radiusMM, labelValue) > 0) painted = true;
      }
    } else if (rasterizeSphere(mm, radiusMM, labelValue) > 0) {
      painted = true;
    }
    strokeState.lastMM = mm;
    return painted;
  }

  // 2D-circle analogue of stampSphereAlongPath: interpolates flat disc stamps
  // between strokeState.lastVox and vox with spacing ~= radius/2 voxels so
  // fast drags leave no gaps. axCorSag locks the plane for the full stroke.
  // strokeState is { lastVox } owned by the caller. Returns true if any voxel
  // was painted.
  function stamp2DCircleAlongPath(strokeState, vox, radiusVox, axCorSag, labelValue) {
    let painted = false;
    const prev = strokeState.lastVox;
    if (prev) {
      const dx = vox[0] - prev[0], dy = vox[1] - prev[1], dz = vox[2] - prev[2];
      const distVox = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const step = Math.max(radiusVox * 0.5, 0.5);
      const n = Math.max(1, Math.ceil(distVox / step));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        const p = [
          Math.round(prev[0] + dx * t),
          Math.round(prev[1] + dy * t),
          Math.round(prev[2] + dz * t),
        ];
        if (rasterize2DCircle(p, radiusVox, axCorSag, labelValue) > 0) painted = true;
      }
    } else if (rasterize2DCircle(vox, radiusVox, axCorSag, labelValue) > 0) {
      painted = true;
    }
    strokeState.lastVox = vox;
    return painted;
  }

  return {
    isCustomStampTool,
    isTrue3DTool, // back-compat alias
    mmAtCanvasXY,
    hitTestPenTarget,
    rasterizeSphere,
    rasterize2DCircle,
    brushRadiusMM,
    stampSphereAlongPath,
    stamp2DCircleAlongPath,
  };
}
