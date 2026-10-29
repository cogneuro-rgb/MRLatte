// Options for a toast that offers Undo: it lasts UNDO_TOAST_MS and shows how
// long is left, as a bar along its bottom edge that drains over that time
// (inbox 29 Oct; the `.undo-toast` rules in index.css). Spread it into the
// toast's options next to its `action`.
export const UNDO_TOAST_MS = 5000;

export const undoToastOptions = (duration = UNDO_TOAST_MS) => ({
  duration,
  className: "undo-toast",
  style: { "--undo-ms": `${duration}ms` },
});
