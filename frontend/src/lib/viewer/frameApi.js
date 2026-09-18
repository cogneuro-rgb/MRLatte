/**
 * 4D frame-stepping for the base volume (BOLD/DWI timeseries).
 *
 * Backs the getFrameInfo / setFrame / stepFrame entries of NiivueViewer's
 * imperative handle.
 *
 * @param {object} ctx   viewer context (see lib/viewer/context.js); uses nvRef.
 * @param {object} deps
 * @param {(withVolumeUpdate?: boolean) => void} deps.scheduleRedraw
 */
export function createFrameApi(ctx, { scheduleRedraw }) {
  const { nvRef } = ctx;
  const baseVol = () => nvRef.current?.volumes?.[0] || null;

  const setFrame = (i) => {
    const nv = nvRef.current;
    const v = baseVol();
    if (!nv || !v || !(v.nFrame4D > 1)) return 0;
    nv.setFrame4D(v.id, i);
    scheduleRedraw(false);
    // Return the ACTUAL frame after niivue's own clamp: setFrame4D does not
    // fire onFrameChange when the clamped value equals the current one, so a
    // slider dragged past the end needs this return value (not just the
    // change callback) to stay in sync.
    return v.frame4D | 0;
  };

  return {
    getFrameInfo: () => {
      const v = baseVol();
      return { frame: v ? v.frame4D | 0 : 0, nFrames: v ? Math.max(1, v.nFrame4D | 0) : 1 };
    },
    setFrame,
    // Deliberately NOT recomputing the display window (calMinMax) per frame:
    // niivue already computes it once from the current frame at load and
    // leaves it alone on setFrame4D. Keep it that way — a stable window
    // across frames beats a BOLD series flickering in brightness as the
    // window re-fits each volume.
    stepFrame: (dir) => setFrame((baseVol()?.frame4D | 0) + dir),
    // Intensity at one voxel across every frame — the timeseries graph's
    // data source. The whole 4D volume is already decoded in memory (niivue
    // loads all frames up front), so this is just O(nFrames) array reads,
    // cheap enough to recompute on every crosshair move.
    getTimeseriesAtVoxel: (vx, vy, vz) => {
      const v = baseVol();
      if (!v || !(v.nFrame4D > 1)) return null;
      if (![vx, vy, vz].every(Number.isFinite)) return null;
      try {
        const n = v.nFrame4D;
        const values = new Array(n);
        for (let f = 0; f < n; f++) values[f] = v.getValue(vx, vy, vz, f);
        return values;
      } catch (_e) {
        return null;
      }
    },
  };
}
