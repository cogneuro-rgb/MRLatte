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
  let i = 0;
  while (i < n) {
    const v = arr[i];
    let j = i + 1;
    while (j < n && arr[j] === v) j++;
    runs.push(v, j - i);
    i = j;
  }
  return { len: n, runs };
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
