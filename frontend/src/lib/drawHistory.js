// Undo/redo history for the NiiVue draw bitmap.
//
// niivue's built-in undo is a fixed 8-slot RLE ring with no public redo and
// forward slots that get silently clobbered — too shallow/fragile to build a
// real redo on. This module keeps an independent, deeper snapshot history.
//
// Snapshots are run-length encoded: a hand-drawn lesion leaves ~99% of an
// 11M-voxel bitmap as background zeros, so RLE turns each ~11 MB Uint8Array into
// a handful of runs — cheap enough to keep dozens of them.

/**
 * Run-length encode a draw bitmap.
 * @param {Uint8Array} arr
 * @returns {{ len: number, runs: number[] }} runs are [value, count, value, count, …]
 */
export function rleEncode(arr) {
  const runs = [];
  const n = arr.length;
  // Background runs are most of the bitmap: step over them 4 bytes at a time.
  const w = words(arr);
  let i = 0;
  while (i < n) {
    const v = arr[i];
    let j = i + 1;
    if (v === 0 && w) {
      while (j < n && (j & 3) && arr[j] === 0) j++;
      if (j < n && !(j & 3)) {
        let q = j >> 2;
        while (q < w.length && w[q] === 0) q++;
        j = q << 2;
      }
      while (j < n && arr[j] === 0) j++;
    } else {
      while (j < n && arr[j] === v) j++;
    }
    runs.push(v, j - i);
    i = j;
  }
  return { len: n, runs };
}

// A Uint32 view over a byte array (4 voxels per read), or null when the bytes
// don't start on a 4-byte boundary (a subarray at an odd offset).
function words(u8) {
  return u8.byteOffset % 4 === 0 ? new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2) : null;
}

/** True if any byte is non-zero. ~30x faster than `.some(v => v !== 0)` on an
 *  11M-voxel bitmap, which matters because it runs after every edit. */
export function hasAnyNonZero(u8) {
  if (!u8) return false;
  const w = words(u8);
  let i = 0;
  if (w) {
    for (let q = 0; q < w.length; q++) if (w[q] !== 0) return true;
    i = w.length << 2;
  }
  for (; i < u8.length; i++) if (u8[i] !== 0) return true;
  return false;
}

/** Byte-for-byte equality of two arrays, 4 bytes at a time where possible. */
export function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const wa = words(a), wb = words(b);
  let i = 0;
  if (wa && wb) {
    for (let q = 0; q < wa.length; q++) if (wa[q] !== wb[q]) return false;
    i = wa.length << 2;
  }
  for (; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Reconstruct a draw bitmap from an rleEncode() snapshot.
 * @param {{ len: number, runs: number[] }} snap
 * @returns {Uint8Array}
 */
export function rleDecode(snap) {
  const out = new Uint8Array(snap.len);
  const runs = snap.runs;
  let p = 0;
  for (let r = 0; r < runs.length; r += 2) {
    const v = runs[r];
    const c = runs[r + 1];
    if (v !== 0) out.fill(v, p, p + c); // background is already 0
    p += c;
  }
  return out;
}

/**
 * Undo/redo stacks of RLE draw-bitmap snapshots. The caller owns the live
 * bitmap; this class only stores pre-op snapshots and hands them back.
 */
export class DrawHistory {
  constructor(cap = 30) {
    this.cap = cap;
    this.undoStack = [];
    this.redoStack = [];
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Record a pre-op snapshot; starting a new edit invalidates the redo branch. */
  push(encoded) {
    this.undoStack.push(encoded);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Save the current state to redo and return the snapshot to restore, or null. */
  undo(currentEncoded) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(currentEncoded);
    if (this.redoStack.length > this.cap) this.redoStack.shift();
    return this.undoStack.pop();
  }

  /** Save the current state to undo and return the snapshot to restore, or null. */
  redo(currentEncoded) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(currentEncoded);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    return this.redoStack.pop();
  }
}
