// App-level undo stack (Dashboard): the state from just before a destructive
// action (clear all, remove a layer), newest first. Pure — the snapshots are
// opaque here and the caller keeps the stack.
export const UNDO_LIMIT = 10;

// New stack with `entry` on top; the oldest entries fall off past `limit`.
export function pushUndo(stack, entry, limit = UNDO_LIMIT) {
  return [entry, ...stack].slice(0, limit);
}

// Takes `entry` (default: the newest) off the stack. Everything newer than it
// goes too: restoring an older snapshot already undoes those actions. Returns
// { entry, rest }, or null when the entry is not on the stack (already used,
// or pushed off the end).
export function takeUndo(stack, entry) {
  const i = entry === undefined ? (stack.length ? 0 : -1) : stack.indexOf(entry);
  if (i < 0) return null;
  return { entry: stack[i], rest: stack.slice(i + 1) };
}
